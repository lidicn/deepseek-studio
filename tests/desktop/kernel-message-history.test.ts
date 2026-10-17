import { describe, expect, it } from 'vitest';

import { createMessageHistory } from '../../src/host/kernel/message-history';
import type { ChatMessage, ChatRole } from '../../src/host/kernel/message-history';

/** 用确定性时钟 + 确定性 id 工厂构造历史，便于断言。 */
function makeFixture() {
  let t = 1000;
  let idc = 0;
  const hist = createMessageHistory({
    now: () => t,
    idFactory: () => `gen-${++idc}`,
  });
  return {
    hist,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe('MessageHistory（M2-1 真源）', () => {
  it('1. append 生成唯一 id，并用注入时钟递增 createdAt', () => {
    const { hist, tick } = makeFixture();
    const a = hist.append({ role: 'user', content: '你好' });
    tick(100);
    const b = hist.append({ role: 'assistant', content: '在的' });

    expect(a.id).toBe('gen-1');
    expect(b.id).toBe('gen-2');
    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toBe(1000);
    expect(b.createdAt).toBe(1100);
  });

  it('2. append 显式传 id 则用传入的（不被覆盖）', () => {
    const { hist } = makeFixture();
    const m = hist.append({ role: 'tool', content: 'ok', id: 'call-xyz', toolCallId: 'call-xyz' });
    expect(m.id).toBe('call-xyz');
    expect(m.toolCallId).toBe('call-xyz');
    // 后续仍走工厂 id
    const next = hist.append({ role: 'assistant', content: 'done' });
    expect(next.id).toBe('gen-1');
  });

  it('3. all() 返回顺序 = 追加顺序', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'system', content: 'sys' });
    hist.append({ role: 'user', content: 'u1' });
    hist.append({ role: 'assistant', content: 'a1' });
    expect(hist.all().map((m) => m.content)).toEqual(['sys', 'u1', 'a1']);
  });

  it('4. all() 返回值不可变：push / 清空它不影响内部', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'user', content: 'u1' });
    hist.append({ role: 'assistant', content: 'a1' });

    const view = hist.all();
    (view as ChatMessage[]).push({ id: 'x', role: 'user', content: 'inject', createdAt: 1 });
    (view as ChatMessage[]).length = 0;

    expect(hist.size()).toBe(2);
    expect(hist.all().map((m) => m.content)).toEqual(['u1', 'a1']);
  });

  it('5. byRole 过滤正确，保持原顺序', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'system', content: 'sys' });
    hist.append({ role: 'user', content: 'u1' });
    hist.append({ role: 'assistant', content: 'a1' });
    hist.append({ role: 'user', content: 'u2' });

    expect(hist.byRole('user').map((m) => m.content)).toEqual(['u1', 'u2']);
    expect(hist.byRole('system').map((m) => m.content)).toEqual(['sys']);
    expect(hist.byRole('tool')).toEqual([]);
  });

  it('6. lastN(n) 取尾部 n 条；n > size 返回全部', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'user', content: 'm1' });
    hist.append({ role: 'user', content: 'm2' });
    hist.append({ role: 'user', content: 'm3' });
    hist.append({ role: 'user', content: 'm4' });

    expect(hist.lastN(2).map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(hist.lastN(10).map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('7. lastN(0) / 负数 返回空数组', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'user', content: 'm1' });
    expect(hist.lastN(0)).toEqual([]);
    expect(hist.lastN(-3)).toEqual([]);
  });

  it('8. clear 后 size=0 且 all() 为空', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'user', content: 'u1' });
    hist.append({ role: 'assistant', content: 'a1' });
    expect(hist.size()).toBe(2);
    hist.clear();
    expect(hist.size()).toBe(0);
    expect(hist.all()).toEqual([]);
  });

  it('9. snapshot 形状稳定：含 version:1 与 messages 数组', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'user', content: 'u1' });
    const snap = hist.snapshot();
    expect(Object.keys(snap).sort()).toEqual(['messages', 'version']);
    expect(snap.version).toBe(1);
    expect(Array.isArray(snap.messages)).toBe(true);
    expect(snap.messages).toHaveLength(1);
  });

  it('10. snapshot → JSON.stringify → parse → restore 往返一致', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'system', content: 'sys' });
    hist.append({ role: 'user', content: 'u1' });
    hist.append({ role: 'assistant', content: 'a1', toolCallId: undefined });
    const snap = hist.snapshot();

    const wire = JSON.parse(JSON.stringify(snap)) as unknown;
    const restored = createMessageHistory();
    restored.restore(wire);

    expect(restored.size()).toBe(3);
    expect(restored.all()).toEqual(hist.all());
    // 字段级逐一对齐
    const before = hist.all();
    const after = restored.all();
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i]).toEqual(before[i]);
    }
  });

  it('11. restore 遇到 version:2 抛错（不静默降级）', () => {
    const hist = createMessageHistory();
    expect(() => hist.restore({ version: 2, messages: [] })).toThrow(/版本/);
  });

  it('12. restore 遇到非对象 / 缺 messages 抛错', () => {
    const hist = createMessageHistory();
    expect(() => hist.restore(null)).toThrow();
    expect(() => hist.restore('not-an-object')).toThrow();
    expect(() => hist.restore({ version: 1 })).toThrow(/messages/);
    expect(() => hist.restore({ version: 1, messages: 'oops' })).toThrow(/messages/);
  });

  it('13. restore 是替换而非追加：恢复后不含恢复前的消息', () => {
    const { hist } = makeFixture();
    hist.append({ role: 'user', content: 'old-1' });
    hist.append({ role: 'user', content: 'old-2' });

    hist.restore({
      version: 1,
      messages: [
        { id: 'r1', role: 'user', content: 'restored-1', createdAt: 5 },
      ] as ChatMessage[],
    });

    expect(hist.size()).toBe(1);
    expect(hist.all().map((m) => m.content)).toEqual(['restored-1']);
  });

  it('14. 未注入 idFactory / now 时可用（默认实现不报错）', () => {
    const hist = createMessageHistory();
    const m = hist.append({ role: 'user', content: 'u' });
    expect(typeof m.id).toBe('string');
    expect(m.id.length).toBeGreaterThan(0);
    expect(typeof m.createdAt).toBe('number');
    expect(hist.size()).toBe(1);
  });

  it('15. 角色集合覆盖：system/user/assistant/tool 均可追加', () => {
    const hist = createMessageHistory();
    const roles: ChatRole[] = ['system', 'user', 'assistant', 'tool'];
    for (const r of roles) {
      hist.append({ role: r, content: r });
    }
    expect(hist.size()).toBe(4);
    expect(hist.byRole('tool')).toHaveLength(1);
  });
});
