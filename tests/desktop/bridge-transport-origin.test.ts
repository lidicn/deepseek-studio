import { describe, expect, it, vi } from 'vitest';
import { createWindowMessageTransport } from '../../src/bridge/transport';
import type { RuntimeMessageEnvelope } from '../../src/bridge/envelope';

describe('window postMessage origin', () => {
  it('发送使用同源 targetOrigin，接收忽略跨源回执', async () => {
    const listeners = new Set<EventListener>();
    const selfWindow = {
      location: { origin: 'https://studio.local' },
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    };
    const postMessage = vi.fn();
    const transport = createWindowMessageTransport(
      { postMessage },
      'channel',
      selfWindow,
      1_000,
    );
    const envelope: RuntimeMessageEnvelope = { command: 'ping', requestId: 'r1', payload: null };
    const pending = transport.post(envelope, {});

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __channel: 'channel', requestId: 'r1' }),
      'https://studio.local',
    );

    const listener = [...listeners][0] as EventListener;
    listener({ origin: 'https://evil.local', data: { __channel: 'channel', requestId: 'r1', response: 'evil' } } as MessageEvent);
    listener({ origin: 'https://studio.local', data: { __channel: 'channel', requestId: 'r1', response: 'ok' } } as MessageEvent);
    await expect(pending).resolves.toBe('ok');
    transport.close?.();
  });
});
