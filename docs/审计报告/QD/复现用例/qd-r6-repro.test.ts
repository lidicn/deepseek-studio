// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createStudioExecutionStore,
  studioExecutionStorageKey,
  type StudioExecutionKv,
} from '../../src/ui/studio-execution-store';
import {
  STUDIO_EXECUTION_INDEX_KEY,
  STUDIO_TOOL_PAYLOAD_LIMIT,
  appendExecutionEvent,
  createEmptyStudioExecutionSession,
  limitToolPayload,
  type StudioExecutionEvent,
  type StudioExecutionIndex,
} from '../../src/shared/studio-execution';

function memoryKv(writeLog?: number[]): StudioExecutionKv & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async kvGet(key) {
      return values.get(key);
    },
    async kvSet(key, value) {
      values.set(key, structuredClone(value));
      writeLog?.push(JSON.stringify(value).length);
    },
    async kvRemove(key) {
      values.delete(key);
    },
  };
}

function userEvent(text: string, at = Date.now()): StudioExecutionEvent {
  return { type: 'user-message', at, turnId: `t-${at}`, text };
}

function storeOn(kv: StudioExecutionKv) {
  return createStudioExecutionStore({
    kv,
    onConnected: () => () => {},
    isConnected: () => true,
  });
}

describe('QD-R6 会话持久化', () => {
  it('CONTROL: 正常 saveEvent 会写入会话与索引', async () => {
    const kv = memoryKv();
    const store = storeOn(kv);
    await store.saveEvent('chat:ok', userEvent('正常会话'));
    const index = kv.values.get(STUDIO_EXECUTION_INDEX_KEY) as StudioExecutionIndex;
    expect(index.sessions.map((entry) => entry.key)).toEqual(['chat:ok']);
    expect(kv.values.has(studioExecutionStorageKey('chat:ok'))).toBe(true);
  });

  it('REPRO-A: renameSession 后旧键仍留在索引里，指向已被删除的存储', async () => {
    const kv = memoryKv();
    const store = storeOn(kv);
    await store.saveEvent('route:/', userEvent('临时会话'));
    await store.renameSession('route:/', 'chat:x');

    const index = kv.values.get(STUDIO_EXECUTION_INDEX_KEY) as StudioExecutionIndex;
    expect(index.sessions.map((entry) => entry.key)).toEqual(['chat:x']);
    expect(kv.values.has(studioExecutionStorageKey('route:/'))).toBe(false);
    // 幽灵条目：索引里有 route:/，但它指向的会话已被 kvRemove。
    expect(index.sessions.some((entry) => entry.key === 'route:/')).toBe(false);
  });

  it('REPRO-B: clearAll 只按索引清理，索引外的孤儿会话键会留下', async () => {
    const kv = memoryKv();
    // 模拟 saveEvent 写完会话、更新索引前进程被杀/写失败留下的孤儿键。
    await kv.kvSet(studioExecutionStorageKey('chat:orphan'), {
      version: 2,
      key: 'chat:orphan',
      createdAt: 1,
      updatedAt: 1,
      events: [userEvent('孤儿会话')],
    });
    const store = storeOn(kv);
    await store.clearAll();
    expect(kv.values.has(studioExecutionStorageKey('chat:orphan'))).toBe(false);
  });

  it('REPRO-C: 工具载荷按字符数判限、按字节截断，中文可超预算约 3 倍', () => {
    const cjk = '中'.repeat(10_000); // 10,000 字符 ≈ 30,000 UTF-8 字节
    const limited = limitToolPayload({ content: cjk });
    expect('truncated' in limited).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(limited)).byteLength;
    expect(bytes).toBeLessThanOrEqual(STUDIO_TOOL_PAYLOAD_LIMIT);
  });

  it('REPRO-D: 每个事件重写整份会话，写放大随事件数线性增长', async () => {
    const writeLog: number[] = [];
    const kv = memoryKv(writeLog);
    const store = storeOn(kv);
    const payload = 'x'.repeat(8 * 1024);
    for (let i = 0; i < 20; i += 1) {
      await store.saveEvent('chat:big', {
        type: 'tool-result',
        at: Date.now() + i,
        turnId: 't-big',
        callId: `c-${i}`,
        toolName: 'shell_exec',
        ok: true,
        result: { content: payload },
      } as StudioExecutionEvent);
    }
    const finalSession = kv.values.get(studioExecutionStorageKey('chat:big'));
    const finalBytes = JSON.stringify(finalSession).length;
    const totalWritten = writeLog.reduce((sum, n) => sum + n, 0);
    // 索引写入也计入，但量级远小于会话本体；只主张「写了不止一遍」这一事实。
    const amplification = totalWritten / finalBytes;
    console.log('R6 write amplification:', { finalBytes, totalWritten, amplification: amplification.toFixed(2) });
    expect(amplification).toBeLessThan(2);
  });

  it('REPRO-E: 事件截断后首个 user-message 消失，会话标题随之漂移', () => {
    const session = createEmptyStudioExecutionSession('chat:trim');
    appendExecutionEvent(session, userEvent('原始标题-第一句', 1_000));
    for (let i = 0; i < 500; i += 1) {
      appendExecutionEvent(session, {
        type: 'tool-result', at: 2_000 + i, turnId: 't-big', callId: `c-${i}`,
        toolName: 'shell_exec', ok: true, result: {},
      } as StudioExecutionEvent);
    }
    const title = (session as { events: StudioExecutionEvent[] }).events
      .filter((event) => event.type === 'user-message').length;
    expect(title).toBe(1);
  });
});
