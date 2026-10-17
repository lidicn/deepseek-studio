/**
 * v0.26 验收测试：ContextEngine（快照 + 增量压缩 + per-room 锁）
 *
 * 验收标准（路线图 §2.7 + 回复单）：
 * - 有快照且不超阈值 → 返回 summary + 新消息，不调 summarizer
 * - 第二次 buildContext → 不重算已摘要部分
 * - 超阈值 → 调 summarizer，快照 version+1
 * - 并发 buildContext 同房间 → 压缩锁生效（summarizer 只调一次）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../../src/host/memory-store';
import { SqliteChatMessageStore } from '../../src/host/bot/chat-room-store';
import { SqliteContextEngine } from '../../src/host/bot/context-engine';
import type { ChatMessage, ChatSummarizer } from '../../src/host/bot/types';

let tmpDir: string;
let tmpDb: string;
let memStore: MemoryStore | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ctx-'));
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

/** 计数型摘要器，记录每次调用收到的消息范围。 */
function makeCountingSummarizer(): { summarizer: ChatSummarizer; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const summarizer: ChatSummarizer = (msgs) => {
    calls.push([...msgs]);
    return Promise.resolve(`SUM(${msgs.length})`);
  };
  return { summarizer, calls };
}

function setup(opts?: { triggerTokens?: number }) {
  memStore = new MemoryStore(tmpDb);
  const messageStore = new SqliteChatMessageStore(memStore);
  const { summarizer, calls } = makeCountingSummarizer();
  const engine = new SqliteContextEngine({
    messageStore,
    memoryStore: memStore,
    summarizer,
    config: { triggerTokens: opts?.triggerTokens ?? 1 },
  });
  return { messageStore, engine, calls };
}

function seed(messageStore: SqliteChatMessageStore, room: string, n: number, offset = 0): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      messageStore.append({
        roomId: room,
        senderId: i % 2 === 0 ? 'u1' : 'bot-1',
        senderType: i % 2 === 0 ? 'user' : 'main-bot',
        content: `m${offset + i}`,
        timestamp: offset + i + 1,
        mentions: [],
      }),
    );
  }
  return out;
}

describe('ContextEngine', () => {
  it('无快照且不超阈值 → 全量返回，不调 summarizer', async () => {
    const { messageStore, engine, calls } = setup({ triggerTokens: 4000 });
    const msgs = seed(messageStore, 'r1', 3);
    const ctx = await engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: msgs[2].id });
    expect(calls).toHaveLength(0);
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.systemPrompt).toBe('');
    expect(ctx.meta).toEqual({ totalMessages: 3, verbatimCount: 3, hadSnapshot: false, compressed: false });
    expect(engine.getSnapshot('r1')).toBeNull();
  });

  it('超阈值 → 调 summarizer，快照 version+1，verbatim 归零', async () => {
    const { messageStore, engine, calls } = setup({ triggerTokens: 1 });
    const msgs = seed(messageStore, 'r1', 3);
    const ctx = await engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: msgs[2].id });
    expect(calls).toHaveLength(1);
    expect(calls[0].map((m) => m.id)).toEqual(msgs.map((m) => m.id));
    expect(ctx.meta.compressed).toBe(true);
    expect(ctx.messages).toHaveLength(0);
    expect(ctx.systemPrompt).toContain('SUM(3)');
    const snap = engine.getSnapshot('r1');
    expect(snap?.version).toBe(1);
    expect(snap?.status).toBe('success');
  });

  it('第二次 buildContext → 不重算已摘要部分（summarizer 不再调用）', async () => {
    const { messageStore, engine, calls } = setup({ triggerTokens: 1 });
    const msgs = seed(messageStore, 'r1', 3);
    await engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: msgs[2].id });
    expect(calls).toHaveLength(1);
    const ctx2 = await engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: msgs[2].id });
    expect(calls).toHaveLength(1); // 不重算
    expect(ctx2.messages).toHaveLength(0);
    expect(ctx2.meta.hadSnapshot).toBe(true);
    expect(ctx2.meta.compressed).toBe(false);
  });

  it('增量压缩：只压缩快照之后的新消息，摘要累加，version+1', async () => {
    const { messageStore, engine, calls } = setup({ triggerTokens: 1 });
    const first = seed(messageStore, 'r1', 3);
    await engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: first[2].id });
    const more = seed(messageStore, 'r1', 2, 100); // 两条新消息
    const ctx = await engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: more[1].id });
    expect(calls).toHaveLength(2);
    // 第二次摘要只收到新消息（不含已摘要的前 3 条）
    expect(calls[1].map((m) => m.id)).toEqual(more.map((m) => m.id));
    expect(ctx.systemPrompt).toContain('SUM(3)');
    expect(ctx.systemPrompt).toContain('SUM(2)');
    expect(engine.getSnapshot('r1')?.version).toBe(2);
  });

  it('并发 buildContext 同房间 → 压缩锁生效，summarizer 只调一次', async () => {
    const { messageStore, engine, calls } = setup({ triggerTokens: 1 });
    const msgs = seed(messageStore, 'r1', 4);
    await Promise.all([
      engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: msgs[3].id }),
      engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: msgs[3].id }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('personaInjector 钩子：systemPrompt 由注入器生成并收到 summary', async () => {
    const { messageStore, engine } = setup({ triggerTokens: 1 });
    const msgs = seed(messageStore, 'r1', 2);
    await engine.buildContext({ roomId: 'r1', agentName: 'audit-expert', currentMessageId: msgs[1].id });
    let received: { agentName: string; summary: string } | null = null;
    const ctx = await engine.buildContext({
      roomId: 'r1',
      agentName: 'audit-expert',
      currentMessageId: msgs[1].id,
      personaInjector: (c) => {
        received = { agentName: c.agentName, summary: c.summary };
        return `[persona] ${c.summary}`;
      },
    });
    expect(ctx.systemPrompt).toContain('[persona]');
    expect(ctx.systemPrompt).toContain('SUM(2)');
    expect(received).toEqual({ agentName: 'audit-expert', summary: 'SUM(2)' });
  });

  it('B1: 超过 maxVerbatimMessages 时只保留最近窗口，上一轮摘要保留', async () => {
    memStore = new MemoryStore(tmpDb);
    const messageStore = new SqliteChatMessageStore(memStore);
    const { summarizer, calls } = makeCountingSummarizer();
    // 阶段1：低阈值引擎先产一份摘要（覆盖前 3 条）
    const e1 = new SqliteContextEngine({ messageStore, memoryStore: memStore, summarizer, config: { triggerTokens: 1 } });
    const first = seed(messageStore, 'r1', 3);
    await e1.buildContext({ roomId: 'r1', agentName: 'a', currentMessageId: first[2].id });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    // 阶段2：高阈值（不触发压缩）+ 小窗口，再写 5 条 → 不摘要，但窗口截断到最近 2 条；上一轮摘要保留
    const e2 = new SqliteContextEngine({ messageStore, memoryStore: memStore, summarizer, config: { triggerTokens: 1_000_000, maxVerbatimMessages: 2 } });
    const more = seed(messageStore, 'r1', 5, 100);
    const ctx = await e2.buildContext({ roomId: 'r1', agentName: 'a', currentMessageId: more[4].id, personaInjector: (c) => c.summary });
    expect(calls).toHaveLength(1); // 阶段2 未再摘要
    expect(ctx.messages).toHaveLength(2); // 仅最近 2 条
    expect(ctx.systemPrompt).toContain('SUM(3)'); // 上一轮摘要仍在
    expect(ctx.meta.hadSnapshot).toBe(true);
  });
});
