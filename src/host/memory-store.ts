/**
 * 本地记忆系统（v2.0，SQLite + FTS5，Bot 基础设施 · 副开发 CodeBuddy 负责）
 *
 * 升级自动因（侦查报告硬约束③）：v1 扁平 JSON 全量重写，撑不起 Bot 的
 * 「治理级记忆」。v2 落点：
 * - 存储：SQLite（node:sqlite，Node 24 内置）+ FTS5 全文检索（trigram 分词，
 *   中文子串可命中 —— 沿用 memory-agent 同款结论：unicode61 会把连续汉字
 *   当成单个 token 导致中文专名不命中）；
 * - 新字段：source（来源）/ confidence（可信度 0-1）/ personaTags（人设维度）/
 *   contentHash（去重）/ invalidAt（失效标记，失效而非删除）；
 * - 接口：search(query) 混合检索（FTS bm25 → LIKE 兜底 → 标签精确加权）、
 *   invalidate(id) 失效、listByPersona(tag) 人设路由；
 * - 兼容：save/remove/getMemoryStore 签名不变；formatForPrompt 输出格式与
 *   v1 一致（- #id [type] name: content）；旧 memories.json 首次启动自动导入。
 *
 * 降级路径：node:sqlite 不可用（Node < 22.5）或库文件打不开时，自动退化为
 * 内存存储（检索退化为子串扫描），保证宿主不崩；控制台会打 warn。
 *
 * 接口契约：src/host/bot/types.ts 的 MemoryStoreV2（Claude 定义，签名锁定）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { Memory, MemoryStoreV2 } from './bot/types';
import * as core from './memory/core';
import * as storage from './memory/storage';
import * as retrieval from './memory/retrieval';
import * as audit from './memory/audit';
import * as candidates from './memory/candidates';
import type {
  ExistingGovernanceFields,
  MemoryCandidate,
  MemoryLogEntry,
  MemoryRow,
  SaveMemoryParams,
  SaveMemoryResult,
  StoreContext,
} from './memory/types';

// 导出面保持 9 值 + 8 类型（门面按具名 re-export 转出）。
export type {
  ExistingGovernanceFields,
  MemoryCandidate,
  MemoryLogEntry,
  MemoryRow,
  MemorySaveWarning,
  MemoryType,
  SaveMemoryParams,
  SaveMemoryResult,
} from './memory/types';
export { MAX_MEMORIES } from './memory/types';
import { MEMORY_INJECT_LIMIT } from '../inject/untrusted-memory';
import type { AuditCrypto } from './audit-crypto';

/**
 * M10-9：记忆候选池条目。
 *
 * 候选池是「想记住但还没确认要不要记住」的中间态：候选**不进正式注入**
 * （不进 list() / search() / formatForPrompt），只有被 promote 成正式记忆后才可见。
 */
/**
 * M10-10：审计日志条目（回答「何时由谁改过」）。
 *
 * before / after 存的是变更前后的完整行快照（JSON），rollback 直接按快照回写。
 */
/** M10-11：默认 workspace id（不隔离，沿用历史单库）。 */
export const DEFAULT_WORKSPACE_ID = 'default';

/**
 * M10-11：把 workspace 标识映射成一个安全的文件名后缀。
 * 非法字符全部替换为 '_'，再拼 8 位 hash 尾巴，避免不同 id 清洗后撞名。
 */
export function workspaceSlug(workspaceId: string): string {
  const clean = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 32) || 'ws';
  const hash = crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 8);
  return `${clean}-${hash}`;
}

/**
 * M10-11：按 workspace 派生独立库文件路径。
 * 默认 workspace 返回原路径（历史库零迁移）；其余 workspace 落 `memories.ws-<slug>.db`。
 */
export function workspaceStorePath(basePath: string, workspaceId: string): string {
  if (!workspaceId || workspaceId === DEFAULT_WORKSPACE_ID) return basePath;
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  return path.join(dir, `${stem}.ws-${workspaceSlug(workspaceId)}${ext}`);
}

/** workspace 索引文件名（slug → 原始 id 映射，slug 带 hash 无法反推）。 */
function workspaceIndexPath(basePath: string): string {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  return path.join(dir, `${stem}.workspaces.json`);
}

/** 把 workspace id 登记进索引文件（幂等）。失败不阻塞建库。 */
function registerWorkspace(basePath: string, workspaceId: string): void {
  try {
    const idxPath = workspaceIndexPath(basePath);
    let map: Record<string, string> = {};
    if (fs.existsSync(idxPath)) {
      const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      if (parsed && typeof parsed === 'object') map = parsed as Record<string, string>;
    }
    map[workspaceSlug(workspaceId)] = workspaceId;
    fs.writeFileSync(idxPath, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    console.warn(
      '[memory] workspace index update failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * M10-11：列出已登记的 workspace id（含 default）。
 * 隔离靠「每 workspace 一个独立 .db 文件」实现，默认 workspace 仍用历史单库。
 */
export function listWorkspaceIds(basePath?: string): string[] {
  const base = basePath ?? defaultStorePath();
  const ids = new Set<string>([DEFAULT_WORKSPACE_ID]);
  try {
    const idxPath = workspaceIndexPath(base);
    if (fs.existsSync(idxPath)) {
      const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const v of Object.values(parsed as Record<string, string>)) {
          if (typeof v === 'string' && v) ids.add(v);
        }
      }
    }
  } catch {
    /* 索引损坏时只返回 default */
  }
  return [...ids];
}

/** v2 记忆行 = 契约 Memory + v1 遗留字段（pinned/时间戳，内部使用）。 */
/** memory.save 的附属操作失败 warning。主记录完整性靠 memories 主表，附属失败不阻断 ok:true。 */
/** 默认记忆存储路径：~/.config/deepseek-studio/memories.db */
function defaultStorePath(): string {
  const configDir = process.env.STUDIO_CONFIG_DIR
    ?? path.join(os.homedir(), '.config', 'deepseek-studio');
  return path.join(configDir, 'memories.db');
}

/** v1 旧存储路径（用于一次性迁移导入）。 */
/** 内容指纹：type + name + 规范化内容（去首尾空白 + 压缩连续空白）。 */
/** M10-7.2：名称无关的去重指纹——type + 规范化内容（压缩空白 + 去首尾 + 小写，跨名大小写/空白归一后命中）。 */
/** M10-7.3：有效记忆容量上限。新写入导致 valid 超过此值时软归档最旧非 pinned。 */
/**
 * M10-7.3：确定性软归档淘汰选择。
 * 排序：① project 非 pinned 最旧优先；② project 不足再 user 非 pinned；
 * ③ pinned 永不淘汰；④ 同级 updatedAt ASC → createdAt ASC → id ASC。
 * 返回应归档的行（最多 need 条）；若候选数 < need 返回 null（调用方须报容量错误并不写入）。
 */
/** 同名更新时，既有行的治理字段投影（SQL row 与 fallback MemoryRow 都能投影成它）。 */
/**
 * M10-7.1：同名 save() 的治理字段合并语义——未传即保留原值，显式传值（含 false/[]）则覆盖。
 * SQL 持久化路径与内存 fallback 路径共用本函数，避免再次分叉。
 */
export function mergeUpdateGovernance(existing: ExistingGovernanceFields, params: SaveMemoryParams) {
  return {
    pinned: params.pinned ?? existing.pinned,
    tags: params.tags ?? existing.tags,
    personaTags: params.personaTags ?? existing.personaTags,
    source: params.source ?? existing.source,
    confidence: params.confidence ?? existing.confidence,
  };
}

/**
 * FTS5 查询串构造：每个空白分词加双引号成短语，OR 连接。
 * 内部双引号翻倍防注入；返回 null 表示无有效分词（走 LIKE 兜底）。
 */
/** LIKE 模式转义（% _ \ 三个字符），配合 ESCAPE '\'。 */
/** DB 行 → MemoryRow。 */
/** M10-10：行快照（用于审计日志的 before/after）。深拷贝，避免后续修改污染快照。 */
/** DB 行 → MemoryCandidate。 */
/** 解析审计日志里的行快照 JSON。 */
/** 把已解析的快照对象规整成 MemoryRow。 */
/** sha256 指纹（forget 模式下唯一留下的痕迹）。 */
/** 由快照算出指纹（不泄漏正文）。 */
/** 解析候选 JSON（审计日志 note 里带）。 */
/**
 * 记忆存储管理器 v2（SQLite + FTS5，实现 MemoryStoreV2 契约）。
 *
 * 用法与 v1 相同：new MemoryStore([storePath]) / getMemoryStore()。
 * save/remove 保持同步（node:sqlite 本身同步）；契约方法为 async。
 */
export class MemoryStore implements MemoryStoreV2 {
  private db: import('node:sqlite').DatabaseSync | null = null;
  private fallback: MemoryRow[] | null = null;
  private fallbackCandidates: MemoryCandidate[] = [];
  private fallbackLog: MemoryLogEntry[] = [];
  private readonly storePath: string;
  private readonly workspaceId: string;
  private audit!: AuditCrypto;
  /** C1 巨石重构：域上下文（内部）。 */
  private readonly ctx: StoreContext;

constructor(storePath?: string, opts?: { workspaceId?: string }) {
    this.workspaceId = opts?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const basePath = storePath ?? defaultStorePath();
    this.storePath = workspaceStorePath(basePath, this.workspaceId);
    if (this.workspaceId !== DEFAULT_WORKSPACE_ID) {
      registerWorkspace(basePath, this.workspaceId);
    }
    // C1 巨石重构：装配域上下文（必须在 this.open() 之前——open 会写 this.db）。
    // 数据字段用 get/set 访问器代理到 self：域模块里既有读（ctx.db）也有写（ctx.db = db），
    // 纯 getter 只能读，open() 的降级分支需要写回 this.db/this.audit/this.fallback。
    const self = this;
    this.ctx = {
      get db() { return self.db; },
      set db(v) { self.db = v; },
      get fallback() { return self.fallback; },
      set fallback(v) { self.fallback = v; },
      get fallbackCandidates() { return self.fallbackCandidates; },
      set fallbackCandidates(v) { self.fallbackCandidates = v; },
      get fallbackLog() { return self.fallbackLog; },
      set fallbackLog(v) { self.fallbackLog = v; },
      get storePath() { return self.storePath; },
      get workspaceId() { return self.workspaceId; },
      get audit() { return self.audit; },
      set audit(v) { self.audit = v; },
      // 注入槽与跨域委托**全部指向门面的委托方法**（门面委托再转给域模块）：
      // 这样 ctx 槽与门面委托是同一条链，门面委托不是死代码，
      // 且门面只需 import **已搬走**的域模块（未搬走的域门面还持有原方法）。
      save: (p: SaveMemoryParams) => self.save(p),
      remove: (id: string, opts?: { forget?: boolean }) => self.remove(id, opts),
      recordLog: (
        op: string,
        memoryId: string | null,
        before: MemoryRow | null,
        after: MemoryRow | null,
        actor?: string | null,
        note?: string | null,
      ) => self.recordLog(op, memoryId, before, after, actor, note),
      // C1 墨鉴 BUG-012/013：事务内用的严格审计槽（失败抛错 → 整笔回滚）。
      recordLogStrict: (
        op: string,
        memoryId: string | null,
        before: MemoryRow | null,
        after: MemoryRow | null,
        actor?: string | null,
        note?: string | null,
      ) => audit.recordLogStrict(self.ctx, op, memoryId, before, after, actor, note),
      forgetAudit: (id: string) => self.forgetAudit(id),
      forgetAuditStrict: (id: string) => audit.forgetAuditStrict(self.ctx, id),
      snapshotById: (id: string) => self.snapshotById(id),
      deleteMemoryRow: (id: string) => self.deleteMemoryRow(id),
      writeSnapshotRow: (row: MemoryRow) => self.writeSnapshotRow(row),
      insertCandidateRow: (c: MemoryCandidate) => self.insertCandidateRow(c),
      validRows: () => self.validRows(),
    };
    this.open();
  }

  // ===== 内部：打开 / 降级 =====

  getWorkspaceId(): string {
    return this.workspaceId;
  }

  // ===== 域方法（一行委托到 src/host/memory/*） =====

  private open(): void { return core.open(this.ctx); }

   getDb(): import('node:sqlite').DatabaseSync | null { return core.getDb(this.ctx); }

   isInMemoryFallback(): boolean { return core.isInMemoryFallback(this.ctx); }

   close(): void { return core.close(this.ctx); }

   addCandidate(input: {
    type: string;
    name: string;
    content: string;
    tags?: string[];
    reason?: string;
    source?: string;
  }): { ok: boolean; id?: string; error?: string } { return candidates.addCandidate(this.ctx, input); }

   async listCandidates(): Promise<MemoryCandidate[]> { return candidates.listCandidates(this.ctx); }

   async getCandidate(id: string): Promise<MemoryCandidate | undefined> { return candidates.getCandidate(this.ctx, id); }

   async promoteCandidate(id: string): Promise<{ ok: boolean; id?: string; error?: string }> { return candidates.promoteCandidate(this.ctx, id); }

   async rejectCandidate(id: string, note?: string): Promise<boolean> { return candidates.rejectCandidate(this.ctx, id, note); }

  private insertCandidateRow(c: MemoryCandidate): void { return candidates.insertCandidateRow(this.ctx, c); }

  private recordLog(op: string, memoryId: string | null, before: MemoryRow | null, after: MemoryRow | null, actor?: string | null, note?: string | null): void { return audit.recordLog(this.ctx, op, memoryId, before, after, actor, note); }

   async listLog(opts?: { limit?: number; memoryId?: string }): Promise<MemoryLogEntry[]> { return audit.listLog(this.ctx, opts); }

   async rollback(logId: number): Promise<{ ok: boolean; error?: string }> { return audit.rollback(this.ctx, logId); }

  private forgetAudit(memoryId: string): void { return audit.forgetAudit(this.ctx, memoryId); }

   async list(): Promise<Memory[]> { return retrieval.list(this.ctx); }

   async search(query: string, opts?: { personaTag?: string; limit?: number }): Promise<Memory[]> { return retrieval.search(this.ctx, query, opts); }

   async listByPersona(tag: string): Promise<Memory[]> { return retrieval.listByPersona(this.ctx, tag); }

   formatForPrompt(memories: readonly Memory[], limit = MEMORY_INJECT_LIMIT): string { return retrieval.formatForPrompt(this.ctx, memories, limit); }

   async get(id: string): Promise<MemoryRow | undefined> { return retrieval.get(this.ctx, id); }

   async listInvalidated(): Promise<MemoryRow[]> { return retrieval.listInvalidated(this.ctx); }

   stats(): { backend: 'sqlite' | 'memory'; total: number; valid: number; invalidated: number; storePath: string } { return retrieval.stats(this.ctx); }

  private validRows(): MemoryRow[] { return retrieval.validRows(this.ctx); }

   save(params: SaveMemoryParams): SaveMemoryResult { return storage.save(this.ctx, params); }

   remove(id: string, opts?: { forget?: boolean }): boolean { return storage.remove(this.ctx, id, opts); }

   compact(): void { return storage.compact(this.ctx); }

   async invalidate(id: string): Promise<void> { return storage.invalidate(this.ctx, id); }

   async restore(id: string): Promise<void> { return storage.restore(this.ctx, id); }

  private snapshotById(id: string): MemoryRow | null { return storage.snapshotById(this.ctx, id); }

  private deleteMemoryRow(id: string): void { return storage.deleteMemoryRow(this.ctx, id); }

  private writeSnapshotRow(row: MemoryRow): void { return storage.writeSnapshotRow(this.ctx, row); }
}

/** 全局单例（v1 兼容）。 */
let globalStore: MemoryStore | null = null;

/**
 * M10-11：按 workspace 隔离的存储缓存。
 * default workspace 仍走历史单库（globalStore），其余 workspace 各自一个 .db 文件。
 */
const workspaceStores = new Map<string, MemoryStore>();

export function getMemoryStore(workspaceId?: string): MemoryStore {
  const ws = workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (ws === DEFAULT_WORKSPACE_ID) {
    if (!globalStore) {
      globalStore = new MemoryStore();
    }
    return globalStore;
  }
  let store = workspaceStores.get(ws);
  if (!store) {
    store = new MemoryStore(undefined, { workspaceId: ws });
    workspaceStores.set(ws, store);
  }
  return store;
}

/** 关闭并清空 workspace 存储缓存（测试用）。 */
export function closeMemoryStores(): void {
  globalStore?.close();
  globalStore = null;
  for (const s of workspaceStores.values()) s.close();
  workspaceStores.clear();
}
