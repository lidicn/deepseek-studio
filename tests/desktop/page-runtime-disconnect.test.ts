import { WebSocket } from 'ws';
import { createDesktopHost } from '../../src/host/desktop-host';
import type { HostToPageMessage } from '../../src/host/protocol';

/**
 * C4 回归：宿主侧待决请求（pendingDispatch / pendingConsent）在页端断开时
 * 必须立即结算，而不是干等 30s / 60s 超时。
 *
 * 缺陷机理（修复前）：
 *   page-runtime 的 ws.on('close') 只做 clients.delete(id)，不遍历结算
 *   pendingDispatch / pendingConsent。页端一旦在应答前断开，这些 Promise
 *   只能等 dispatchTimeoutMs(30s) / consentTimeoutMs(60s) 才结算。
 *
 * 本用例：连一个「不回任何消息」的假页 → 发起需要同意/派发的调用 →
 * 立刻断开该页 → 断言 Promise 在 1.5s 内结算（修复前会一直挂到超时）。
 */

function connectFakePage(port: number, handler: (msg: HostToPageMessage) => void): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      try {
        handler(JSON.parse(raw.toString()) as HostToPageMessage);
      } catch {
        /* ignore */
      }
    });
  });
}

const HUNG = Symbol('hung');
function settlesWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    p.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((r) => setTimeout(() => r(HUNG), ms)),
  ]);
}

describe('page-runtime 断线结算（C4 回归）', () => {
  it('同意前页端断开 → pendingConsent 立即结算，不干等 60s', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const ws = await connectFakePage(port, () => {
      /* 什么都不回：模拟同意前断开 */
    });
    const p = host.invokeTool('chat-send', {});
    await new Promise((r) => setTimeout(r, 150)); // 等 consent-required 发出
    ws.close();
    expect(await settlesWithin(p, 1500)).not.toBe(HUNG);
    await host.stop();
  });

  it('派发后页端断开 → pendingDispatch 立即结算，不干等 30s', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const ws = await connectFakePage(port, () => {
      /* 什么都不回：模拟派发后断开 */
    });
    const p = host.invokeTool('echo', {});
    await new Promise((r) => setTimeout(r, 150)); // 等 dispatch 发出
    ws.close();
    expect(await settlesWithin(p, 1500)).not.toBe(HUNG);
    await host.stop();
  });
});
