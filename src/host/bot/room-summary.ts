/**
 * RoomSummaryService（v0.26 聊天室数据层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 RoomSummaryService（Claude 锁定）。
 *
 * 借鉴 Ekko Studio 的 room-summary.ts：
 *   - 租约 + CAS：claimRoomSummaryRun（租约）+ commitRoomSummaryRun（CAS 提交），
 *     防止并发摘要互相覆盖；
 *   - 过期恢复：recoverExpiredLease 让过期租约可被新 run 接管。
 *
 * 复用 SnapshotStore（chat_snapshots 表，与 ContextEngine 共享同一连接）。
 * summaryEveryTurns 控制触发节奏：调用方可用 shouldSummarize 判断是否到期。
 */

import * as crypto from 'node:crypto';
import type { ChatMessageStore, ChatSummarizer, RoomSummaryService } from './types';
import type { MemoryStore } from '../memory-store';
import { SnapshotStore, messagesAfter, defaultStubSummarizer } from './context-engine';

export class SqliteRoomSummaryService implements RoomSummaryService {
  private readonly store: ChatMessageStore;
  private readonly snapshots: SnapshotStore;
  private readonly summarizer: ChatSummarizer;
  private readonly leaseMs: number;
  private readonly summaryEveryTurns: number;

  constructor(opts: {
    messageStore: ChatMessageStore;
    memoryStore: MemoryStore;
    summarizer?: ChatSummarizer;
    snapshots?: SnapshotStore;
    config?: { leaseMs?: number; summaryEveryTurns?: number };
  }) {
    this.store = opts.messageStore;
    this.snapshots = opts.snapshots ?? new SnapshotStore(opts.memoryStore);
    this.summarizer = opts.summarizer ?? defaultStubSummarizer;
    this.leaseMs = opts.config?.leaseMs ?? 60_000;
    this.summaryEveryTurns = opts.config?.summaryEveryTurns ?? 1;
  }

  getSummary(roomId: string) {
    return this.snapshots.get(roomId);
  }

  /** 是否到期：快照之后的新消息数 >= summaryEveryTurns。供调用方判断后再调 summarize。 */
  shouldSummarize(roomId: string): boolean {
    const snap = this.snapshots.get(roomId);
    const all = this.store.getMessages(roomId);
    const pending = snap && snap.lastMessageId ? messagesAfter(all, snap.lastMessageId) : all;
    return pending.length >= this.summaryEveryTurns;
  }

  async summarize(roomId: string): Promise<void> {
    const now = Date.now();
    this.snapshots.recoverExpiredLease(roomId, now);

    // 触发节奏：未到期直接跳过（不占用租约）。
    if (!this.shouldSummarize(roomId)) return;

    const token = `lease-${roomId}-${now}-${crypto.randomBytes(3).toString('hex')}`;
    const claimed = this.snapshots.claim(roomId, token, now, this.leaseMs);
    if (!claimed) return; // 租约被他人持有 → 不覆盖，直接放弃本次

    const all = this.store.getMessages(roomId);
    const base = claimed.lastMessageId ? messagesAfter(all, claimed.lastMessageId) : all;
    if (base.length === 0) {
      this.snapshots.release(roomId, token);
      return;
    }

    try {
      const raw = await this.summarizer(base);
      const baseSummary = claimed.lastMessageId ? claimed.summary : '';
      const newSummary = baseSummary ? `${baseSummary}\n${raw}` : raw;
      const last = base[base.length - 1];
      const ok = this.snapshots.commit(
        roomId,
        newSummary,
        last.id,
        last.timestamp,
        (claimed.summarizedTurnCount ?? 0) + 1,
        claimed.version,
        token,
        Date.now(),
      );
      // ok=false：CAS 校验失败（期间快照被并发更新），静默放弃，不覆盖。
      if (!ok) this.snapshots.release(roomId, token);
    } catch {
      this.snapshots.release(roomId, token);
    }
  }
}
