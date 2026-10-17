import { describe, expect, it } from 'vitest';

import { createHistoryStore } from '../../src/host/kernel/history-store';
import type { PersistedLoopState } from '../../src/host/kernel/history-store';

/** 内存 read/write：write 写入闭包变量，read 读回。 */
function makeMemoryStore() {
  let buf: string | null = null;
  const store = createHistoryStore({
    read: async () => buf,
    write: async (data: string) => {
      buf = data;
    },
  });
  return { store, get: () => buf };
}

function sampleState(over: Partial<PersistedLoopState> = {}): PersistedLoopState {
  return {
    version: 1,
    round: 2,
    history: {
      version: 1,
      messages: [
        { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      ],
    },
    ...over,
  };
}

describe('HistoryStore（S3 持久化恢复）', () => {
  it('1. save → load 往返一致', async () => {
    const { store } = makeMemoryStore();
    const state = sampleState();
    await store.save(state);
    const back = await store.load();
    expect(back).toEqual(state);
  });

  it('2. 无数据时 load() 返回 null', async () => {
    const { store } = makeMemoryStore();
    expect(await store.load()).toBeNull();
  });

  it('3. 空字符串 load() 返回 null', async () => {
    let buf = '';
    const store = createHistoryStore({
      read: async () => buf,
      write: async () => {},
    });
    expect(await store.load()).toBeNull();
  });

  it('4. load() 遇非法 JSON 抛错', async () => {
    const store = createHistoryStore({
      read: async () => '{not json',
      write: async () => {},
    });
    await expect(store.load()).rejects.toThrow();
  });

  it('5. load() 遇 version:2 抛错（不静默降级）', async () => {
    const store = createHistoryStore({
      read: async () => JSON.stringify({ version: 2, history: { messages: [] }, round: 0 }),
      write: async () => {},
    });
    await expect(store.load()).rejects.toThrow(/版本/);
  });

  it('6. load() 缺 history.messages 抛错', async () => {
    const store = createHistoryStore({
      read: async () => JSON.stringify({ version: 1, round: 0 }),
      write: async () => {},
    });
    await expect(store.load()).rejects.toThrow();
  });

  it('7. load() 缺合法 round 抛错', async () => {
    const store = createHistoryStore({
      read: async () => JSON.stringify({ version: 1, history: { messages: [] }, round: 'x' }),
      write: async () => {},
    });
    await expect(store.load()).rejects.toThrow(/round/);
  });

  it('8. save() 遇 version:2 抛错', async () => {
    const { store } = makeMemoryStore();
    const bad = sampleState({ version: 2 as 1 }) as unknown as PersistedLoopState;
    await expect(store.save(bad)).rejects.toThrow();
  });

  it('9. round 数值被原样持久化与恢复', async () => {
    const { store } = makeMemoryStore();
    await store.save(sampleState({ round: 7 }));
    const back = await store.load();
    expect(back?.round).toBe(7);
  });

  it('10. read/write 支持异步实现', async () => {
    let buf: string | null = null;
    const store = createHistoryStore({
      read: async () => buf,
      write: async (d: string) => {
        buf = d;
      },
    });
    await store.save(sampleState({ round: 3 }));
    const back = await store.load();
    expect(back?.round).toBe(3);
  });
});
