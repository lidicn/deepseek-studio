/**
 * transport-webview 单测：Node ws 信封接收端能收到注入侧投来的信封。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createNodeWsEnvelopeReceiver } from '../../src/bridge/transport-webview';
import { decodeRuntimeMessageEnvelope } from '../../src/bridge/envelope';

describe('transport-webview (Node ws 信封接收)', () => {
  const receivers: Awaited<ReturnType<typeof createNodeWsEnvelopeReceiver>>[] = [];
  afterEach(async () => {
    while (receivers.length) await receivers.pop()!.close();
  });

  it('ws 收到注入侧投来的信封', async () => {
    const got: unknown[] = [];
    const recv = await createNodeWsEnvelopeReceiver(0, (env) => got.push(env));
    receivers.push(recv);

    const { WebSocket } = await import('ws');
    const client = new WebSocket(`ws://127.0.0.1:${recv.port}`);
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    const envelope = { command: 'ping', requestId: 'r1', payload: { hello: 'world' } };
    client.send(JSON.stringify(envelope));
    await new Promise((r) => setTimeout(r, 150));
    client.close();

    expect(got.length).toBe(1);
    const decoded = decodeRuntimeMessageEnvelope(got[0]);
    expect(decoded?.command).toBe('ping');
  });
});
