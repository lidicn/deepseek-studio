/**
 * ContextEngine（v0.26 聊天室数据层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 ContextEngine / ChatContext / ChatContextSnapshot
 * / ChatSummarizer / PersonaInjector（Claude 锁定）。
 *
 * 借鉴 Ekko Studio 的 context-engine/compressor.ts：
 *   - 快照机制：每房间 {summary, lastMessageId}，已摘要旧消息不重复传；
 *   - 增量压缩：只压缩快照之后的新消息，避免全量重算；
 *   - per-room 压缩锁：串行化同房间压缩，防并发快照覆盖。
 *
 * 复用 MemoryStore 的 SQLite 连接（chat_snapshots 表），降级模式走内存 Map。
 * 摘要器以可注入 ChatSummarizer 形式提供，v0.26 用桩，v0.27 由 Claude 接真实模型。
 */

import type {
  ChatContext,
  ChatContextSnapshot,
  ChatMessage,
  ChatMessageStore,
  ChatSummarizer,
  ContextEngine,
  PersonaInjector,
} from './types';
import type { MemoryStore } from '../memory-store';

type Db = import('node:sqlite').DatabaseSync;

/** 默认 token 估算：字符数 / 4（英文启发式，对中文偏保守，可注入更精确估算器）。 */
export function defaultTokenEstimator(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * v0.26 桩摘要器：返回可识别固定串（含消息数与首尾 id），便于测试断言调用次数与范围。
 * 真实摘要（接 ModelEngine / agent-prompt）由 Claude v0.27 接入。
 */
export function defaultStubSummarizer(messages: ReadonlyArray<ChatMessage>): Promise<string> {
  const first = messages[0]?.id ?? '';
  const last = messages[messages.length - 1]?.id ?? '';
  return Promise.resolve(`[stub-summary:${messages.length}msgs:${first}..${last}]`);
}

/** chat_snapshots 内部行（含 CAS 租约字段，不暴露给契约）。 */
interface SnapshotRow {
  roomId: string;
  summary: string;
  lastMessageId: string;
  lastMessageTimestamp: number;
  summarizedTurnCount: number;
  version: number;
  status: ChatContextSnapshot['status'];
  updatedAt: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
}

function rowToSnapshot(r: SnapshotRow): ChatContextSnapshot {
  return {
    roomId: r.roomId,
    summary: r.summary,
    lastMessageId: r.lastMessageId,
    lastMessageTimestamp: r.lastMessageTimestamp,
    summarizedTurnCount: r.summarizedTurnCount,
    version: r.version,
    status: r.status,
    updatedAt: r.updatedAt,
  };
}

/**
 * 快照持久化：读 / 写（CAS 版本校验）/ 租约（claim-commit-recover）。
 * 同时被 ContextEngine 与 RoomSummaryService 复用（同一张 chat_snapshots 表）。
 */
export class SnapshotStore {
  private readonly db: Db | null;
  private readonly mem = new Map<string, SnapshotRow>();

  constructor(memoryStore: MemoryStore) {
    this.db = memoryStore.getDb();
    if (this.db) this.ensureSchema(this.db);
  }

  private ensureSchema(db: Db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_snapshots (
        room_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL DEFAULT '',
        last_message_id TEXT NOT NULL DEFAULT '',
        last_message_timestamp INTEGER NOT NULL DEFAULT 0,
        summarized_turn_count INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        updated_at INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_expires_at INTEGER
      );
    `);
  }

  /** 读取房间快照（不含租约字段），无则 null。 */
  get(roomId: string): ChatContextSnapshot | null {
    const row = this.load(roomId);
    return row ? rowToSnapshot(row) : null;
  }

  private load(roomId: string): SnapshotRow | null {
    if (this.db) {
      const r = this.db
        .prepare(
          'SELECT room_id, summary, last_message_id, last_message_timestamp, summarized_turn_count, version, status, updated_at, lease_token, lease_expires_at FROM chat_snapshots WHERE room_id = ?',
        )
        .get(roomId) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        roomId: String(r.room_id),
        summary: String(r.summary ?? ''),
        lastMessageId: String(r.last_message_id ?? ''),
        lastMessageTimestamp: Number(r.last_message_timestamp ?? 0),
        summarizedTurnCount: Number(r.summarized_turn_count ?? 0),
        version: Number(r.version ?? 0),
        status: (r.status as ChatContextSnapshot['status']) ?? 'idle',
        updatedAt: Number(r.updated_at ?? 0),
        leaseToken: typeof r.lease_token === 'string' ? r.lease_token : null,
        leaseExpiresAt: typeof r.lease_expires_at === 'number' ? r.lease_expires_at : null,
      };
    }
    return this.mem.get(roomId) ? { ...(this.mem.get(roomId) as SnapshotRow) } : null;
  }

  /**
   * CAS 写入：仅当当前行 version === expectedVersion 时落新快照并 version+1。
   * expectedVersion===0 且无行时执行首次插入（version=1）。返回是否写入成功。
   */
  saveIfCurrent(snapshot: ChatContextSnapshot, expectedVersion: number): boolean {
    if (this.db) {
      const res = this.db
        .prepare(
          `UPDATE chat_snapshots SET summary = ?, last_message_id = ?, last_message_timestamp = ?,
             summarized_turn_count = ?, status = ?, updated_at = ?, version = version + 1
             WHERE room_id = ? AND version = ?`,
        )
        .run(
          snapshot.summary,
          snapshot.lastMessageId,
          snapshot.lastMessageTimestamp,
          snapshot.summarizedTurnCount,
          snapshot.status,
          snapshot.updatedAt,
          snapshot.roomId,
          expectedVersion,
        );
      if ((res.changes ?? 0) > 0) return true;
      if (expectedVersion === 0) {
        try {
          this.db
            .prepare(
              `INSERT INTO chat_snapshots (room_id, summary, last_message_id, last_message_timestamp,
                 summarized_turn_count, version, status, updated_at)
                 VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              snapshot.roomId,
              snapshot.summary,
              snapshot.lastMessageId,
              snapshot.lastMessageTimestamp,
              snapshot.summarizedTurnCount,
              snapshot.status,
              snapshot.updatedAt,
            );
          return true;
        } catch {
          return false; // 并发首插冲突
        }
      }
      return false;
    }
    // 降级：内存 CAS
    const cur = this.mem.get(snapshot.roomId);
    const curVersion = cur?.version ?? 0;
    if (curVersion !== expectedVersion) return false;
    this.mem.set(snapshot.roomId, { ...toRow(snapshot) });
    return true;
  }

  /** 尝试获取摘要租约；返回被 claim 时的当前快照（失败返回 null）。 */
  claim(roomId: string, token: string, now: number, leaseMs: number): ChatContextSnapshot | null {
    const cur = this.load(roomId);
    if (cur && cur.status === 'summarizing' && cur.leaseExpiresAt != null && cur.leaseExpiresAt > now) {
      return null; // 租约仍有效
    }
    if (this.db) {
      if (cur) {
        this.db
          .prepare(
            "UPDATE chat_snapshots SET status = 'summarizing', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE room_id = ?",
          )
          .run(token, now + leaseMs, now, roomId);
      } else {
        this.db
          .prepare(
            `INSERT INTO chat_snapshots (room_id, summary, last_message_id, last_message_timestamp,
               summarized_turn_count, version, status, updated_at, lease_token, lease_expires_at)
             VALUES (?, '', '', 0, 0, 0, 'summarizing', ?, ?, ?)`,
          )
          .run(roomId, now, token, now + leaseMs);
      }
      return this.get(roomId);
    }
    const base = cur ?? {
      roomId,
      summary: '',
      lastMessageId: '',
      lastMessageTimestamp: 0,
      summarizedTurnCount: 0,
      version: 0,
      status: 'idle' as const,
      updatedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    this.mem.set(roomId, { ...base, status: 'summarizing', leaseToken: token, leaseExpiresAt: now + leaseMs, updatedAt: now });
    return this.get(roomId);
  }

  /**
   * CAS 提交：仅当 version===expectedVersion 且租约由 token 持有时，落新摘要并 version+1，
   * 清空租约，status='success'。返回是否成功。
   */
  commit(
    roomId: string,
    summary: string,
    throughId: string,
    throughTs: number,
    turnCount: number,
    expectedVersion: number,
    token: string,
    now: number,
  ): boolean {
    if (this.db) {
      const res = this.db
        .prepare(
          `UPDATE chat_snapshots SET summary = ?, last_message_id = ?, last_message_timestamp = ?,
             summarized_turn_count = ?, status = 'success', lease_token = NULL, lease_expires_at = NULL,
             version = version + 1, updated_at = ?
             WHERE room_id = ? AND version = ? AND lease_token = ?`,
        )
        .run(summary, throughId, throughTs, turnCount, now, roomId, expectedVersion, token);
      return (res.changes ?? 0) > 0;
    }
    const cur = this.mem.get(roomId);
    if (!cur || cur.version !== expectedVersion || cur.leaseToken !== token) return false;
    this.mem.set(roomId, {
      ...cur,
      summary,
      lastMessageId: throughId,
      lastMessageTimestamp: throughTs,
      summarizedTurnCount: turnCount,
      status: 'success',
      leaseToken: null,
      leaseExpiresAt: null,
      version: cur.version + 1,
      updatedAt: now,
    });
    return true;
  }

  /** 放弃租约（摘要失败时），仅在 token 匹配时释放。 */
  release(roomId: string, token: string): void {
    if (this.db) {
      this.db
        .prepare("UPDATE chat_snapshots SET status = 'idle', lease_token = NULL, lease_expires_at = NULL WHERE room_id = ? AND lease_token = ?")
        .run(roomId, token);
      return;
    }
    const cur = this.mem.get(roomId);
    if (cur && cur.leaseToken === token) {
      this.mem.set(roomId, { ...cur, status: 'idle', leaseToken: null, leaseExpiresAt: null });
    }
  }

  /** 接管过期租约（status='summarizing' 且租约已过期）。返回是否恢复。 */
  recoverExpiredLease(roomId: string, now: number): boolean {
    const cur = this.load(roomId);
    if (!cur || cur.status !== 'summarizing') return false;
    if (cur.leaseExpiresAt != null && cur.leaseExpiresAt > now) return false;
    if (this.db) {
      this.db
        .prepare("UPDATE chat_snapshots SET status = 'idle', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE room_id = ?")
        .run(now, roomId);
      return true;
    }
    this.mem.set(roomId, { ...cur, status: 'idle', leaseToken: null, leaseExpiresAt: null, updatedAt: now });
    return true;
  }
}

function toRow(s: ChatContextSnapshot): SnapshotRow {
  return { ...s, leaseToken: null, leaseExpiresAt: null };
}

/** 基于快照 + 增量压缩的 ContextEngine 实现。 */
export class SqliteContextEngine implements ContextEngine {
  private readonly store: ChatMessageStore;
  private readonly snapshots: SnapshotStore;
  private readonly summarizer: ChatSummarizer;
  private readonly triggerTokens: number;
  private readonly estimateTokens: (text: string) => number;
  /** verbatim 硬窗口上限：快照之后最多保留多少条最近消息（防长对话炸上下文）。 */
  private readonly maxVerbatimMessages: number;
  /** verbatim 硬 token 上限（估算）。默认 Infinity = 不按 token 截断。 */
  private readonly maxVerbatimTokens: number;
  /** per-room 压缩锁：串行化同房间压缩。 */
  private readonly compressLocks = new Map<string, Promise<unknown>>();

  constructor(opts: {
    messageStore: ChatMessageStore;
    memoryStore: MemoryStore;
    summarizer?: ChatSummarizer;
    config?: { triggerTokens?: number; tokenEstimator?: (text: string) => number; maxVerbatimMessages?: number; maxVerbatimTokens?: number };
  }) {
    this.store = opts.messageStore;
    this.snapshots = new SnapshotStore(opts.memoryStore);
    this.summarizer = opts.summarizer ?? defaultStubSummarizer;
    this.triggerTokens = opts.config?.triggerTokens ?? 4000;
    this.estimateTokens = opts.config?.tokenEstimator ?? defaultTokenEstimator;
    this.maxVerbatimMessages = opts.config?.maxVerbatimMessages ?? 200;
    this.maxVerbatimTokens = opts.config?.maxVerbatimTokens ?? Number.POSITIVE_INFINITY;
  }

  getSnapshot(roomId: string): ChatContextSnapshot | null {
    return this.snapshots.get(roomId);
  }

  async buildContext(input: {
    roomId: string;
    agentName: string;
    currentMessageId: string;
    personaInjector?: PersonaInjector;
    roomName?: string;
    agentDescription?: string;
    memberNames?: readonly string[];
  }): Promise<ChatContext> {
    const { roomId, currentMessageId, personaInjector } = input;
    const all = this.store.getMessages(roomId, { throughMessageId: currentMessageId });
    const totalMessages = all.length;

    const snapshot = this.snapshots.get(roomId);
    const hadSnapshot = snapshot !== null;

    const verbatim = snapshot ? messagesAfter(all, snapshot.lastMessageId) : all;
    const summaryText = snapshot?.summary ?? '';

    const tokens = this.estimateTokens(summaryText) + verbatim.reduce((s, m) => s + this.estimateTokens(m.content), 0);

    let compressed = false;
    if (tokens > this.triggerTokens && verbatim.length > 0) {
      compressed = await this.withCompressLock(roomId, () => this.compress(roomId, all));
      // 压缩后按最新快照重算 verbatim / summary（锁内可能已由他人更新）
    }

    const cur = this.snapshots.get(roomId);
    const finalSummary = cur?.summary ?? summaryText;
    let finalVerbatim = cur ? messagesAfter(all, cur.lastMessageId) : all;

    // B1：硬窗口截断——verbatim 超过上限时只保留最近 N 条（上一轮摘要已在上层保留）。
    if (finalVerbatim.length > this.maxVerbatimMessages) {
      finalVerbatim = finalVerbatim.slice(finalVerbatim.length - this.maxVerbatimMessages);
    }
    if (Number.isFinite(this.maxVerbatimTokens)) {
      let vt = finalVerbatim.reduce((s, m) => s + this.estimateTokens(m.content), 0);
      while (finalVerbatim.length > 1 && vt > this.maxVerbatimTokens) {
        finalVerbatim = finalVerbatim.slice(1);
        vt = finalVerbatim.reduce((s, m) => s + this.estimateTokens(m.content), 0);
      }
    }

    return this.buildResult(finalSummary, finalVerbatim, {
      totalMessages,
      hadSnapshot,
      compressed,
      personaInjector,
      input,
    });
  }

  /** 压缩：读最新快照 → 取其后新消息 → 调 summarizer → CAS 写回。返回是否发生压缩。 */
  private async compress(roomId: string, all: ChatMessage[]): Promise<boolean> {
    const cur = this.snapshots.get(roomId);
    const base = cur ? messagesAfter(all, cur.lastMessageId) : all;
    const baseSummary = cur?.summary ?? '';
    if (base.length === 0) return false; // 无新消息可压（并发下常见），不调 summarizer

    const raw = await this.summarizer(base);
    const newSummary = baseSummary ? `${baseSummary}\n${raw}` : raw;
    const last = base[base.length - 1];
    const now = Date.now();
    return this.snapshots.saveIfCurrent(
      {
        roomId,
        summary: newSummary,
        lastMessageId: last.id,
        lastMessageTimestamp: last.timestamp,
        summarizedTurnCount: (cur?.summarizedTurnCount ?? 0) + 1,
        version: (cur?.version ?? 0) + 1,
        status: 'success',
        updatedAt: now,
      },
      cur?.version ?? 0,
    );
  }

  private withCompressLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.compressLocks.get(roomId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.compressLocks.set(roomId, run.catch(() => undefined));
    return run;
  }

  private buildResult(
    summary: string,
    verbatim: ChatMessage[],
    ctx: {
      totalMessages: number;
      hadSnapshot: boolean;
      compressed: boolean;
      personaInjector?: PersonaInjector;
      input: { agentName: string; roomName?: string; agentDescription?: string; memberNames?: readonly string[] };
    },
  ): ChatContext {
    const systemPrompt = ctx.personaInjector
      ? ctx.personaInjector({
          agentName: ctx.input.agentName,
          roomName: ctx.input.roomName ?? '',
          agentDescription: ctx.input.agentDescription ?? '',
          memberNames: ctx.input.memberNames ?? [],
          summary,
        })
      : summary;
    const messages = verbatim.map((m): { role: 'user' | 'assistant'; content: string } => ({
      role: m.senderType === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));
    return {
      systemPrompt,
      messages,
      meta: {
        totalMessages: ctx.totalMessages,
        verbatimCount: messages.length,
        hadSnapshot: ctx.hadSnapshot,
        compressed: ctx.compressed,
      },
    };
  }
}

/** 取某列表中 lastMessageId 之后的消息（不含该消息）；找不到则返回全部。 */
export function messagesAfter(all: ChatMessage[], lastMessageId: string): ChatMessage[] {
  if (!lastMessageId) return all;
  const idx = all.findIndex((m) => m.id === lastMessageId);
  return idx >= 0 ? all.slice(idx + 1) : all;
}
