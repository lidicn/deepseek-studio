import { describe, it, expect } from 'vitest';
import { installDirectBridge } from '../../src/inject/bridge-install';
import { createDirectTarget } from '../../src/inject/direct-target';

describe('direct bridge (same-origin)', () => {
  it('两端经 session 互通消息', () => {
    const { content, injected } = installDirectBridge({ origin: 'https://chat.deepseek.com', sessionId: 's1' });
    const received: unknown[] = [];
    injected.onMessage((m) => received.push(m));
    content.post({ hello: 'world' });
    expect(received).toEqual([{ hello: 'world' }]);
  });

  it('伪造 session 的消息被丢弃', () => {
    const bus = createDirectTarget('https://chat.deepseek.com');
    const legit = installDirectBridge({ origin: 'https://chat.deepseek.com', sessionId: 's1', target: bus } as never);
    // 用另一个 session 的桥向同一总线投消息
    const fake = installDirectBridge({ origin: 'https://chat.deepseek.com', sessionId: 'evil', target: bus } as never);
    const received: unknown[] = [];
    legit.injected.onMessage((m) => received.push(m));
    fake.content.post({ attack: 1 });
    expect(received).toEqual([]);
  });

  it('disconnect 后不再投递', () => {
    const { content, injected } = installDirectBridge({ origin: 'https://chat.deepseek.com', sessionId: 's1' });
    const received: unknown[] = [];
    injected.onMessage((m) => received.push(m));
    content.post({ a: 1 });
    injected.disconnect();
    content.post({ b: 2 });
    expect(received).toEqual([{ a: 1 }]);
  });

  it('acceptsSession 仅匹配同源同 session', () => {
    const { injected } = installDirectBridge({ origin: 'https://chat.deepseek.com', sessionId: 's1' });
    expect(injected.acceptsSession({ origin: 'https://chat.deepseek.com', sessionId: 's1' })).toBe(true);
    expect(injected.acceptsSession({ origin: 'https://evil.com', sessionId: 's1' })).toBe(false);
    expect(injected.acceptsSession({ origin: 'https://chat.deepseek.com', sessionId: 's2' })).toBe(false);
  });

  // ── R6-H1（2026-11-09）：**自发自收**缺陷的回归锁 ─────────────────────────
  //
  // 修复前：两端共用一个 sessionId，而 `direct-port` 只校验 session、没有 sender 判据，
  // 且两端 listener 挂在**同一个 origin 总线**上 ⇒ 自己 post 的消息自己也会收到。
  // 下面这枚是**缺陷本体**的锁：修好后必须"对端收到、自己不收到"。

  it('R6-H1：content 发一条 ⇒ 对端(injected)收到，content 自己**不**收到', () => {
    const { content, injected } = installDirectBridge({
      origin: 'https://chat.deepseek.com',
      sessionId: 's1',
    });
    const atContent: unknown[] = [];
    const atInjected: unknown[] = [];
    content.onMessage((m) => atContent.push(m));
    injected.onMessage((m) => atInjected.push(m));

    content.post({ hello: 'world' });

    // 正控：对端确实收到（**只测"自己不收到"会漏掉"谁都收不到"这种反向失败**）
    expect(atInjected).toEqual([{ hello: 'world' }]);
    // 主断言：自己没收到
    expect(atContent).toEqual([]);
  });

  it('R6-H1：injected 发一条 ⇒ 对端(content)收到，injected 自己**不**收到', () => {
    const { content, injected } = installDirectBridge({
      origin: 'https://chat.deepseek.com/s2b',
      sessionId: 's2b',
    });
    const atContent: unknown[] = [];
    const atInjected: unknown[] = [];
    content.onMessage((m) => atContent.push(m));
    injected.onMessage((m) => atInjected.push(m));

    injected.post({ from: 'injected' });

    expect(atContent).toEqual([{ from: 'injected' }]);
    expect(atInjected).toEqual([]);
  });

  it('R6-H1 装置自检：同一条消息只被对端投递**一次**（不是两次）', () => {
    // 修复前的真实表现是"自己那次也被投递" ⇒ 同一个 handler 被调两次。
    // 这里用计数钉住"恰好一次"，比只断言内容更直接。
    const { content, injected } = installDirectBridge({
      origin: 'https://chat.deepseek.com/s3',
      sessionId: 's3',
    });
    const counts = { content: 0, injected: 0 };
    content.onMessage(() => { counts.content += 1; });
    injected.onMessage(() => { counts.injected += 1; });

    content.post({ n: 1 });

    expect(counts).toEqual({ content: 0, injected: 1 });
  });

  it('R6-H1 负控：伪造 __from 拿不到别人的消息（session 仍是安全边界）', () => {
    // `__from` 只解决方向、不承担安全职责：session 校验先于它。
    // 这里证明"能伪造 from 也进不来"——否则方向标记会被当成安全机制。
    const bus = createDirectTarget('https://chat.deepseek.com/s4');
    const legit = installDirectBridge({ origin: 'https://chat.deepseek.com/s4', sessionId: 's4', target: bus });
    const received: unknown[] = [];
    legit.injected.onMessage((m) => received.push(m));

    // 用错误 session + 正确 from 直接投总线
    bus.postMessage({ __session: 'wrong', __from: 'content', __payload: { attack: 1 } });
    expect(received).toEqual([]);
  });
});
