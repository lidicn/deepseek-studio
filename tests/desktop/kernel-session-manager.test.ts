import { describe, expect, it } from 'vitest';

import { createSessionManager } from '../../src/host/kernel/session-manager';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';

function fakeEngine(): ModelEngine {
  return {
    name: 'web',
    async health() { return { ok: true }; },
    async send(): Promise<EngineSendResult> {
      return { content: 'ok', toolCalls: 0 };
    },
  };
}

describe('SessionManager（S14 多会话）', () => {
  it('1. 新建会话返回独立 handle', () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    const h = sm.getOrCreate('a');
    expect(h.sessionId).toBe('a');
  });

  it('2. 同 sessionId 二次 getOrCreate 返回同一 handle', () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    const h1 = sm.getOrCreate('a');
    const h2 = sm.getOrCreate('a');
    expect(h1).toBe(h2);
  });

  it('3. 不同会话历史互不串', async () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    const a = sm.getOrCreate('a');
    const b = sm.getOrCreate('b');
    await a.loop.run('只给a');
    expect(a.history.byRole('user')).toHaveLength(1);
    expect(b.history.byRole('user')).toHaveLength(0);
  });

  it('4. list 返回所有会话 id', () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    sm.getOrCreate('a');
    sm.getOrCreate('b');
    expect(sm.list().sort()).toEqual(['a', 'b']);
  });

  it('5. destroy 后会话从 list 消失', () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    sm.getOrCreate('a');
    sm.destroy('a');
    expect(sm.list()).not.toContain('a');
  });

  it('6. 并发上限超限抛错', () => {
    const sm = createSessionManager({ engine: fakeEngine(), maxSessions: 2 });
    sm.getOrCreate('a');
    sm.getOrCreate('b');
    expect(() => sm.getOrCreate('c')).toThrow(/上限/);
  });

  it('7. 默认上限 4', () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    sm.getOrCreate('a'); sm.getOrCreate('b'); sm.getOrCreate('c'); sm.getOrCreate('d');
    expect(() => sm.getOrCreate('e')).toThrow();
  });

  it('8. destroy 后可重新创建', () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    sm.getOrCreate('a');
    sm.destroy('a');
    const h = sm.getOrCreate('a');
    expect(h.history.byRole('user')).toHaveLength(0);
  });

  it('9. destroy 不存在的会话不炸', () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    expect(() => sm.destroy('nope')).not.toThrow();
  });

  it('10. 每个会话有独立 loop', async () => {
    const sm = createSessionManager({ engine: fakeEngine() });
    const a = sm.getOrCreate('a');
    const b = sm.getOrCreate('b');
    await a.loop.run('a的消息');
    expect(b.history.byRole('user')).toHaveLength(0);
  });
});
