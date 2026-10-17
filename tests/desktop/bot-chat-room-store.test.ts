/**
 * v0.26 验收测试：ChatMessageStore（消息存储 + 范围查询 + 降级）
 *
 * 验收标准（路线图 §2.7 + 回复单）：
 * - append 返回的 id 符合 `msg-` 前缀格式
 * - getMessages 按 throughMessageId 范围正确
 * - 降级模式下 append/getMessages 仍工作
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from '../../src/host/memory-store';
import { SqliteChatMessageStore, generateMessageId } from '../../src/host/bot/chat-room-store';
import type { MemoryStore as MemoryStoreType } from '../../src/host/memory-store';

let tmpDir: string;
let tmpDb: string;
let lastMem: MemoryStore | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-chat-'));
  tmpDb = path.join(tmpDir, 'memories.db');
  lastMem = undefined;
});

afterEach(() => {
  // 关闭本测试的连接；清理临时文件。删除可能被运行环境拦截（EPERM），容错忽略。
  try {
    lastMem?.getDb()?.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('ChatMessageStore - SQLite 模式', () => {
  function makeStore(): SqliteChatMessageStore {
    lastMem = new MemoryStore(tmpDb);
    return new SqliteChatMessageStore(lastMem);
  }

  it('append 返回的消息 id 符合 msg-<base36>-<6位随机> 格式', () => {
    const store = makeStore();
    const msg = store.append({
      roomId: 'r1',
      senderId: 'u1',
      senderType: 'user',
      content: 'hello',
      timestamp: 1000,
      mentions: [],
    });
    expect(msg.id).toMatch(/^msg-[0-9a-z]+-[0-9a-z]{6}$/);
    expect(generateMessageId()).toMatch(/^msg-[0-9a-z]+-[0-9a-z]{6}$/);
  });

  it('getMessages 返回已存消息', () => {
    const store = makeStore();
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: 'a', timestamp: 1, mentions: [] });
    const got = store.getMessages('r1');
    expect(got).toHaveLength(1);
    expect(got[0].content).toBe('a');
  });

  it('getMessages 按 throughMessageId 取范围（含端点）', () => {
    const store = makeStore();
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '1', timestamp: 1, mentions: [] });
    const m2 = store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '2', timestamp: 2, mentions: [] });
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '3', timestamp: 3, mentions: [] });
    const range = store.getMessages('r1', { throughMessageId: m2.id });
    expect(range.map((m) => m.content)).toEqual(['1', '2']);
  });

  it('getMessages 的 limit 截断尾部（保留最近 N 条）', () => {
    const store = makeStore();
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '1', timestamp: 1, mentions: [] });
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '2', timestamp: 2, mentions: [] });
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '3', timestamp: 3, mentions: [] });
    const recent = store.getMessages('r1', { limit: 2 });
    expect(recent.map((m) => m.content)).toEqual(['2', '3']);
  });

  it('count 返回房间消息总数', () => {
    const store = makeStore();
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '1', timestamp: 1, mentions: [] });
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '2', timestamp: 2, mentions: [] });
    store.append({ roomId: 'r2', senderId: 'u1', senderType: 'user', content: 'x', timestamp: 1, mentions: [] });
    expect(store.count('r1')).toBe(2);
    expect(store.count('r2')).toBe(1);
  });

  it('mentions 往返序列化正确', () => {
    const store = makeStore();
    store.append({
      roomId: 'r1',
      senderId: 'u1',
      senderType: 'user',
      content: '@前端专家 看',
      timestamp: 1,
      mentions: [{ type: 'agent', participantId: '前端专家' }],
    });
    const got = store.getMessages('r1');
    expect(got[0].mentions).toEqual([{ type: 'agent', participantId: '前端专家' }]);
  });
});

describe('ChatMessageStore - 内存降级模式', () => {
  function makeFallbackStore(): SqliteChatMessageStore {
    const stub = { getDb: () => null, isInMemoryFallback: () => true } as unknown as MemoryStoreType;
    return new SqliteChatMessageStore(stub);
  }

  it('降级模式 append/getMessages/count 仍能工作', () => {
    const store = makeFallbackStore();
    const m = store.append({ roomId: 'r1', senderId: 'u1', senderType: 'sub-bot', content: 'hi', timestamp: 5, mentions: [{ type: 'all' }] });
    expect(m.id).toMatch(/^msg-/);
    expect(store.count('r1')).toBe(1);
    const got = store.getMessages('r1');
    expect(got[0].content).toBe('hi');
    expect(got[0].mentions).toEqual([{ type: 'all' }]);
  });

  it('降级模式按 throughMessageId 范围正确', () => {
    const store = makeFallbackStore();
    const m1 = store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '1', timestamp: 1, mentions: [] });
    store.append({ roomId: 'r1', senderId: 'u1', senderType: 'user', content: '2', timestamp: 2, mentions: [] });
    const range = store.getMessages('r1', { throughMessageId: m1.id });
    expect(range.map((m) => m.content)).toEqual(['1']);
  });
});
