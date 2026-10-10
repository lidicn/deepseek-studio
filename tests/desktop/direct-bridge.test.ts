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
});
