/**
 * 宿主 ↔ 页端路由 + 同意闸门 集成测试（v0.4）
 *
 * 起一个真实 desktop-host（含页端 ws 集线器），用一个最小 ws「假页」模拟注入页，
 * 验证：echo 经页端路由、chat-send 需同意（allow/deny）、无页端 fail-closed、echo 无页端 Node 回退。
 */

import { WebSocket } from 'ws';
import { createDesktopHost } from '../../src/host/desktop-host';
import type { HostToPageMessage } from '../../src/host/protocol';

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

describe('page-runtime + 宿主路由', () => {
  it('echo 经页端路由返回成功', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const ws = await connectFakePage(port, (msg) => {
      if (msg.type === 'dispatch' && msg.tool === 'echo') {
        ws.send(JSON.stringify({ type: 'result', callId: msg.callId, ok: true }));
      }
    });
    const res = await host.invokeTool('echo', {});
    expect(res.ok).toBe(true);
    ws.close();
    await host.stop();
  });

  it('chat-send 需用户同意，allow-once 放行', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const ws = await connectFakePage(port, (msg) => {
      if (msg.type === 'consent-required') {
        ws.send(JSON.stringify({ type: 'consent-decision', callId: msg.callId, decision: 'allow-once' }));
      } else if (msg.type === 'dispatch' && msg.tool === 'chat-send') {
        ws.send(JSON.stringify({ type: 'result', callId: msg.callId, ok: true }));
      }
    });
    const res = await host.invokeTool('chat-send', {});
    expect(res.ok).toBe(true);
    ws.close();
    await host.stop();
  });

  it('chat-send 用户拒绝 → consent-denied', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const ws = await connectFakePage(port, (msg) => {
      if (msg.type === 'consent-required') {
        ws.send(JSON.stringify({ type: 'consent-decision', callId: msg.callId, decision: 'deny' }));
      }
    });
    const res = await host.invokeTool('chat-send', {});
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('consent-denied');
    ws.close();
    await host.stop();
  });

  it('无页端连接 → chat-send fail-closed 拒绝（无人可问，记 consent-unavailable）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const res = await host.invokeTool('chat-send', {});
    expect(res.ok).toBe(false);
    // v0.5 起区分「没有人类在场」与「人类拒绝」，二者都 fail-closed 但成因不同
    expect(res.reason).toBe('consent-unavailable');
    await host.stop();
  });

  it('echo 无页端 → Node 回退（snapshot）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const res = await host.invokeTool('echo', {});
    expect(res.ok).toBe(true);
    expect(res.snapshot?.total ?? 0).toBeGreaterThan(0);
    await host.stop();
  });
});
