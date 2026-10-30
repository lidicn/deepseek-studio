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

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { Memory, MemoryStoreV2 } from './bot/types';
import { MEMORY_INJECT_LIMIT, formatMemoryLine, selectMemoryInjectRows } from '../inject/untrusted-memory';
import { loadAuditCrypto, AUDIT_SEAL_PREFIX, type AuditCrypto } from './audit-crypto';

export type MemoryType = 'user' | 'project';

/**
 * M10-9：记忆候选池条目。
 *
 * 候选池是「想记住但还没确认要不要记住」的中间态：候选**不进正式注入**
 * （不进 list() / search() / formatForPrompt），只有被 promote 成正式记忆后才可见。
 */
export interface MemoryCandidate {
  id: string;
  type: MemoryType;
  name: string;
  content: string;
  tags: string[];
  /** 提名理由/触发场景（可选）。 */
  reason: string | null;
  source: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * M10-10：审计日志条目（回答「何时由谁改过」）。
 *
 * before / after 存的是变更前后的完整行快照（JSON），rollback 直接按快照回写。
 */
export interface MemoryLogEntry {
  id: number;
  ts: number;
  /** 操作码：save / archive / restore / purge / candidate-promote / candidate-reject / rollback。 */
  op: string;
  memoryId: string | null;
  actor: string | null;
  before: MemoryRow | null;
  after: MemoryRow | null;
  note: string | null;
}

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
export interface MemoryRow extends Memory {
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 行构造时保证存在（契约里可选），内部按必填用。 */
  readonly personaTags: string[];
}

export interface SaveMemoryParams {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly tags?: string[];
  readonly pinned?: boolean;
  /** v2：来源（谁写入的，如 'agent' / 'user' / 'curator'）。 */
  readonly source?: string;
  /** v2：可信度 0-1（人工=1，模型推断=0.5 等）。 */
  readonly confidence?: number;
  /** v2：人设维度标签，用于 listByPersona 路由。 */
  readonly personaTags?: string[];
}

export interface SaveMemoryResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
  readonly reason?: string;
  /** 主记录成功但附属操作（FTS 同步 / 容量淘汰）失败时为 true。 */
  readonly partial?: boolean;
  /** 附属操作失败的结构化列表（partial=true 时必有内容）。 */
  readonly warnings?: readonly MemorySaveWarning[];
}

/** memory.save 的附属操作失败 warning。主记录完整性靠 memories 主表，附属失败不阻断 ok:true。 */
export interface MemorySaveWarning {
  readonly code: 'fts-sync-failed' | 'eviction-failed';
  readonly message: string;
  readonly detail?: string;
}

/** 默认记忆存储路径：~/.config/deepseek-studio/memories.db */
function defaultStorePath(): string {
  const configDir = process.env.STUDIO_CONFIG_DIR
    ?? path.join(os.homedir(), '.config', 'deepseek-studio');
  return path.join(configDir, 'memories.db');
}

/** v1 旧存储路径（用于一次性迁移导入）。 */
function legacyJsonPath(storePath: string): string {
  return path.join(path.dirname(storePath), 'memories.json');
}

function genId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidMemoryType(t: string): t is MemoryType {
  return t === 'user' || t === 'project';
}

/** 内容指纹：type + name + 规范化内容（去首尾空白 + 压缩连续空白）。 */
function contentHash(type: string, name: string, content: string): string {
  const norm = content.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(`${type}\n${name.toLowerCase()}\n${norm}`).digest('hex');
}

/** M10-7.2：名称无关的去重指纹——type + 规范化内容（压缩空白 + 去首尾 + 小写，跨名大小写/空白归一后命中）。 */
function dedupeHash(type: string, content: string): string {
  const norm = content.replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha1').update(`${type}\n${norm}`).digest('hex');
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** M10-7.3：有效记忆容量上限。新写入导致 valid 超过此值时软归档最旧非 pinned。 */
export const MAX_MEMORIES = 500;

/**
 * M10-7.3：确定性软归档淘汰选择。
 * 排序：① project 非 pinned 最旧优先；② project 不足再 user 非 pinned；
 * ③ pinned 永不淘汰；④ 同级 updatedAt ASC → createdAt ASC → id ASC。
 * 返回应归档的行（最多 need 条）；若候选数 < need 返回 null（调用方须报容量错误并不写入）。
 */
function pickEviction(rows: MemoryRow[], need: number): MemoryRow[] | null {
  if (need <= 0) return [];
  const candidates = rows
    .filter((r) => r.invalidAt === null && !r.pinned)
    .sort((a, b) => {
      // project=0 先于 user=1
      const ta = a.type === 'project' ? 0 : 1;
      const tb = b.type === 'project' ? 0 : 1;
      if (ta !== tb) return ta - tb;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  if (candidates.length < need) return null;
  return candidates.slice(0, need);
}

/** 同名更新时，既有行的治理字段投影（SQL row 与 fallback MemoryRow 都能投影成它）。 */
export interface ExistingGovernanceFields {
  pinned: boolean;
  tags: string[];
  personaTags: string[];
  source?: string;
  confidence?: number;
}

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
function toFtsQuery(query: string): string | null {
  const toks = query.split(/\s+/).map((t) => t.replace(/"/g, '')).filter(Boolean);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t}"`).join(' OR ');
}

/** LIKE 模式转义（% _ \ 三个字符），配合 ESCAPE '\'。 */
function likePattern(q: string): string {
  const esc = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${esc}%`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  confidence REAL,
  persona_tags_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT,
  dedupe_hash TEXT,
  invalid_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_invalid_at ON memories(invalid_at);
-- trigram 分词：中文子串可命中（unicode61 会把连续汉字当单 token，不可用）。
-- 代价：<3 字符的查询 FTS 不命中，由 LIKE 兜底覆盖。
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, content, tags,
  tokenize = 'trigram'
);
-- M10-9：候选池。独立表 —— 候选不参与正式注入，也不进 memories 主表。
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_created ON memory_candidates(created_at);
-- M10-10：审计日志。before_json / after_json 为完整行快照，rollback 据此回写。
CREATE TABLE IF NOT EXISTS memory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  op TEXT NOT NULL,
  memory_id TEXT,
  actor TEXT,
  before_json TEXT,
  after_json TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_log_ts ON memory_log(ts);
CREATE INDEX IF NOT EXISTS idx_memory_log_memory ON memory_log(memory_id);
`;

/** DB 行 → MemoryRow。 */
function rowToMemory(r: Record<string, unknown>): MemoryRow {
  const base: Memory = {
    id: String(r.id),
    type: (r.type === 'project' ? 'project' : 'user') as MemoryType,
    name: String(r.name ?? ''),
    content: String(r.content ?? ''),
    tags: parseJsonArray(r.tags_json),
    ...(r.source !== null && r.source !== undefined ? { source: String(r.source) } : {}),
    ...(typeof r.confidence === 'number' ? { confidence: r.confidence as number } : {}),
    personaTags: parseJsonArray(r.persona_tags_json),
    invalidAt: typeof r.invalid_at === 'number' ? (r.invalid_at as number) : null,
  };
  return {
    ...base,
    pinned: Boolean(r.pinned),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    ...(r.content_hash !== null && r.content_hash !== undefined ? { contentHash: String(r.content_hash) } : {}),
  } as MemoryRow;
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** M10-10：行快照（用于审计日志的 before/after）。深拷贝，避免后续修改污染快照。 */
function snapshotOf(row: MemoryRow): MemoryRow {
  return {
    ...row,
    tags: [...row.tags],
    personaTags: [...row.personaTags],
  } as MemoryRow;
}

/** DB 行 → MemoryCandidate。 */
function rowToCandidate(r: Record<string, unknown>): MemoryCandidate {
  return {
    id: String(r.id),
    type: (r.type === 'project' ? 'project' : 'user') as MemoryType,
    name: String(r.name ?? ''),
    content: String(r.content ?? ''),
    tags: parseJsonArray(r.tags_json),
    reason: typeof r.reason === 'string' ? r.reason : null,
    source: typeof r.source === 'string' ? r.source : null,
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/** 解析审计日志里的行快照 JSON。 */
function parseSnapshot(v: unknown): MemoryRow | null {
  if (v && typeof v === 'object') return parseSnapshotObject(v as Record<string, unknown>);
  if (typeof v !== 'string' || !v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object') return null;
    return parseSnapshotObject(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** 把已解析的快照对象规整成 MemoryRow。 */
function parseSnapshotObject(o: Record<string, unknown>): MemoryRow {
  return {
    id: String(o.id),
    type: (o.type === 'project' ? 'project' : 'user') as MemoryType,
    name: String(o.name ?? ''),
    content: String(o.content ?? ''),
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    personaTags: Array.isArray(o.personaTags)
      ? o.personaTags.filter((t): t is string => typeof t === 'string')
      : [],
    pinned: Boolean(o.pinned),
    source: typeof o.source === 'string' ? o.source : undefined,
    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    invalidAt: typeof o.invalidAt === 'number' ? o.invalidAt : null,
    createdAt: Number(o.createdAt ?? 0),
    updatedAt: Number(o.updatedAt ?? 0),
  } as MemoryRow;
}

/** sha256 指纹（forget 模式下唯一留下的痕迹）。 */
function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 由快照算出指纹（不泄漏正文）。 */
function snapshotFingerprint(v: unknown): string {
  const row = parseSnapshot(v);
  return row ? `sha256:${sha256Hex(`${row.id}\u0000${row.content}`)}` : 'sha256:unknown';
}

/** 解析候选 JSON（审计日志 note 里带）。 */
function parseCandidate(v: unknown): MemoryCandidate | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.id !== 'string') return null;
    return {
      id: o.id,
      type: (o.type === 'project' ? 'project' : 'user') as MemoryType,
      name: String(o.name ?? ''),
      content: String(o.content ?? ''),
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
      reason: typeof o.reason === 'string' ? o.reason : null,
      source: typeof o.source === 'string' ? o.source : null,
      createdAt: Number(o.createdAt ?? 0),
      updatedAt: Number(o.updatedAt ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * 记忆存储管理器 v2（SQLite + FTS5，实现 MemoryStoreV2 契约）。
 *
 * 用法与 v1 相同：new MemoryStore([storePath]) / getMemoryStore()。
 * save/remove 保持同步（node:sqlite 本身同步）；契约方法为 async。
 */
export class MemoryStore implements MemoryStoreV2 {
  private db: import('node:sqlite').DatabaseSync | null = null;
  /** node:sqlite 不可用 / 打开失败时的内存降级存储。 */
  private fallback: MemoryRow[] | null = null;
  /** M10-9：降级路径下的候选池。 */
  private fallbackCandidates: MemoryCandidate[] = [];
  /** M10-10：降级路径下的审计日志。 */
  private fallbackLog: MemoryLogEntry[] = [];
  private readonly storePath: string;
  /** M10-11：所属 workspace id（default = 不隔离，沿用历史单库）。 */
  private readonly workspaceId: string;
  /** M10-10 收口：审计快照加密器（密钥在 db 同目录）。 */
  private audit!: AuditCrypto;

  constructor(storePath?: string, opts?: { workspaceId?: string }) {
    this.workspaceId = opts?.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const basePath = storePath ?? defaultStorePath();
    this.storePath = workspaceStorePath(basePath, this.workspaceId);
    if (this.workspaceId !== DEFAULT_WORKSPACE_ID) {
      registerWorkspace(basePath, this.workspaceId);
    }
    this.open();
  }

  // ===== 内部：打开 / 降级 =====

  private open(): void {
    try {
      // 延迟 require：Node < 22.5 没有 node:sqlite，静态 import 会在模块加载期
      // 崩掉整个宿主，这里兜底为内存存储。
      const require = createRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.audit = loadAuditCrypto(this.storePath);
      const db = new DatabaseSync(this.storePath);
      // 「彻底删除」必须真的抹掉内容：secure_delete 让 SQLite 在释放页前清零，
      // 否则 DELETE 只是把页挂到 freelist，原文仍能从 .db 文件里恢复出来。
      db.exec('PRAGMA secure_delete = ON');
      db.exec(SCHEMA_SQL);
      // 旧库是在 secure_delete=0 下删过记录的，历史内容仍留在 freelist 页里。
      // 首次升级做一次 VACUUM 重写整库，user_version 记录迁移，避免每次启动都跑。
      const version = Number(
        (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
      );
      if (version < 1) {
        db.exec('VACUUM');
        db.exec('PRAGMA user_version = 1');
      }
      this.db = db;
      // M10-7.2：先加列/回填，再导入旧 JSON（导入 INSERT 已自带 dedupe_hash）。
      // 顺序反了会在「旧 DB 空表缺列 + memories.json」时导入失败漏数据。
      this.migrateDedupeHash(db);
      this.migrateAuditEncryption(db);
      this.migrateLegacyJson(db);
    } catch (e) {
      console.warn(
        '[memory] sqlite unavailable, degraded to in-memory store:',
        e instanceof Error ? e.message : String(e),
      );
      this.audit = loadAuditCrypto(this.storePath);
      this.db = null;
      this.fallback = [];
      this.loadLegacyJsonIntoFallback();
    }
  }

  /**
   * 暴露内部 SQLite 连接句柄（v0.26 聊天室数据层复用同一连接，避免两个连接锁同一文件）。
   * 降级模式（node:sqlite 不可用）返回 null。
   */
  getDb(): import('node:sqlite').DatabaseSync | null {
    return this.db;
  }

  /** 当前是否处于内存降级模式（getDb() 返回 null 时为真）。 */
  isInMemoryFallback(): boolean {
    return this.db === null;
  }

  /**
   * M10-7.2：旧库兼容迁移——补 dedupe_hash 列、回填存量、建非唯一索引。
   * 可重复执行：列已存在则跳过 ALTER，回填只处理 NULL 行，索引 IF NOT EXISTS。
   */
  private migrateDedupeHash(db: import('node:sqlite').DatabaseSync): void {
    try {
      const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'dedupe_hash')) {
        db.exec('ALTER TABLE memories ADD COLUMN dedupe_hash TEXT');
      }
      const rows = db.prepare('SELECT id, type, content FROM memories WHERE dedupe_hash IS NULL').all() as Array<{ id: string; type: string; content: string }>;
      const backfill = db.prepare('UPDATE memories SET dedupe_hash = ? WHERE id = ?');
      for (const row of rows) {
        backfill.run(dedupeHash(row.type, String(row.content ?? '')), row.id);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(type, dedupe_hash)');
    } catch (e) {
      console.warn('[memory] dedupe_hash migration failed:', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * M10-10 收口：把历史**未加密**的审计快照就地改写成密文。
   *
   * 用户此前的库里存着明文快照（这正是"彻底删除后还能翻出来"的根因）。
   * 逐行加密后必须 VACUUM，否则旧页仍留在 freelist 里被搜出来。
   */
  private migrateAuditEncryption(db: import('node:sqlite').DatabaseSync): void {
    try {
      const rows = db
        .prepare('SELECT id, before_json, after_json, note FROM memory_log')
        .all() as Array<{
        id: number;
        before_json: string | null;
        after_json: string | null;
        note: string | null;
      }>;
      if (!rows.length) return;
      const upd = db.prepare('UPDATE memory_log SET before_json = ?, after_json = ?, note = ? WHERE id = ?');
      let changed = 0;
      for (const row of rows) {
        const seal = (v: string | null, asJson: boolean): string | null => {
          if (typeof v !== 'string' || !v) return v;
          if (v.startsWith(AUDIT_SEAL_PREFIX)) return v;
          let value: unknown = v;
          if (asJson) {
            try {
              value = JSON.parse(v);
            } catch {
              return v;
            }
          }
          return this.audit.seal(value);
        };
        const before = seal(row.before_json, true);
        const after = seal(row.after_json, true);
        const note = seal(row.note, false);
        if (before === row.before_json && after === row.after_json && note === row.note) continue;
        upd.run(before, after, note, row.id);
        changed += 1;
      }
      if (changed > 0) {
        db.exec('VACUUM');
        console.warn(`[memory] audit snapshots re-sealed: ${changed} row(s)`);
      }
    } catch (e) {
      console.warn(
        '[memory] audit encryption migration failed (non-fatal):',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /** 旧 memories.json 一次性导入（仅在 DB 表为空时，保留原文件作备份）。 */
  private migrateLegacyJson(db: import('node:sqlite').DatabaseSync): void {
    const legacy = legacyJsonPath(this.storePath);
    if (legacy === this.storePath || !fs.existsSync(legacy)) return;
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n as number) ?? 0;
      if (count > 0) return;
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const ins = db.prepare(
        `INSERT OR REPLACE INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json, content_hash, dedupe_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ftsIns = db.prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)');
      let imported = 0;
      for (const raw of parsed) {
        if (!raw || typeof raw.id !== 'string') continue;
        const now = Date.now();
        const tags = Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string') : [];
        const type = raw.type === 'project' ? 'project' : 'user';
        const content = String(raw.content ?? '');
        const name = String(raw.name ?? '');
        ins.run(
          raw.id, type, name, content, JSON.stringify(tags), raw.pinned ? 1 : 0,
          'import', null, '[]', contentHash(type, name, content), dedupeHash(type, content), null,
          Number(raw.createdAt ?? now), Number(raw.updatedAt ?? now),
        );
        const rid = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get(raw.id)?.rowid as number) ?? 0;
        ftsIns.run(rid, name, content, tags.join(' '));
        imported += 1;
      }
      if (imported > 0) {
        console.warn(`[memory] migrated ${imported} memories from ${legacy} (file kept as backup)`);
      }
    } catch (e) {
      console.warn('[memory] legacy json migration failed:', e instanceof Error ? e.message : String(e));
    }
  }

  private loadLegacyJsonIntoFallback(): void {
    const legacy = legacyJsonPath(this.storePath);
    if (legacy === this.storePath || !fs.existsSync(legacy)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const raw of parsed) {
        if (!raw || typeof raw.id !== 'string') continue;
        this.fallback!.push({
          id: raw.id,
          type: raw.type === 'project' ? 'project' : 'user',
          name: String(raw.name ?? ''),
          content: String(raw.content ?? ''),
          tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string') : [],
          source: 'import',
          personaTags: [],
          invalidAt: null,
          pinned: Boolean(raw.pinned),
          createdAt: Number(raw.createdAt ?? now),
          updatedAt: Number(raw.updatedAt ?? now),
        });
      }
    } catch {
      /* 降级路径下迁移失败不阻塞 */
    }
  }

  // ===== v1 兼容 API（同步）=====

  /** 保存一条记忆（同 type + name 已存在则更新；内容完全一致则空操作）。 */
  save(params: SaveMemoryParams): SaveMemoryResult {
    if (!isValidMemoryType(params.type)) {
      return { ok: false, error: `invalid memory type: ${params.type} (expected 'user' or 'project')` };
    }
    if (!params.name || !params.content) {
      return { ok: false, error: 'name and content are required' };
    }
    if (params.confidence !== undefined && (typeof params.confidence !== 'number' || Number.isNaN(params.confidence) || params.confidence < 0 || params.confidence > 1)) {
      return { ok: false, error: 'confidence must be a number in [0, 1]' };
    }

    const now = Date.now();
    const tags = params.tags ?? [];
    const personaTags = params.personaTags ?? [];
    const hash = contentHash(params.type, params.name, params.content);
    // M10-7.2：名称无关去重指纹（同名之外，跨名同内容也靠它命中既有行）。
    const dedupe = dedupeHash(params.type, params.content);

    if (this.db) {
      // M10-5：同名行分「有效 / 已失效」两种命中。有效 → 原地更新；已失效 → 复活原行
      // （invalid_at 归零）而不是另起一行有效记录，否则账本会出现「作废 + 同名有效」
      // 两行、stats().total 单调顶高，而面板因为只看 list() 看不出重复。
      // 排序取「有效优先，其次最近更新」，两条命中共用下面同一段 UPDATE。
      const existing = this.db
        .prepare(
          `SELECT rowid AS rid, * FROM memories
           WHERE type = ? AND lower(name) = lower(?)
           ORDER BY (invalid_at IS NULL) DESC, updated_at DESC
           LIMIT 1`,
        )
        .get(params.type, params.name) as Record<string, unknown> | undefined;

      if (existing) {
        const valid = existing.invalid_at === null || existing.invalid_at === undefined;
        const existingHash = typeof existing.content_hash === 'string' ? existing.content_hash : '';
        const existingGov: ExistingGovernanceFields = {
          pinned: existing.pinned === 1,
          tags: parseJsonArray(existing.tags_json),
          personaTags: parseJsonArray(existing.persona_tags_json),
          source: typeof existing.source === 'string' ? existing.source : undefined,
          confidence: typeof existing.confidence === 'number' ? existing.confidence : undefined,
        };
        // M10-7.1：未传治理字段保留原值，显式传值（含 false/[]）才覆盖。
        const merged = mergeUpdateGovernance(existingGov, params);
        // 无变化判断必须覆盖全部治理字段：内容或任一治理字段有变都要落库；
        // 只比 contentHash+tags 会吞掉“同内容、仅改 pinned/personaTags/source/confidence”的更新。
        const unchanged =
          valid &&
          existingHash === hash &&
          merged.pinned === existingGov.pinned &&
          sameStringArray(merged.tags, existingGov.tags) &&
          sameStringArray(merged.personaTags, existingGov.personaTags) &&
          (merged.source ?? undefined) === existingGov.source &&
          (merged.confidence ?? undefined) === existingGov.confidence;
        if (unchanged) {
          return { ok: true, id: String(existing.id) }; // 无变化，不搅动 updatedAt
        }
        // M10-7.3 P1-1：归档行复活 delta=1，须先做容量预算；全 pinned 时拒绝，归档行保持 invalid。
        const deltaValid: 0 | 1 = valid ? 0 : 1;
        const budget = this.prepareEviction(deltaValid);
        if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-archive-at-capacity-all-pinned' };
        const rid = existing.rid as number;
        const beforeRow = rowToMemory(existing);
        this.db.prepare(
          `UPDATE memories SET content = ?, tags_json = ?, pinned = ?, source = ?, confidence = ?,
           persona_tags_json = ?, content_hash = ?, dedupe_hash = ?, invalid_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(
          params.content, JSON.stringify(merged.tags), merged.pinned ? 1 : 0,
          merged.source ?? null, merged.confidence ?? null, JSON.stringify(merged.personaTags), hash, dedupe, now,
          String(existing.id),
        );
        // M10-10：审计埋点（记录变更前后完整行快照，可按日志回滚）。
        this.recordLog('save', String(existing.id), beforeRow, this.snapshotById(String(existing.id)));
        // C1-F2：FTS 同步 + 容量淘汰（附属失败收集为 warnings，不阻断主保存）。
        const ftsWarn = this.syncFts(rid, params.name, params.content, merged.tags);
        const evictWarn = this.applyEviction(budget.evict, now);
        const warnings = [...ftsWarn, ...evictWarn];
        return warnings.length > 0
          ? { ok: true, id: String(existing.id), partial: true, warnings }
          : { ok: true, id: String(existing.id) };
      }

      // M10-7.2：同名未命中 → 同 type + dedupe_hash 跨名去重。有效行优先、否则最近更新；
      // 不改原 name（跨名去重保留首个名称），content_hash 用原 name 重算以保留旧语义。
      const cross = this.db
        .prepare(
          `SELECT rowid AS rid, * FROM memories
           WHERE type = ? AND dedupe_hash = ?
           ORDER BY (invalid_at IS NULL) DESC, updated_at DESC
           LIMIT 1`,
        )
        .get(params.type, dedupe) as Record<string, unknown> | undefined;
      if (cross) {
        const crossId = String(cross.id);
        const valid = cross.invalid_at === null || cross.invalid_at === undefined;
        const crossName = String(cross.name);
        const crossHash = contentHash(params.type, crossName, params.content);
        const crossGov: ExistingGovernanceFields = {
          pinned: cross.pinned === 1,
          tags: parseJsonArray(cross.tags_json),
          personaTags: parseJsonArray(cross.persona_tags_json),
          source: typeof cross.source === 'string' ? cross.source : undefined,
          confidence: typeof cross.confidence === 'number' ? cross.confidence : undefined,
        };
        const merged = mergeUpdateGovernance(crossGov, params);
        // 跨名同内容时若治理字段也未变 → no-op，直接复用既有 id，不搅动 updatedAt。
        const unchanged =
          valid &&
          merged.pinned === crossGov.pinned &&
          sameStringArray(merged.tags, crossGov.tags) &&
          sameStringArray(merged.personaTags, crossGov.personaTags) &&
          (merged.source ?? undefined) === crossGov.source &&
          (merged.confidence ?? undefined) === crossGov.confidence;
        if (unchanged) {
          return { ok: true, id: crossId };
        }
        // M10-7.3 P1-1：跨名归档行复活 delta=1，须先做容量预算。
        const deltaValid: 0 | 1 = valid ? 0 : 1;
        const budget = this.prepareEviction(deltaValid);
        if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-cross-at-capacity-all-pinned' };
        const rid = cross.rid as number;
        const crossBefore = rowToMemory(cross);
        this.db.prepare(
          `UPDATE memories SET content = ?, tags_json = ?, pinned = ?, source = ?, confidence = ?,
           persona_tags_json = ?, content_hash = ?, dedupe_hash = ?, invalid_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(
          params.content, JSON.stringify(merged.tags), merged.pinned ? 1 : 0,
          merged.source ?? null, merged.confidence ?? null, JSON.stringify(merged.personaTags),
          crossHash, dedupe, now, crossId,
        );
        // M10-10：审计埋点（跨名去重命中同样留痕）。
        this.recordLog('save', crossId, crossBefore, this.snapshotById(crossId));
        // C1-F2：name 保留原值，FTS 仍按原 name 索引；同步降级处理防 rowid 冲突。
        const ftsWarn = this.syncFts(rid, crossName, params.content, merged.tags);
        const evictWarn = this.applyEviction(budget.evict, now);
        const warnings = [...ftsWarn, ...evictWarn];
        return warnings.length > 0
          ? { ok: true, id: crossId, partial: true, warnings }
          : { ok: true, id: crossId };
      }

      // M10-7.3：写前容量预算。全 pinned 无法腾容量时拒绝本次写入，不落地、不部分改动。
      const budget = this.prepareEviction(1);
      if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'valid-memories-at-capacity-and-all-pinned' };
      const id = genId();
      this.db.prepare(
        `INSERT INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json, content_hash, dedupe_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, params.type, params.name, params.content, JSON.stringify(tags), (params.pinned ?? false) ? 1 : 0,
        params.source ?? null, params.confidence ?? null, JSON.stringify(personaTags), hash, dedupe, null, now, now,
      );
      const rid = (this.db.prepare('SELECT last_insert_rowid() AS rid').get()?.rid as number) ?? 0;
      // M10-10：新建（before = null）与更新区分开，rollback 据此决定「删行」还是「回写」。
      this.recordLog('save', id, null, this.snapshotById(id));
      // C1-F2：FTS 同步 + 容量淘汰（附属失败收集为 warnings，不阻断主保存）。
      const ftsWarn = this.syncFts(rid, params.name, params.content, tags);
      const evictWarn = this.applyEviction(budget.evict, now);
      const warnings = [...ftsWarn, ...evictWarn];
      return warnings.length > 0
        ? { ok: true, id, partial: true, warnings }
        : { ok: true, id };
    }

    // 降级路径：内存数组
    const sameName = this.fallback!.filter(
      (m) => m.type === params.type && m.name.toLowerCase() === params.name.toLowerCase(),
    );
    // M10-5：同 SQL 路径——有效行优先，否则复活最近一条同名作废行。
    const target = sameName.find((m) => m.invalidAt === null) ?? sameName[sameName.length - 1];
    if (target) {
      // M10-7.1：与 SQL 路径同一合并语义——未传治理字段保留原值。
      const merged = mergeUpdateGovernance(target, params);
      // 与 SQL 对齐的 true no-op：行仍有效、content 与全部治理字段均未变 → 直接返回，不改 updatedAt。
      // 内容口径必须与 SQL 一致：走规范化 contentHash（压缩连续空白），不用精确字符串比较。
      const unchanged =
        target.invalidAt === null &&
        contentHash(target.type, target.name, target.content) === hash &&
        merged.pinned === target.pinned &&
        sameStringArray(merged.tags, target.tags) &&
        sameStringArray(merged.personaTags, target.personaTags) &&
        (merged.source ?? undefined) === target.source &&
        (merged.confidence ?? undefined) === target.confidence;
      if (unchanged) {
        return { ok: true, id: target.id };
      }
      // M10-7.3 P1-1：fallback 同名归档行复活 delta=1，须先做容量预算。
      const deltaValid: 0 | 1 = target.invalidAt === null ? 0 : 1;
      const budget = this.prepareEviction(deltaValid);
      if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-archive-at-capacity-all-pinned' };
      const idx = this.fallback!.indexOf(target);
      const fbBefore = snapshotOf(target);
      this.fallback![idx] = {
        ...target, content: params.content, tags: merged.tags, pinned: merged.pinned,
        source: merged.source, confidence: merged.confidence, personaTags: merged.personaTags,
        invalidAt: null, updatedAt: now,
      } as MemoryRow;
      // M10-10：降级路径同样留痕。
      this.recordLog('save', target.id, fbBefore, this.snapshotById(target.id));
      const evictWarn = this.applyEviction(budget.evict, now);
      return evictWarn.length > 0
        ? { ok: true, id: target.id, partial: true, warnings: evictWarn }
        : { ok: true, id: target.id };
    }

    // M10-7.2：同名未命中 → 同 type + dedupeHash 跨名去重。有效行优先、否则最近更新。
    const sameDedupe = this.fallback!.filter(
      (m) => m.type === params.type && dedupeHash(m.type, m.content) === dedupe,
    );
    const crossTarget =
      sameDedupe.find((m) => m.invalidAt === null) ??
      [...sameDedupe].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (crossTarget) {
      const merged = mergeUpdateGovernance(crossTarget, params);
      const unchanged =
        crossTarget.invalidAt === null &&
        merged.pinned === crossTarget.pinned &&
        sameStringArray(merged.tags, crossTarget.tags) &&
        sameStringArray(merged.personaTags, crossTarget.personaTags) &&
        (merged.source ?? undefined) === crossTarget.source &&
        (merged.confidence ?? undefined) === crossTarget.confidence;
      if (unchanged) {
        return { ok: true, id: crossTarget.id };
      }
      // M10-7.3 P1-1：fallback 跨名归档行复活 delta=1，须先做容量预算。
      const deltaValid: 0 | 1 = crossTarget.invalidAt === null ? 0 : 1;
      const budget = this.prepareEviction(deltaValid);
      if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-cross-at-capacity-all-pinned' };
      const idx = this.fallback!.indexOf(crossTarget);
      const fbCrossBefore = snapshotOf(crossTarget);
      this.fallback![idx] = {
        ...crossTarget, content: params.content, tags: merged.tags, pinned: merged.pinned,
        source: merged.source, confidence: merged.confidence, personaTags: merged.personaTags,
        invalidAt: null, updatedAt: now,
      } as MemoryRow;
      // M10-10：降级路径同样留痕。
      this.recordLog('save', crossTarget.id, fbCrossBefore, this.snapshotById(crossTarget.id));
      const evictWarn = this.applyEviction(budget.evict, now);
      return evictWarn.length > 0
        ? { ok: true, id: crossTarget.id, partial: true, warnings: evictWarn }
        : { ok: true, id: crossTarget.id };
    }

    // M10-7.3：写前容量预算，与 SQL 路径同一淘汰排序语义。全 pinned 无法腾容量则拒绝。
    const budget = this.prepareEviction(1);
    if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'valid-memories-at-capacity-and-all-pinned' };
    const id = genId();
    this.fallback!.push({
      id, type: params.type as MemoryType, name: params.name, content: params.content, tags,
      pinned: params.pinned ?? false, source: params.source, confidence: params.confidence,
      personaTags, invalidAt: null, createdAt: now, updatedAt: now,
    } as MemoryRow);
    // M10-10：降级路径新建留痕。
    this.recordLog('save', id, null, this.snapshotById(id));
    const evictWarn = this.applyEviction(budget.evict, now);
    return evictWarn.length > 0
      ? { ok: true, id, partial: true, warnings: evictWarn }
      : { ok: true, id };
  }

  /**
   * 硬删除一条记忆（返回是否命中）。注意：治理场景请用 invalidate()。
   *
   * opts.forget = true 时，审计日志里的正文快照也一并抹除（只留 hash 指纹），
   * 用于「彻底删除 = 真的再也翻不出来」的场景；默认 false，保留可回滚的加密快照。
   */
  remove(id: string, opts?: { forget?: boolean }): boolean {
    if (this.db) {
      // 必须取整行：审计快照（M10-10）要靠这一行的 name/content 等字段，
      // 只 SELECT rowid 会让 purge 的 before 快照变成空行，rollback 写回后内容全丢。
      const row = this.db.prepare('SELECT *, rowid AS rid FROM memories WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return false;
      const before = rowToMemory(row);
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rid as number);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      if (opts?.forget) {
        // 连审计快照一起抹掉：只留指纹，不可回滚。
        this.forgetAudit(id);
        this.recordLog('purge', id, null, null, null, `forgotten ${snapshotFingerprint(before)}`);
      } else {
        // M10-10：彻底删除留痕，rollback 可据快照还原该行。
        this.recordLog('purge', id, before, null);
      }
      return true;
    }
    const idx = this.fallback!.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    const before = snapshotOf(this.fallback![idx]);
    this.fallback!.splice(idx, 1);
    if (opts?.forget) {
      this.fallbackLog = this.fallbackLog.map((e) =>
        e.memoryId === id
          ? { ...e, before: null, after: null, note: `forgotten sha256:${sha256Hex(before.content)}` }
          : e,
      );
      this.recordLog('purge', id, null, null, null, `forgotten sha256:${sha256Hex(before.content)}`);
    } else {
      // M10-10：彻底删除留痕（降级路径）。
      this.recordLog('purge', id, before, null);
    }
    return true;
  }

  /**
   * 抹除某条记忆在审计日志里的全部正文快照，只留 hash 指纹。
   * 用于 forget 模式：删除后既不可回滚，也搜不到原文。
   */
  private forgetAudit(memoryId: string): void {
    if (!this.db) return;
    try {
      const rows = this.db
        .prepare('SELECT id, before_json, after_json FROM memory_log WHERE memory_id = ?')
        .all(memoryId) as Array<{
        id: number;
        before_json: string | null;
        after_json: string | null;
      }>;
      const upd = this.db.prepare('UPDATE memory_log SET before_json = NULL, after_json = NULL, note = ? WHERE id = ?');
      for (const row of rows) {
        // snapshotFingerprint 自带 "sha256:" 前缀，这里不要再补一个。
        const fingerprint = `forgotten ${snapshotFingerprint(this.audit.open(row.before_json))}`;
        upd.run(fingerprint, row.id);
      }
    } catch (e) {
      console.warn(
        '[memory] forget audit failed (non-fatal):',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * 物理压缩数据库：VACUUM 重写整库，把已释放的页从文件中移除。
   * 低频人工操作（memory.purge）后调用，确保 FTS 影子表等处的残留一并清除。
   */
  compact(): void {
    if (!this.db) return;
    try {
      this.db.exec('VACUUM');
    } catch (e) {
      console.warn('[memory] vacuum failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // ===== MemoryStoreV2 契约 API（async）=====

  /** 列出全部有效记忆（置顶优先，然后按更新时间倒序 —— 同 v1 排序）。 */
  async list(): Promise<Memory[]> {
    return this.sortRows(this.validRows());
  }

  /** 混合检索：FTS5(trigram) bm25 → LIKE 兜底 → 标签精确命中加权。 */
  async search(query: string, opts?: { personaTag?: string; limit?: number }): Promise<Memory[]> {
    const q = (query ?? '').trim();
    const limit = Math.max(1, opts?.limit ?? 20);
    if (!q) {
      return this.sortRows(this.applyPersonaFilter(this.validRows(), opts?.personaTag)).slice(0, limit);
    }

    let rows: MemoryRow[];
    if (this.db) {
      rows = [];
      // trigram 要求查询 >= 3 字符；不足走 LIKE
      if ([...q].length >= 3) {
        const fts = toFtsQuery(q);
        if (fts) {
          try {
            const found = this.db.prepare(
              `SELECT m.* FROM memories m
               JOIN memories_fts f ON f.rowid = m.rowid
               WHERE memories_fts MATCH ? AND m.invalid_at IS NULL
               ORDER BY bm25(memories_fts)
               LIMIT ?`,
            ).all(fts, limit * 4) as Record<string, unknown>[];
            rows = found.map(rowToMemory);
          } catch {
            rows = []; // MATCH 语法异常 → LIKE 兜底
          }
        }
      }
      if (rows.length === 0) {
        const pat = likePattern(q);
        const found = this.db.prepare(
          `SELECT * FROM memories
           WHERE invalid_at IS NULL AND (name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        ).all(pat, pat, pat, limit * 4) as Record<string, unknown>[];
        rows = found.map(rowToMemory);
      }
    } else {
      const needle = q.toLowerCase();
      rows = this.fallback!.filter(
        (m) => m.invalidAt === null &&
          (m.name.toLowerCase().includes(needle) ||
            m.content.toLowerCase().includes(needle) ||
            m.tags.some((t) => t.toLowerCase().includes(needle))),
      );
      rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
    }

    // 标签精确命中加权（稳定排序：精确标签 → 置顶 → 原相关序）
    const needle = q.toLowerCase();
    const tagged = new Set(rows.filter((m) => m.tags.some((t) => t.toLowerCase() === needle)).map((m) => m.id));
    if (tagged.size > 0) {
      rows = [
        ...rows.filter((m) => tagged.has(m.id)),
        ...rows.filter((m) => !tagged.has(m.id)),
      ];
    }
    return this.applyPersonaFilter(rows, opts?.personaTag).slice(0, limit);
  }

  /** 失效一条记忆（标记 invalidAt，数据保留；幂等，重复调用无操作）。 */
  async invalidate(id: string): Promise<void> {
    const now = Date.now();
    if (this.db) {
      const before = this.snapshotById(id);
      this.db.prepare('UPDATE memories SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(now, now, id);
      // M10-10：归档留痕（软归档，rollback 可复活）。
      if (before) this.recordLog('archive', id, before, this.snapshotById(id));
      return;
    }
    const m = this.fallback!.find((x) => x.id === id);
    if (m && m.invalidAt === null) {
      const before = snapshotOf(m);
      (m as { invalidAt: number | null }).invalidAt = now;
      (m as { updatedAt: number }).updatedAt = now;
      // M10-10：归档留痕（降级路径）。
      this.recordLog('archive', id, before, this.snapshotById(id));
    }
  }

  /** 撤销失效（回滚，供 Curator / 人工纠误）。 */
  async restore(id: string): Promise<void> {
    const now = Date.now();
    if (this.db) {
      const before = this.snapshotById(id);
      this.db.prepare('UPDATE memories SET invalid_at = NULL, updated_at = ? WHERE id = ? AND invalid_at IS NOT NULL')
        .run(now, id);
      // M10-10：复活留痕。
      if (before) this.recordLog('restore', id, before, this.snapshotById(id));
      return;
    }
    const m = this.fallback!.find((x) => x.id === id);
    if (m && m.invalidAt !== null) {
      const before = snapshotOf(m);
      (m as { invalidAt: number | null }).invalidAt = null;
      (m as { updatedAt: number }).updatedAt = now;
      // M10-10：复活留痕（降级路径）。
      this.recordLog('restore', id, before, this.snapshotById(id));
    }
  }

  /** 按人设标签列出有效记忆（置顶优先，更新时间倒序）。 */
  async listByPersona(tag: string): Promise<Memory[]> {
    const rows = this.validRows().filter((m) => m.personaTags.includes(tag));
    return this.sortRows(rows);
  }

  /** 格式化注入系统提示词（格式与 v1 一致：- #id [type] name: content）。
   *  M10-8A：与页端共用 selectMemoryInjectRows——行数预算(40)与 token 预算(1800)取更早触发者。 */
  formatForPrompt(memories: readonly Memory[], limit = MEMORY_INJECT_LIMIT): string {
    const selected = selectMemoryInjectRows(memories, { rowLimit: limit });
    if (selected.length === 0) return '';
    return selected.map(formatMemoryLine).join('\n');
  }

  // ===== 辅助 API（契约外，供 UI / 诊断 / Curator）=====

  /** 按 id 取有效记忆。 */
  async get(id: string): Promise<MemoryRow | undefined> {
    if (this.db) {
      const r = this.db.prepare('SELECT * FROM memories WHERE id = ? AND invalid_at IS NULL').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToMemory(r) : undefined;
    }
    const m = this.fallback!.find((x) => x.id === id && x.invalidAt === null);
    return m ? { ...m } : undefined;
  }

  /** 列出已失效记忆（审计/回滚入口）。 */
  async listInvalidated(): Promise<MemoryRow[]> {
    const rows = this.allRows().filter((m) => m.invalidAt !== null);
    return rows.sort((a, b) => (b.invalidAt ?? 0) - (a.invalidAt ?? 0));
  }

  // ===== M10-9 候选池 =====

  /**
   * 提名一条候选记忆。候选**不进正式注入**（不进 list/search/formatForPrompt），
   * 只有 promote 之后才成为正式记忆。
   */
  addCandidate(input: {
    type: string;
    name: string;
    content: string;
    tags?: string[];
    reason?: string;
    source?: string;
  }): { ok: boolean; id?: string; error?: string } {
    if (!isValidMemoryType(input.type)) {
      return { ok: false, error: `invalid memory type: ${input.type} (expected 'user' or 'project')` };
    }
    if (!input.name || !input.content) {
      return { ok: false, error: 'name and content are required' };
    }
    const now = Date.now();
    const candidate: MemoryCandidate = {
      id: genId().replace(/^mem-/, 'cand-'),
      type: input.type,
      name: input.name,
      content: input.content,
      tags: input.tags ?? [],
      reason: input.reason ?? null,
      source: input.source ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (this.db) {
      this.db.prepare(
        `INSERT INTO memory_candidates
         (id, type, name, content, tags_json, reason, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.id, candidate.type, candidate.name, candidate.content,
        JSON.stringify(candidate.tags), candidate.reason, candidate.source, now, now,
      );
    } else {
      this.fallbackCandidates.push(candidate);
    }
    return { ok: true, id: candidate.id };
  }

  /** 列出全部候选（按创建时间倒序）。 */
  async listCandidates(): Promise<MemoryCandidate[]> {
    if (this.db) {
      const rows = this.db
        .prepare('SELECT * FROM memory_candidates ORDER BY created_at DESC')
        .all() as Record<string, unknown>[];
      return rows.map(rowToCandidate);
    }
    return [...this.fallbackCandidates]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({ ...c, tags: [...c.tags] }));
  }

  /** 按 id 取候选。 */
  async getCandidate(id: string): Promise<MemoryCandidate | undefined> {
    if (this.db) {
      const r = this.db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToCandidate(r) : undefined;
    }
    const c = this.fallbackCandidates.find((x) => x.id === id);
    return c ? { ...c, tags: [...c.tags] } : undefined;
  }

  /** 候选转正：写入正式记忆 + 删除候选 + 留痕。 */
  async promoteCandidate(id: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    const candidate = await this.getCandidate(id);
    if (!candidate) return { ok: false, error: 'candidate not found' };
    const res = this.save({
      type: candidate.type,
      name: candidate.name,
      content: candidate.content,
      tags: candidate.tags,
      source: candidate.source ?? 'candidate',
    });
    if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'save failed' };
    this.deleteCandidateRow(id);
    this.recordLog('candidate-promote', res.id, null, this.snapshotById(res.id), null, JSON.stringify(candidate));
    return { ok: true, id: res.id };
  }

  /** 候选否决：删除候选 + 留痕（候选内容留在日志里，可回滚）。 */
  async rejectCandidate(id: string, note?: string): Promise<boolean> {
    const candidate = await this.getCandidate(id);
    if (!candidate) return false;
    this.deleteCandidateRow(id);
    this.recordLog(
      'candidate-reject',
      id,
      null,
      null,
      null,
      JSON.stringify({ ...candidate, __note: note ?? null }),
    );
    return true;
  }

  // ===== M10-10 审计日志 =====

  /** 列出审计日志（倒序）。 */
  async listLog(opts?: { limit?: number; memoryId?: string }): Promise<MemoryLogEntry[]> {
    const limit = Math.max(1, opts?.limit ?? 50);
    let entries: MemoryLogEntry[];
    if (this.db) {
      const rows = (opts?.memoryId
        ? this.db
            .prepare('SELECT * FROM memory_log WHERE memory_id = ? ORDER BY id DESC LIMIT ?')
            .all(opts.memoryId, limit)
        : this.db.prepare('SELECT * FROM memory_log ORDER BY id DESC LIMIT ?').all(limit)) as Record<
        string,
        unknown
      >[];
      entries = rows.map((r) => {
        const noteValue = this.audit.open(r.note);
        return {
          id: Number(r.id),
          ts: Number(r.ts ?? 0),
          op: String(r.op ?? ''),
          memoryId: typeof r.memory_id === 'string' ? r.memory_id : null,
          actor: typeof r.actor === 'string' ? r.actor : null,
          before: parseSnapshot(this.audit.open(r.before_json)),
          after: parseSnapshot(this.audit.open(r.after_json)),
          note:
            noteValue === null || noteValue === undefined
              ? null
              : typeof noteValue === 'string'
                ? noteValue
                : JSON.stringify(noteValue),
        };
      });
    } else {
      entries = [...this.fallbackLog]
        .filter((e) => (opts?.memoryId ? e.memoryId === opts.memoryId : true))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    }
    return entries;
  }

  /**
   * 回滚某条日志。
   * 语义按「操作前快照」回写：
   * - before 存在 → 用 before 覆盖当前行（purge / archive / restore / update 都归此类）；
   * - before 为 null（新建） → 删除该行；
   * - candidate-promote / candidate-reject → 撤销候选流转（删记忆 / 还原候选）。
   */
  async rollback(logId: number): Promise<{ ok: boolean; error?: string }> {
    const all = await this.listLog({ limit: 100000 });
    const entry = all.find((e) => e.id === logId);
    if (!entry) return { ok: false, error: 'log entry not found' };

    if (entry.op === 'candidate-promote') {
      if (entry.memoryId) this.deleteMemoryRow(entry.memoryId);
      const c = parseCandidate(entry.note);
      if (c) this.insertCandidateRow(c);
      this.recordLog('rollback', entry.memoryId, entry.after, entry.before, null, `rollback ${entry.id}`);
      return { ok: true };
    }
    if (entry.op === 'candidate-reject') {
      const c = parseCandidate(entry.note);
      if (c) this.insertCandidateRow(c);
      this.recordLog('rollback', entry.memoryId, null, null, null, `rollback ${entry.id}`);
      return { ok: true };
    }

    if (entry.before) {
      this.writeSnapshotRow(entry.before);
    } else if (entry.memoryId) {
      this.deleteMemoryRow(entry.memoryId);
    }
    this.recordLog('rollback', entry.memoryId, entry.after, entry.before, null, `rollback ${entry.id}`);
    return { ok: true };
  }


  /** 存储统计（诊断）。 */
  stats(): { backend: 'sqlite' | 'memory'; total: number; valid: number; invalidated: number; storePath: string } {
    const all = this.allRows();
    return {
      backend: this.db ? 'sqlite' : 'memory',
      total: all.length,
      valid: all.filter((m) => m.invalidAt === null).length,
      invalidated: all.filter((m) => m.invalidAt !== null).length,
      storePath: this.storePath,
    };
  }

  /** M10-11：当前 store 所属 workspace id。 */
  getWorkspaceId(): string {
    return this.workspaceId;
  }

  /** 关闭库连接（测试 / 宿主退出）。 */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* 忽略关闭异常 */
      }
      this.db = null;
    }
    this.fallback = null;
  }

  // ===== 内部 helpers =====

  /** 取任意行（含已失效）快照 —— 审计与回滚都用它。 */
  private snapshotById(id: string): MemoryRow | null {
    if (this.db) {
      const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToMemory(r) : null;
    }
    const m = this.fallback?.find((x) => x.id === id);
    return m ? snapshotOf(m) : null;
  }

  /** M10-10：写一条审计日志。before/after 存完整行快照 JSON。 */
  private recordLog(
    op: string,
    memoryId: string | null,
    before: MemoryRow | null,
    after: MemoryRow | null,
    actor?: string | null,
    note?: string | null,
  ): void {
    const ts = Date.now();
    // 快照含正文明文 —— 一律加密落盘（.db 文件里只剩密文）。
    const beforeJson = before ? this.audit.seal(before) : null;
    const afterJson = after ? this.audit.seal(after) : null;
    const sealedNote = note ? this.audit.seal(note) : null;
    if (this.db) {
      try {
        this.db
          .prepare(
            `INSERT INTO memory_log (ts, op, memory_id, actor, before_json, after_json, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(ts, op, memoryId, actor ?? null, beforeJson, afterJson, sealedNote);
      } catch (e) {
        console.warn(
          '[memory] audit log write failed (non-fatal):',
          e instanceof Error ? e.message : String(e),
        );
      }
      return;
    }
    this.fallbackLog.push({
      id: this.fallbackLog.length + 1,
      ts,
      op,
      memoryId,
      actor: actor ?? null,
      before: before ? snapshotOf(before) : null,
      after: after ? snapshotOf(after) : null,
      note: note ?? null,
    });
  }

  /** 删除候选行（DB / 降级两路）。 */
  private deleteCandidateRow(id: string): void {
    if (this.db) {
      this.db.prepare('DELETE FROM memory_candidates WHERE id = ?').run(id);
      return;
    }
    const idx = this.fallbackCandidates.findIndex((c) => c.id === id);
    if (idx >= 0) this.fallbackCandidates.splice(idx, 1);
  }

  /** 写回候选行（回滚用；已存在则覆盖）。 */
  private insertCandidateRow(c: MemoryCandidate): void {
    if (this.db) {
      this.db.prepare(
        `INSERT OR REPLACE INTO memory_candidates
         (id, type, name, content, tags_json, reason, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.id, c.type, c.name, c.content, JSON.stringify(c.tags),
        c.reason, c.source, c.createdAt, c.updatedAt,
      );
      return;
    }
    const idx = this.fallbackCandidates.findIndex((x) => x.id === c.id);
    if (idx >= 0) this.fallbackCandidates[idx] = { ...c, tags: [...c.tags] };
    else this.fallbackCandidates.push({ ...c, tags: [...c.tags] });
  }

  /** 删除正式记忆行（含 FTS 影子表），DB / 降级两路。 */
  private deleteMemoryRow(id: string): void {
    if (this.db) {
      const row = this.db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (row) this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rid as number);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return;
    }
    if (!this.fallback) return;
    const idx = this.fallback.findIndex((m) => m.id === id);
    if (idx >= 0) this.fallback.splice(idx, 1);
  }

  /** 用快照覆盖写入一行（回滚用），DB / 降级两路。 */
  private writeSnapshotRow(row: MemoryRow): void {
    if (this.db) {
      const hash = contentHash(row.type, row.name, row.content);
      const dedupe = dedupeHash(row.type, row.content);
      this.db.prepare(
        `INSERT OR REPLACE INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json,
          content_hash, dedupe_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id, row.type, row.name, row.content, JSON.stringify(row.tags), row.pinned ? 1 : 0,
        row.source ?? null, row.confidence ?? null, JSON.stringify(row.personaTags),
        hash, dedupe, row.invalidAt ?? null, row.createdAt, row.updatedAt,
      );
      const rid = (this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(row.id)?.rowid as number) ?? 0;
      try {
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rid);
        this.db
          .prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)')
          .run(rid, row.name, row.content, row.tags.join(' '));
      } catch {
        /* FTS 失败不影响主记录 */
      }
      return;
    }
    if (!this.fallback) return;
    const idx = this.fallback.findIndex((m) => m.id === row.id);
    const snap = snapshotOf(row);
    if (idx >= 0) this.fallback[idx] = snap;
    else this.fallback.push(snap);
  }

  private allRows(): MemoryRow[] {
    if (this.db) {
      const found = this.db.prepare('SELECT * FROM memories').all() as Record<string, unknown>[];
      return found.map(rowToMemory);
    }
    return this.fallback ? this.fallback.map((m) => ({ ...m })) : [];
  }

  /** 仅有效记忆行（invalidAt === null）。 */
  private validRows(): MemoryRow[] {
    return this.allRows().filter((m) => m.invalidAt === null);
  }

  /**
   * M10-7.3：写前容量预算。deltaValid=1 表示本次写入会新增一条有效（新建或复活归档行）。
   * 投影 valid 超过 MAX_MEMORIES 时选应归档行；候选不足（全 pinned）返回 ok:false 供调用方拒绝写入。
   */
  private prepareEviction(deltaValid: 0 | 1): { ok: true; evict: MemoryRow[] } | { ok: false } {
    if (deltaValid === 0) return { ok: true, evict: [] };
      const valid = this.validRows();
      const projected = valid.length + deltaValid;
      if (projected <= MAX_MEMORIES) return { ok: true, evict: [] };
      const need = projected - MAX_MEMORIES;
      const evict = pickEviction(valid, need);
      if (!evict) return { ok: false };
      return { ok: true, evict };
  }

  /** M10-7.3：落库后执行软归档（设 invalid_at，不硬删除），SQL 与 fallback 共用。
   *  返回附属失败 warning 列表（空数组表示全部成功）。 */
  private applyEviction(evict: MemoryRow[], now: number): MemorySaveWarning[] {
    if (evict.length === 0) return [];
    const warnings: MemorySaveWarning[] = [];
    if (this.db) {
      const upd = this.db.prepare(
        'UPDATE memories SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL',
      );
      for (const r of evict) {
        try {
          upd.run(now, now, r.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn('[memory] eviction failed (non-fatal, main record intact):', msg);
          warnings.push({ code: 'eviction-failed', message: '容量淘汰软归档失败', detail: `${r.id}: ${msg}` });
        }
      }
    } else if (this.fallback) {
      for (const r of evict) {
        const idx = this.fallback.findIndex((m) => m.id === r.id);
        if (idx >= 0) {
          const old = this.fallback[idx];
          this.fallback[idx] = { ...old, invalidAt: now, updatedAt: now };
        }
      }
    }
    return warnings;
  }

  /**
   * C1-F2：FTS 搜索索引同步（DELETE-then-INSERT 幂等，防 rowid 复用冲突）。
   * FTS 是搜索优化层，主记录完整性靠 memories 主表保证——任何 FTS 同步失败
   * 不再只写 console.warn，而是收集为 warning 返回给调用方。
   * 返回空数组表示成功；有元素表示有失败但主记录不受影响。
   */
  private syncFts(rid: number, name: string, content: string, tags: string[]): MemorySaveWarning[] {
    if (!this.db) return [];
    try {
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rid);
      this.db.prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)')
        .run(rid, name, content, tags.join(' '));
      return [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[memory] FTS sync failed (non-fatal, main record intact):', msg);
      return [{ code: 'fts-sync-failed', message: 'FTS 全文索引同步失败', detail: msg }];
    }
  }

  private sortRows(rows: MemoryRow[]): MemoryRow[] {
    return [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      // M10-7a：第二级是「个人记忆优先」——否则新写入的 project 记忆会把
      // user 档（身份/偏好）挤出注入窗口。
      if (a.type !== b.type) return a.type === 'user' ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  private applyPersonaFilter(rows: MemoryRow[], personaTag?: string): MemoryRow[] {
    if (!personaTag) return rows;
    return rows.filter((m) => m.personaTags.includes(personaTag));
  }
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
