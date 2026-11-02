/**
 * 记忆域 · 共享类型与常量（**内部使用**，不扩大门面导出面）
 *
 * 由 src/host/memory-store.ts 机械拆分而来（MemoryStore 巨石重构，设计稿
 * docs/设计稿/MemoryStore-巨石文件重构-20261101.md）。
 * 类型与常量逐字搬运；门面按具名 re-export 转出，导出面仍是 9 值 + 8 类型。
 */
import type { Memory } from '../bot/types';
import type { AuditCrypto } from '../audit-crypto';

// ── 自 src/host/memory-store.ts 原样搬运的类型与常量 ──────────────────────

export type MemoryType = 'user' | 'project';

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
  /**
   * C1 P0-1 / BUG-017：before 快照**存在但解不开**（密钥不对 / 密文损坏）。
   *
   * 原实现里解密失败返回 null，与「本来就没有 before」不可区分 →
   * rollback 走 `deleteMemoryRow` 分支 → **本该恢复的操作变成静默删除**。
   * 现在显式标记，rollback 据此**拒绝操作并报错**（fail-closed）。
   */
  beforeUndecryptable?: boolean;
  /** 同上：after 快照存在但解不开。 */
  afterUndecryptable?: boolean;
}

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

export interface MemorySaveWarning {
  readonly code: 'fts-sync-failed' | 'eviction-failed';
  readonly message: string;
  readonly detail?: string;
}

export interface ExistingGovernanceFields {
  pinned: boolean;
  tags: string[];
  personaTags: string[];
  source?: string;
  confidence?: number;
}

export const MAX_MEMORIES = 500;

/**
 * 域函数共享上下文（**内部类型**，不从 src/host/memory-store 导出）。
 *
 * 字段三类：
 *   - 数据：原 this.<属性>（db / fallback / fallbackCandidates / fallbackLog / storePath / workspaceId / audit）；
 *   - 注入槽：save / remove / recordLog（设计稿 D7，打破审计↔存储、候选↔存储的环）；
 *   - 跨域委托：仅 6 个——forgetAudit / snapshotById / deleteMemoryRow / writeSnapshotRow /
 *     insertCandidateRow / validRows（同域调用一律走域内直接调用，不进 ctx）。
 *
 * 装配在门面 ctor 内一次性完成；数据字段用 getter，与 this.<属性> 保持同步。
 */
  /**
   * 域函数共享上下文（**内部类型**，不从 src/host/memory-store 导出）。
   *
   * 字段三类：
   *   - 数据：原 this.<属性>（db / fallback / fallbackCandidates / fallbackLog / storePath / workspaceId / audit）；
   *   - 注入槽：save / remove / recordLog（设计稿 D7，打破审计↔存储、候选↔存储的环）；
   *   - 跨域委托：仅 6 个——forgetAudit / snapshotById / deleteMemoryRow / writeSnapshotRow /
   *     insertCandidateRow / validRows（同域调用一律走域内直接调用，不进 ctx）。
   *
   * 委托槽的签名**必须与原 MemoryStore 方法逐字一致**（R3 只允许 this.→ctx.，
   * 参数个数/默认值都不能变）——故这里按原签名书写。
   */
export type StoreContext = {
  db: import('node:sqlite').DatabaseSync | null;
  fallback: MemoryRow[] | null;
  fallbackCandidates: MemoryCandidate[];
  fallbackLog: MemoryLogEntry[];
  readonly storePath: string;
  readonly workspaceId: string;
  audit: AuditCrypto;
  save: (params: SaveMemoryParams) => SaveMemoryResult;
  remove: (id: string, opts?: { forget?: boolean }) => boolean;
  recordLog: (
    op: string,
    memoryId: string | null,
    before: MemoryRow | null,
    after: MemoryRow | null,
    actor?: string | null,
    note?: string | null,
  ) => void;
  forgetAudit: (id: string) => void;
  snapshotById: (id: string) => MemoryRow | null;
  deleteMemoryRow: (id: string) => void;
  writeSnapshotRow: (row: MemoryRow) => void;
  insertCandidateRow: (candidate: MemoryCandidate) => void;
  validRows: () => MemoryRow[];
};
