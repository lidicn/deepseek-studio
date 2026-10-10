/**
 * 页端宿主客户端测试（v0.4）
 *
 * 起一个 ws 服务端模拟宿主：页端连接 → 收到 hello → 推 dispatch(echo) → 客户端路由到
 * echo 能力执行 → 回传 result；验证端到端闭环。disconnect 清理，避免重连挂起。
 */

import { WebSocketServer } from 'ws';
import { createHostClient } from '../../src/desktop/host-client';
import { createEchoCapability } from '../../src/capabilities/echo';

describe('host-client（页端）', () => {
  it('连接宿主并响应 dispatch', async () => {
    const server = new WebSocketServer({ port: 0 });
    const portReady = new Promise<number>((res) => server.on('listening', () => res((server.address() as { port: number }).port)));
    const port = await portReady;

    const got = new Promise<{ ok: boolean }>((res) => {
      server.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString()) as { type: string; callId?: string; ok?: boolean };
          if (msg.type === 'hello') {
            ws.send(JSON.stringify({ type: 'dispatch', callId: msg.callId ?? 'c1', tool: 'echo', params: {} }));
          } else if (msg.type === 'result') {
            res({ ok: msg.ok === true });
          }
        });
      });
    });

    const client = createHostClient({
      url: `ws://127.0.0.1:${port}/studio`,
      capabilities: [createEchoCapability()],
    });
    client.connect();

    const r = await got;
    expect(r.ok).toBe(true);

    client.disconnect();
    await new Promise<void>((res) => server.close(() => res()));
  });
});
