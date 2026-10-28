import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createDesktopHost } from '../../src/host/desktop-host';
import type { HostToPageMessage } from '../../src/host/protocol';

/**
 * QD-R14 · 宿主↔页端通道（/studio page-runtime）的断开结算射程。
 *
 * C4 修复让「页端断开」立刻结算待决请求（不干等 30s/60s），QD-R2-03 又给每条待决
 * 绑了 ownerId（跨连接回执不认）。但 failAllPending 遍历的是**整张表**，
 * 没有按 ownerId 过滤 ⇒ 任何一个连接的 close/error 会把**别的连接**的待决一起结算掉。
 */

interface FakePage {
  ws: WebSocket;
  id: string;
  seen: HostToPageMessage[];
}

function connectFakePage(
  port: number,
  hello: Record<string, unknown>,
  opts: { autoAnswer?: boolean } = {},
): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    const seen: HostToPageMessage[] = [];
    const id = String(hello['id'] ?? 'p');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', ...hello })));
    ws.on('message', (raw) => {
      let msg: HostToPageMessage & { sessionId?: string };
      try {
        msg = JSON.parse(raw.toString()) as HostToPageMessage & { sessionId?: string };
      } catch {
        return;
      }
      if (msg.type === 'hello-ack') {
        resolve({ ws, id, seen });
        return;
      }
      seen.push(msg);
      if (opts.autoAnswer) {
        if (msg.type === 'dispatch') {
          ws.send(JSON.stringify({ type: 'result', callId: msg.callId, ok: true, data: `answered:${msg.tool}` }));
        } else if (msg.type === 'consent-required') {
          ws.send(JSON.stringify({ type: 'consent-decision', callId: msg.callId, decision: 'allow' }));
        }
      }
    });
    ws.on('error', reject);
  });
}

function probe<T>(p: Promise<T>) {
  const state: { settled: boolean; value: unknown } = { settled: false, value: undefined };
  void p.then(
    (v) => { state.settled = true; state.value = v; },
    (e: unknown) => { state.settled = true; state.value = `rejected:${String(e)}`; },
  );
  return state;
}

const SETTLE_WAIT_MS = 1200;
async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('QD-R14 · page-runtime 待决结算的连接归属', () => {
  it('CONTROL-A：关闭持有待决请求的那个页 → 立即结算 page-disconnected（C4 本意）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const page = await connectFakePage(port, { id: 'owner' });
    const p = probe(host.invokeTool('echo', {}));
    await wait(200);
    expect(p.settled).toBe(false); // 派发出去，页端不回，等待中
    page.ws.close();
    await wait(SETTLE_WAIT_MS);
    expect(p.settled).toBe(true);
    await host.stop();
  });

  it('CONTROL-B：两个页都在、持有者正常应答 → 结果 ok:true（多连接本身无害）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const owner = await connectFakePage(port, { id: 'owner' }, { autoAnswer: true });
    const idle = await connectFakePage(port, { id: 'idle' });
    const p = probe(host.invokeTool('echo', {}));
    await wait(SETTLE_WAIT_MS);
    expect(p.settled).toBe(true);
    expect((p.value as { ok?: boolean }).ok).toBe(true);
    idle.ws.close();
    await owner.ws.close();
    await host.stop();
  });

  it('REPRO-A：关闭一个闲置的第二标签页，会把另一个页正在等的工具判成 page-disconnected', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const owner = await connectFakePage(port, { id: 'owner' });   // 收到 dispatch，故意不回
    const idle = await connectFakePage(port, { id: 'idle' });     // 从未被派发任何东西

    const p = probe(host.invokeTool('echo', {}));
    await wait(200);
    expect(p.settled).toBe(false);

    idle.ws.close();
    await wait(SETTLE_WAIT_MS);

    console.log(`[REPRO-A] owner 待决读数 = ${JSON.stringify(p.value)}（settled=${p.settled}），owner 连接状态=${owner.ws.readyState}，owner 收到的宿主消息=${owner.seen.map((m) => m.type).join(',')}`);
    // 正确行为：owner 连接还开着、还没应答 ⇒ 这条待决不应被别的连接的断开结算掉。
    expect(p).toEqual({ settled: false, value: undefined });
    await owner.ws.close();
    await host.stop();
  });

  it('REPRO-B：跨 bot 同样中招——关掉 botA 的页，botB 的待决同意被直接判 deny', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const pageA = await connectFakePage(port, { id: 'a', botId: 'botA' });
    const pageB = await connectFakePage(port, { id: 'b', botId: 'botB' }); // 不回任何消息

    const p = probe(host.invokeTool('chat-send', { text: '跨 bot 同意' }, 'botB'));
    await wait(200);
    expect(p.settled).toBe(false);

    pageA.ws.close();
    await wait(SETTLE_WAIT_MS);

    console.log(
      `[REPRO-B] botB 待决读数 = ${JSON.stringify(p.value)}（settled=${p.settled}），` +
      `botB 连接状态=${pageB.ws.readyState}，botB 收到的宿主消息=${pageB.seen.map((m) => m.type).join(',')}`,
    );
    // botB 的页还开着、同意弹窗还挂在页面上，这条决定不该被 botA 的断开替用户做出。
    expect(p).toEqual({ settled: false, value: undefined });
    await pageB.ws.close();
    await host.stop();
  });
});
