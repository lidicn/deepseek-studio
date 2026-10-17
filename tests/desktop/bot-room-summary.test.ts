/**
 * v0.26 验收测试：RoomSummaryService（CAS 租约 + 过期恢复）
 *
 * 验收标准（路线图 §2.7 + 回复单）：
 * - RoomSummaryService.summarize 并发调用不覆盖（CAS 验证）
 * - 租约过期后新 summarize 可接管
 * - CAS 版本不匹配 → commit 放弃不覆盖
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../../src/host/memory-store';
import { SqliteChatMessageStore } from '../../src/host/bot/chat-room-store';
import { SqliteRoomSummaryService } from '../../src/host/bot/room-summary';
import { SnapshotStore } from '../../src/host/bot/context-engine';
import type { ChatMessage, ChatSummarizer } from '../../src/host/bot/types';

let tmpDir: string;
let tmpDb: string;
let memStore: MemoryStore | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rs-'));
  tmpDb = path.join(tmpDir, 'memories.db');
  memStore = undefined;
});

afterEach(() => {
  try {
    memStore?.getDb()?.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeCountingSummarizer(): { summarizer: ChatSummarizer; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const summarizer: ChatSummarizer = (msgs) => {
    calls.push([...msgs]);
    return Promise.resolve(`SUM(${msgs.length})`);
  };
  return { summarizer, calls };
}

function setup() {
  memStore = new MemoryStore(tmpDb);
  const messageStore = new SqliteChatMessageStore(memStore);
  const snapshots = new SnapshotStore(memStore);
  const { summarizer, calls } = makeCountingSummarizer();
  const service = new SqliteRoomSummaryService({ messageStore, memoryStore: memStore, summarizer, snapshots });
  return { messageStore, service, snapshots, calls };
}

function seed(messageStore: SqliteChatMessageStore, room: string, n: number, offset = 0): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      messageStore.append({
        roomId: room,
        senderId: 'u1',
        senderType: 'user',
        content: `m${offset + i}`,
        timestamp: offset + i + 1,
        mentions: [],
      }),
    );
  }
  return out;
}

describe('RoomSummaryService', () => {
  it('getSummary 初始为 null', () => {
    const { service } = setup();
    expect(service.getSummary('r1')).toBeNull();
  });

  it('summarize 生成摘要并落快照（version=1）', async () => {
    const { messageStore, service, calls } = setup();
    const msgs = seed(messageStore, 'r1', 3);
    await service.summarize('r1');
    expect(calls).toHaveLength(1);
    const snap = service.getSummary('r1');
    expect(snap?.version).toBe(1);
    expect(snap?.status).toBe('success');
    expect(snap?.summary).toContain('SUM(3)');
    expect(snap?.lastMessageId).toBe(msgs[2].id);
  });

  it('并发 summarize 同房间 → 只一个 commit 成功，不覆盖', async () => {
    const { messageStore, service, calls } = setup();
    seed(messageStore, 'r1', 4);
    await Promise.all([service.summarize('r1'), service.summarize('r1'), service.summarize('r1')]);
    const snap = service.getSummary('r1');
    expect(snap?.version).toBe(1); // 未被并发覆盖成更高版本
    expect(snap?.summary).toContain('SUM(4)');
    expect(calls).toHaveLength(1); // 只有一个 run 真正调用摘要器
  });

  it('租约过期后新 summarize 可接管', async () => {
    const { messageStore, service, snapshots, calls } = setup();
    seed(messageStore, 'r1', 2);
    // 人为占据一个已过期的租约（leaseMs=1，立刻过期）
    snapshots.claim('r1', 'stale-token', Date.now(), 1);
    await new Promise((r) => setTimeout(r, 10)); // 等租约过期
    await service.summarize('r1');
    const snap = service.getSummary('r1');
    expect(snap?.status).toBe('success');
    expect(snap?.summary).toContain('SUM(2)');
    expect(calls).toHaveLength(1);
  });

  it('CAS 版本不匹配 → commit 放弃，不覆盖', async () => {
    const { messageStore, service, snapshots } = setup();
    const msgs = seed(messageStore, 'r1', 2);
    await service.summarize('r1');
    const before = service.getSummary('r1');
    expect(before?.version).toBe(1);
    // 用错误的 expectedVersion 与 token 直接 commit → 应失败且不改快照
    const ok = snapshots.commit('r1', 'HACK', 'x', 999, 99, 999, 'wrong-token', Date.now());
    expect(ok).toBe(false);
    const after = service.getSummary('r1');
    expect(after?.version).toBe(1);
    expect(after?.summary).toBe(before?.summary);
    expect(after?.lastMessageId).toBe(msgs[1].id);
  });

  it('增量：已有摘要时只摘要新消息并累加', async () => {
    const { messageStore, service, calls } = setup();
    seed(messageStore, 'r1', 2);
    await service.summarize('r1');
    seed(messageStore, 'r1', 3, 10); // 再 3 条新消息（timestamp 11..13）
    await service.summarize('r1');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(3); // 第二次只摘要新消息
    const snap = service.getSummary('r1');
    expect(snap?.version).toBe(2);
    expect(snap?.summary).toContain('SUM(2)');
    expect(snap?.summary).toContain('SUM(3)');
  });

  it('B2: shouldSummarize 按 summaryEveryTurns 阈值返回', async () => {
    memStore = new MemoryStore(tmpDb);
    const messageStore = new SqliteChatMessageStore(memStore);
    const { summarizer } = makeCountingSummarizer();
    const service = new SqliteRoomSummaryService({ messageStore, memoryStore: memStore, summarizer, config: { summaryEveryTurns: 2 } });
    seed(messageStore, 'r1', 1);
    expect(service.shouldSummarize('r1')).toBe(false); // pending=1 < 2
    seed(messageStore, 'r1', 1, 10);
    expect(service.shouldSummarize('r1')).toBe(true); // pending=2 >= 2
    await service.summarize('r1');
    seed(messageStore, 'r1', 1, 20);
    expect(service.shouldSummarize('r1')).toBe(false); // 刚摘要完，pending 重置为 1
  });
});
