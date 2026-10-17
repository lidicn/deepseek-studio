/**
 * 审计修复回归：R2-03（ws upgrade 校验 Origin）、R2-02（pickClient 只派发 hello-ready 连接）。
 */
import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { createDesktopHost } from '../../src/host/desktop-host';

function portOf(host: { url: string }): number {
  return Number(new URL(host.url).port);
}

describe('R2-03 ws upgrade Origin 闸门', () => {
  it('公网恶意 Origin → 握手被拒，无可用页端', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(host)}/studio?token=t`, {
        headers: { Origin: 'https://evil.example.com' },
      });
      const closed = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code));
        ws.on('error', () => resolve(-1));
      });
      const code = await closed;
      expect(code).not.toBe(1000); // 非正常完成握手
      // 恶意页未成为派发目标：任何页端工具都 fail-closed
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
    } finally {
      await host.stop();
    }
  });
});

describe('R2-02 pickClient 只派发 hello-ready 连接', () => {
  it('已连接但从不发 hello 的进程 → 不派发（no-page-runtime）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(host)}/studio?token=t`);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));
      // 故意不发 hello：pickClient 跳过未握手连接，fail-closed
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('no-page');
      ws.close();
    } finally {
      await host.stop();
    }
  });

  it('握手 Origin 与 hello 自报 origin 不一致 → 判 untrusted，不派发', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(host)}/studio?token=t`, {
        headers: { Origin: 'https://chat.deepseek.com' },
      });
      await new Promise<void>((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'hello', origin: 'https://evil.example.com', sessionId: 'x' }));
          resolve();
        });
      });
      await new Promise((r) => setTimeout(r, 100));
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('no-page');
      ws.close();
    } finally {
      await host.stop();
    }
  });
});

describe('R2-04 / R2-05 无页回退与内部 origin', () => {
  it('R2-04：无页时 DOM 能力 chat-read 明确失败（no-page-for-dom-capability），不假成功', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('no-page-for-dom-capability');
    } finally {
      await host.stop();
    }
  });

  it('R2-05：宿主内部调用（HOST_INTERNAL_ORIGIN）不被 origin 闸门拒绝，echo 回退成功', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const res = await host.invokeTool('echo', { text: 'hi' });
      expect(res.ok).toBe(true);
    } finally {
      await host.stop();
    }
  });
});

describe('QD-R2-03 入站 result/consent-decision 连接级身份门', () => {
  it('连接 B 伪造连接 A 的 result → host 不被蒙混，只认 A 的真回执', async () => {
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
    });
    await host.start();
    try {
      const url = `ws://127.0.0.1:${portOf(host)}/studio?token=t`;
      const wa = new WebSocket(url);
      const wb = new WebSocket(url);
      const open = (ws: WebSocket) => new Promise<void>((r) => ws.on('open', () => r()));
      await Promise.all([open(wa), open(wb)]);
      wa.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'a' }));
      wb.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'b' }));
      await new Promise((r) => setTimeout(r, 50));

      // A 收到 dispatch → 记录 callId
      let dispatchedCallId: string | null = null;
      wa.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'dispatch') dispatchedCallId = msg.callId;
      });

      const invokePromise = host.invokeTool('chat-read', {});
      for (let i = 0; i < 30 && !dispatchedCallId; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(dispatchedCallId).toBeTruthy();

      // B 用同一个 callId 抢先伪造 result——身份门应该把它丢掉
      wb.send(JSON.stringify({ type: 'result', callId: dispatchedCallId, ok: true, data: { text: 'PWNED-FROM-B' } }));
      await new Promise((r) => setTimeout(r, 200));

      // 此刻 invokePromise 仍应 pending（B 的伪造被忽略，host 在等 A）
      const race = await Promise.race([
        invokePromise.then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('pending'), 100)),
      ]);
      expect(race).toBe('pending');

      // A 回真 result——host 应该认这个
      wa.send(JSON.stringify({ type: 'result', callId: dispatchedCallId, ok: true, data: { text: 'REAL-FROM-A' } }));
      const res = await invokePromise;
      expect(res.ok).toBe(true);
      expect(JSON.stringify(res.data)).toContain('REAL-FROM-A');
      expect(JSON.stringify(res.data)).not.toContain('PWNED-FROM-B');

      wa.close();
      wb.close();
    } finally {
      await host.stop();
    }
  }, 20000);

  it('未握手（!ready）连接发的 result 一律忽略，不崩不泄露', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(host)}/studio?token=t`);
      await new Promise<void>((r) => ws.on('open', () => r()));
      // 不发 hello，直接伪造一堆 result / consent-decision
      ws.send(JSON.stringify({ type: 'result', callId: 'whatever-1', ok: true, data: { text: 'x' } }));
      ws.send(JSON.stringify({ type: 'consent-decision', callId: 'whatever-2', decision: 'allow' }));
      await new Promise((r) => setTimeout(r, 100));
      // host 不崩、正常运行；chat-read 仍因无可信页 fail-closed
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      ws.close();
    } finally {
      await host.stop();
    }
  });
});
