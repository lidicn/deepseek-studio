/**
 * v0.24：page-runtime 多 bot 寻址测试。
 *
 * 起一个真实 desktop-host，连两个「假注入页」，各在 hello 里自报不同 botId，
 * 验证：
 *   - invokeTool 带 botId → 工具派发只到该 bot 自己的窗口
 *   - 不传 botId → 向后兼容（落到任一可信页，行为不变）
 *   - 带一个没有对应窗口的 botId → 不走错窗口（无匹配页 → Node 回退）
 *   - 同意闸门按 botId 路由：只问该 bot 的窗口；该窗口不在场 → consent-unavailable
 *
 * connectFakePage 等 hello-ack 才 resolve，确保 botId 已在宿主登记（否则存在竞态）；
 * 监听器在连接前注册（ws 不缓冲无监听器消息）；server 绑 127.0.0.1（Windows 默认绑 IPv6）。
 */

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createDesktopHost } from '../../src/host/desktop-host';

type Incoming = { type: 'dispatch' | 'consent-required' | 'hello-ack' | string; callId?: string; tool?: string };

/**
 * 连一个假注入页并自报 botId。
 *   - resolve 时机 = 收到 hello-ack（宿主已登记 botId），消除路由竞态
 *   - onDispatch / onConsent：页端收到的分发/同意请求回调（回参里带 ws，供回包）
 */
async function connectFakePage(opts: {
  port: number;
  botId: string;
  onDispatch?: (m: Incoming, ws: WebSocket) => void;
  onConsent?: (m: Incoming, ws: WebSocket) => void;
}): Promise<WebSocket> {
  const { port, botId, onDispatch, onConsent } = opts;
  return new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: botId, botId }));
    });
    ws.on('message', (raw) => {
      let msg: Incoming;
      try {
        msg = JSON.parse(raw.toString()) as Incoming;
      } catch {
        return;
      }
      if (msg.type === 'hello-ack') resolve(ws);
      else if (msg.type === 'dispatch') onDispatch?.(msg, ws);
      else if (msg.type === 'consent-required') onConsent?.(msg, ws);
    });
  });
}

describe('page-runtime —— v0.24 多 bot 寻址', () => {
  it('invokeTool 带 botId → dispatch 只到该 bot 的窗口', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);

    const seen = new Map<string, string[]>();
    const track = (who: string) => (m: Incoming, ws: WebSocket) => {
      seen.set(who, [...(seen.get(who) ?? []), m.tool ?? '']);
      ws.send(JSON.stringify({ type: 'result', callId: m.callId, ok: true }));
    };
    const wsA = await connectFakePage({ port, botId: 'bot-a', onDispatch: track('bot-a') });
    const wsB = await connectFakePage({ port, botId: 'bot-b', onDispatch: track('bot-b') });

    // 路由到 bot-a
    expect((await host.invokeTool('echo', {}, 'bot-a')).ok).toBe(true);
    expect(seen.get('bot-a')).toEqual(['echo']);
    expect(seen.has('bot-b')).toBe(false); // bot-b 未被牵连

    // 路由到 bot-b
    expect((await host.invokeTool('echo', {}, 'bot-b')).ok).toBe(true);
    expect(seen.get('bot-b')).toEqual(['echo']);

    wsA.close();
    wsB.close();
    await host.stop();
  });

  it('不传 botId → 向后兼容，落到任一可信页（行为不变）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);

    let got: string | undefined;
    const wsA = await connectFakePage({
      port,
      botId: 'bot-a',
      onDispatch: (m, ws) => {
        got = m.tool;
        ws.send(JSON.stringify({ type: 'result', callId: m.callId, ok: true }));
      },
    });

    const r = await host.invokeTool('echo', {});
    expect(r.ok).toBe(true);
    expect(got).toBe('echo');

    wsA.close();
    await host.stop();
  });

  it('不存在的 botId → 不走错窗口（无匹配页 → echo 走 Node 回退）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);

    let wsAReceived = 0;
    const wsA = await connectFakePage({
      port,
      botId: 'bot-a',
      onDispatch: (m, ws) => {
        wsAReceived += 1;
        ws.send(JSON.stringify({ type: 'result', callId: m.callId, ok: true }));
      },
    });

    // 请求一个没有窗口的 bot：echo 无 DOM 依赖 → Node 回退，不派发到 bot-a
    const r = await host.invokeTool('echo', {}, 'nonexistent-bot');
    expect(r.ok).toBe(true);
    expect(wsAReceived).toBe(0);

    wsA.close();
    await host.stop();
  });

  it('同意闸门按 botId 路由：chat-send 只问该 bot 的窗口', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);

    const consentedBy = new Set<string>();
    const make = (who: string) => ({
      onConsent: (m: Incoming, ws: WebSocket) => {
        consentedBy.add(who);
        ws.send(JSON.stringify({ type: 'consent-decision', callId: m.callId, decision: 'allow-once' }));
      },
      onDispatch: (m: Incoming, ws: WebSocket) => {
        ws.send(JSON.stringify({ type: 'result', callId: m.callId, ok: true }));
      },
    });
    const wsA = await connectFakePage({ port, botId: 'bot-a', ...make('bot-a') });
    const wsB = await connectFakePage({ port, botId: 'bot-b', ...make('bot-b') });

    const r = await host.invokeTool('chat-send', {}, 'bot-b');
    expect(r.ok).toBe(true);
    // 只有 bot-b 被问到；bot-a 未被牵连
    expect(consentedBy.has('bot-b')).toBe(true);
    expect(consentedBy.has('bot-a')).toBe(false);

    wsA.close();
    wsB.close();
    await host.stop();
  });

  it('指定 botId 但该 bot 窗口不在场 → consent-unavailable（不拿别人的同意）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);

    // 只有 bot-a 在场
    const wsA = await connectFakePage({
      port,
      botId: 'bot-a',
      onConsent: (m, ws) => {
        ws.send(JSON.stringify({ type: 'consent-decision', callId: m.callId, decision: 'allow-once' }));
      },
    });

    // 请求不在场的 bot-c 发起需同意的 chat-send → 无法征求其同意 → fail-closed
    const r = await host.invokeTool('chat-send', {}, 'bot-c');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('consent-unavailable');

    wsA.close();
    await host.stop();
  });
});
