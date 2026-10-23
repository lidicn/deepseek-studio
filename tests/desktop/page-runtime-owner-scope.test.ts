import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createDesktopHost } from '../../src/host/desktop-host';
import type { HostToPageMessage } from '../../src/host/protocol';

interface FakePage {
  ws: WebSocket;
  seen: HostToPageMessage[];
}

function connectFakePage(port: number, hello: Record<string, unknown>): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    const seen: HostToPageMessage[] = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', ...hello }));
    });
    ws.on('message', (raw) => {
      let msg: HostToPageMessage;
      try {
        msg = JSON.parse(raw.toString()) as HostToPageMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello-ack') {
        resolve({ ws, seen });
        return;
      }
      seen.push(msg);
    });
    ws.on('error', reject);
  });
}

function probe<T>(promise: Promise<T>): { settled: boolean; value: unknown } {
  const state: { settled: boolean; value: unknown } = { settled: false, value: undefined };
  void promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error: unknown) => { state.settled = true; state.value = `rejected:${String(error)}`; },
  );
  return state;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('page-runtime pending 按连接归属清理', () => {
  it('关闭闲置页不会结算另一个页正在等待的工具调用', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const owner = await connectFakePage(port, { id: 'owner' });
    const idle = await connectFakePage(port, { id: 'idle' });

    try {
      const pending = probe(host.invokeTool('echo', {}));
      await wait(100);
      expect(pending.settled).toBe(false);

      idle.ws.close();
      await wait(150);
      expect(pending.settled).toBe(false);
      expect(owner.seen.some((message) => message.type === 'dispatch')).toBe(true);

      owner.ws.close();
      await wait(150);
      expect(pending.settled).toBe(true);
    } finally {
      owner.ws.close();
      idle.ws.close();
      await host.stop();
    }
  });

  it('关闭 botA 的页不会代替 botB 的待决同意做 deny', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    const port = Number(new URL(host.url).port);
    const pageA = await connectFakePage(port, { id: 'a', botId: 'botA' });
    const pageB = await connectFakePage(port, { id: 'b', botId: 'botB' });

    try {
      const pending = probe(host.invokeTool('chat-send', { text: '跨 bot 同意' }, 'botB'));
      await wait(100);
      expect(pending.settled).toBe(false);

      pageA.ws.close();
      await wait(150);
      expect(pending.settled).toBe(false);
      expect(pageB.seen.some((message) => message.type === 'consent-required')).toBe(true);

      pageB.ws.close();
      await wait(150);
      expect(pending.settled).toBe(true);
    } finally {
      pageA.ws.close();
      pageB.ws.close();
      await host.stop();
    }
  });
});
