import { describe, it, expect } from 'vitest';
import {
  createHostClient,
  type WebSocketLike,
  type WebSocketFactory,
} from '../../src/desktop/host-client';

/**
 * R3-C1 回归：host-client 的待决请求在「连接断开」时必须立即结算，不得无限挂起。
 *
 * 缺陷机理（修复前）：
 *   sendToolCall 有 30s 定时器兜底，但 kvGet / kvSet / sendEnvelope 只把 resolver
 *   塞进 pendingKv / pendingEnvelope 就 send 出去，既无超时，onclose 也不遍历结算。
 *   一旦 ws 断开且 host 未回 result，这些 Promise 永不 settle —— 调用方永久挂起，
 *   且 pending 条目永不清理（反复重连持续累积）。
 *
 * 本用例用可控 fake socket 精确复现：发出 kvGet 后立刻触发 onclose，
 * 断言该 Promise 在很短时间内结算（修复前会一直挂到测试超时）。
 */

class FakeSocket implements WebSocketLike {
  readyState = 1; // OPEN
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
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

function makeClient(): { client: ReturnType<typeof createHostClient>; socket: () => FakeSocket } {
  let sock: FakeSocket | null = null;
  const factory: WebSocketFactory = () => {
    sock = new FakeSocket();
    return sock;
  };
  const client = createHostClient({
    url: 'ws://127.0.0.1:0/studio',
    capabilities: [],
    wsFactory: factory,
  });
  client.connect();
  if (!sock) throw new Error('socket not created');
  (sock as FakeSocket).onopen?.();
  return { client, socket: () => sock as FakeSocket };
}

describe('host-client 断线结算（R3-C1 回归）', () => {
  it('kvGet：发出后连接断开，Promise 必须结算而不是永久挂起', async () => {
    const { client, socket } = makeClient();
    const p = client.kvGet('k');
    socket().onclose?.(); // 断线，host 不会回 kv-result
    expect(await settlesWithin(p, 80)).not.toBe(HUNG);
  });

  it('kvSet：发出后连接断开，Promise 必须结算', async () => {
    const { client, socket } = makeClient();
    const p = client.kvSet('k', 1);
    socket().onclose?.();
    expect(await settlesWithin(p, 80)).not.toBe(HUNG);
  });

  it('sendEnvelope：发出后连接断开，Promise 必须结算', async () => {
    const { client, socket } = makeClient();
    const p = client.sendEnvelope({ command: 'ping', requestId: 'r1', payload: {} });
    socket().onclose?.();
    expect(await settlesWithin(p, 80)).not.toBe(HUNG);
  });

  it('sendToolCall：发出后连接断开，Promise 必须结算', async () => {
    const { client, socket } = makeClient();
    const p = client.sendToolCall({ callId: 'c1', invocationName: 'shell_exec', params: {} });
    socket().onclose?.();
    expect(await settlesWithin(p, 80)).not.toBe(HUNG);
  });
});
