import { describe, expect, it } from 'vitest';
import {
  STUDIO_EXECUTION_INDEX_KEY,
  STUDIO_EXECUTION_MAX_EVENTS,
  STUDIO_EXECUTION_MAX_SESSIONS,
  limitFinalAnswer,
  limitToolPayload,
  normalizeChatSessionKey,
  normalizeSessionKeyFromPathname,
  normalizeRouteSessionKey,
  type StudioExecutionEvent,
} from '../../src/shared/studio-execution';
import {
  createStudioExecutionStore,
  dropLegacyOrphanBodyErrors,
  studioExecutionStorageKey,
  type StudioExecutionKv,
} from '../../src/ui/studio-execution-store';

function memoryKv(): StudioExecutionKv & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async kvGet(key) {
      return values.get(key);
    },
    async kvSet(key, value) {
      values.set(key, structuredClone(value));
    },
    async kvRemove(key) {
      values.delete(key);
    },
  };
}

function store(kv: StudioExecutionKv) {
  return createStudioExecutionStore({
    kv,
    onConnected: () => () => {},
    isConnected: () => true,
  });
}

function userEvent(text: string): StudioExecutionEvent {
  return { type: 'user-message', at: Date.now(), turnId: 'turn-1', text };
}

describe('Studio 执行记录持久化', () => {
  it('会话键优先使用 chat_session_id，路由键规范化作为兜底', () => {
    expect(normalizeChatSessionKey(' abc-1 ')).toBe('chat:abc-1');
    expect(normalizeRouteSessionKey('/chat/abc///?x=1')).toBe('route:/chat/abc');
    expect(normalizeSessionKeyFromPathname('/a/chat/s/abc-1')).toBe('chat:abc-1');
    expect(normalizeSessionKeyFromPathname('/chat/s/abc-2?x=1')).toBe('chat:abc-2');
    expect(normalizeSessionKeyFromPathname('/chat/new')).toBe('route:/chat/new');
  });

  it('写事件后可按会话加载，清空会删除索引与单会话键', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await persistence.saveEvent('chat:a', userEvent('你好'));
    const loaded = await persistence.loadSession('chat:a');
    expect(loaded?.events).toHaveLength(1);
    expect(kv.values.has(STUDIO_EXECUTION_INDEX_KEY)).toBe(true);
    expect(kv.values.has(studioExecutionStorageKey('chat:a'))).toBe(true);

    await persistence.clearAll();
    expect(kv.values.size).toBe(0);
  });

  it('宿主远程读取复用同一存储键映射，逻辑键与已映射键都可用', () => {
    const logical = 'chat:remote-e2e';
    const storage = studioExecutionStorageKey(logical);
    expect(storage).toContain('studio.execution.v2.session.');
    expect(storage).not.toBe(logical);
    expect(studioExecutionStorageKey(storage)).toBe(storage);
    expect(studioExecutionStorageKey(logical)).toBe(storage);
  });

  it('路由临时桶可迁移为稳定 chat 键', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await persistence.saveEvent('route:/chat', userEvent('临时会话'));
    await persistence.renameSession('route:/chat', 'chat:stable');
    expect(await persistence.loadSession('route:/chat')).toBeNull();
    expect((await persistence.loadSession('chat:stable'))?.events).toHaveLength(1);
    expect(kv.values.has(studioExecutionStorageKey('route:/chat'))).toBe(false);
  });

  it('相邻边界并发写入不会互相覆盖（读改写串行化）', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await Promise.all([
      persistence.saveEvent('chat:tight', userEvent('用户消息')),
      persistence.saveEvent('chat:tight', {
        type: 'tool-start',
        at: Date.now(),
        turnId: 'turn-1',
        callId: 'call-1',
        toolName: 'shell_exec',
        params: { command: 'pwd' },
      }),
    ]);
    expect((await persistence.loadSession('chat:tight'))?.events.map((event) => event.type)).toEqual([
      'user-message',
      'tool-start',
    ]);
  });

  it('加载时清理没有用户消息对应的孤儿错误（含 network-error），保留真实轮次错误', async () => {
    const orphan: StudioExecutionEvent = {
      type: 'system-error',
      at: 1,
      turnId: 'orphan-turn',
      code: 'body-error-0',
      message: '请求失败（body-error-0），本轮消息不会自动重发。',
    };
    const orphanNetwork: StudioExecutionEvent = {
      type: 'system-error',
      at: 3,
      turnId: 'orphan-turn-2',
      code: 'network-error',
      message: '服务器暂时无法访问。本轮消息不会自动重发，请检查网络后手动重试。',
    };
    const genuine: StudioExecutionEvent = {
      ...orphan,
      at: 2,
      turnId: 'real-turn',
    };
    const events = [
      orphan,
      { ...userEvent('真实请求'), turnId: 'real-turn' },
      genuine,
      orphanNetwork,
    ];
    expect(dropLegacyOrphanBodyErrors(events)).toEqual([events[1], events[2]]);

    const kv = memoryKv();
    const key = 'route:/';
    kv.values.set(studioExecutionStorageKey(key), {
      version: 2,
      key,
      createdAt: 1,
      updatedAt: 2,
      events,
    });
    const loaded = await store(kv).loadSession(key);
    expect(loaded?.events).toEqual([events[1], events[2]]);
    const stored = kv.values.get(studioExecutionStorageKey(key)) as { events: StudioExecutionEvent[] };
    expect(stored.events).toEqual([events[1], events[2]]);
  });

  it('单会话最多 500 事件，索引最多保留 50 个会话', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    for (let i = 0; i < STUDIO_EXECUTION_MAX_EVENTS + 5; i++) {
      await persistence.saveEvent('chat:long', { ...userEvent(`m${i}`), at: i + 1 });
    }
    expect((await persistence.loadSession('chat:long'))?.events).toHaveLength(STUDIO_EXECUTION_MAX_EVENTS);

    for (let i = 0; i < STUDIO_EXECUTION_MAX_SESSIONS + 3; i++) {
      await persistence.saveEvent(`chat:${i}`, { ...userEvent(`s${i}`), at: 1000 + i });
    }
    const index = kv.values.get(STUDIO_EXECUTION_INDEX_KEY) as { sessions: unknown[] };
    expect(index.sessions).toHaveLength(STUDIO_EXECUTION_MAX_SESSIONS);
  });

  it('工具载荷与最终答复超限时明确标记截断', () => {
    const tool = limitToolPayload({ text: 'x'.repeat(20_000) }, 100);
    expect(tool).toMatchObject({ truncated: true, originalBytes: expect.any(Number) });
    const answer = limitFinalAnswer('a'.repeat(200), 50);
    expect(answer.text).toHaveLength(50);
    expect(answer.truncationMarker).toContain('已截断');
  });

  it('历史双前缀键 chat:chat:<id> 可按规范键读出并就地迁移', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    const legacyKey = 'chat:chat:legacy-1';
    const canonicalKey = 'chat:legacy-1';
    await kv.kvSet(studioExecutionStorageKey(legacyKey), {
      version: 2,
      key: legacyKey,
      createdAt: 1,
      updatedAt: 2,
      events: [userEvent('历史消息')],
    });

    const loaded = await persistence.loadSession(canonicalKey);
    expect(loaded?.key).toBe(canonicalKey);
    expect(loaded?.events).toHaveLength(1);
    // 迁移后旧键被清除，规范键落盘。
    expect(kv.values.has(studioExecutionStorageKey(legacyKey))).toBe(false);
    expect(kv.values.has(studioExecutionStorageKey(canonicalKey))).toBe(true);
  });

  it('索引中双前缀条目按规范键去重，保留最新一条', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await kv.kvSet(STUDIO_EXECUTION_INDEX_KEY, {
      version: 2,
      sessions: [
        { key: 'chat:chat:dup-1', updatedAt: 10, title: '旧记录' },
        { key: 'chat:dup-1', updatedAt: 20, title: '新记录' },
      ],
    });
    await persistence.saveEvent('chat:dup-1', { ...userEvent('触发写入'), at: 30 });
    const index = kv.values.get(STUDIO_EXECUTION_INDEX_KEY) as { sessions: Array<{ key: string; title: string }> };
    const matched = index.sessions.filter((entry) => entry.key === 'chat:dup-1');
    expect(matched).toHaveLength(1);
    expect(index.sessions.some((entry) => entry.key === 'chat:chat:dup-1')).toBe(false);
  });

  it('写入规范键后不再残留双前缀存储键', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await persistence.saveEvent('chat:chat:write-1', userEvent('双前缀写入'));
    expect(kv.values.has(studioExecutionStorageKey('chat:chat:write-1'))).toBe(false);
    const loaded = await persistence.loadSession('chat:write-1');
    expect(loaded?.key).toBe('chat:write-1');
    expect(loaded?.events).toHaveLength(1);
  });
});
