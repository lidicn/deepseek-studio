import { describe, it, expect } from 'vitest';
import {
  decodeRuntimeMessageEnvelope,
  authorizeRuntimeMessage,
  createRuntimeBoundaryErrorResponse,
  DEEPSEEK_CONTENT_RUNTIME_COMMANDS,
  type RuntimeMessageEnvelope,
} from '../../src/bridge/envelope';
import {
  createRuntimeBridge,
  createRuntimeLastErrorController,
  type RuntimeBridge,
} from '../../src/bridge/runtime';
import type { Transport } from '../../src/bridge/transport';

describe('envelope', () => {
  it('decode 合法信封', () => {
    const e = decodeRuntimeMessageEnvelope({ command: 'ping', requestId: 'r1', payload: { a: 1 } });
    expect(e).toEqual({ command: 'ping', requestId: 'r1', payload: { a: 1 } });
  });
  it('decode 缺 payload 视为 null', () => {
    const e = decodeRuntimeMessageEnvelope({ command: 'ping', requestId: 'r1' });
    expect(e?.payload).toBeNull();
  });
  it('decode 非法返回 null', () => {
    expect(decodeRuntimeMessageEnvelope(null)).toBeNull();
    expect(decodeRuntimeMessageEnvelope({ requestId: 'r1' })).toBeNull();
    expect(decodeRuntimeMessageEnvelope({ command: 1, requestId: 'r1' })).toBeNull();
  });
  it('白名单授权', () => {
    expect(authorizeRuntimeMessage({ command: 'bridge_invoke', requestId: 'r', payload: null })).toBe(true);
    expect(authorizeRuntimeMessage({ command: 'evil', requestId: 'r', payload: null })).toBe(false);
  });
  it('错误响应形状', () => {
    expect(createRuntimeBoundaryErrorResponse('r1', 'UNAUTHORIZED', 'no')).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'no' },
    });
  });
  it('白名单包含核心命令', () => {
    for (const c of ['bridge_invoke', 'kv_get', 'kv_set', 'kv_remove', 'tool_execute', 'agent_turn', 'ping']) {
      expect(DEEPSEEK_CONTENT_RUNTIME_COMMANDS.has(c)).toBe(true);
    }
  });
});

function pipe(getReceiver: () => RuntimeBridge): Transport {
  return {
    post(envelope: RuntimeMessageEnvelope) {
      return getReceiver().handle(envelope);
    },
  };
}

describe('runtime bridge dispatch', () => {
  const env = (command: string): RuntimeMessageEnvelope => ({ command, requestId: 'r', payload: null });

  it('监听器返回 true 并经 sendResponse 回值', async () => {
    const receiver = createRuntimeBridge({ transport: pipe(() => receiver) });
    receiver.addListener((e, _s, sendResponse) => {
      if (e.command === 'ping') {
        sendResponse({ pong: true });
        return true;
      }
    });
    const sender = createRuntimeBridge({ transport: pipe(() => receiver) });
    const res = await sender.post(env('ping'));
    expect(res).toEqual({ pong: true });
  });

  it('无接收方返回 DISPATCH_TIMEOUT 错误', async () => {
    const receiver = createRuntimeBridge({ transport: pipe(() => receiver) });
    const sender = createRuntimeBridge({ transport: pipe(() => receiver) });
    const res = await sender.post(env('ping'));
    expect(res).toEqual({ ok: false, error: { code: 'DISPATCH_TIMEOUT', message: expect.any(String) } });
  });

  it('sendResponse 超时返回 DISPATCH_TIMEOUT', async () => {
    const receiver = createRuntimeBridge({ transport: pipe(() => receiver), timeoutMs: 20 });
    receiver.addListener(() => true); // 吞掉，不调用 sendResponse
    const sender = createRuntimeBridge({ transport: pipe(() => receiver) });
    const res = await sender.post(env('ping'));
    expect(res).toEqual({ ok: false, error: { code: 'DISPATCH_TIMEOUT', message: expect.any(String) } });
  });

  it('白名单外命令被接收侧拒为 UNAUTHORIZED', async () => {
    const receiver = createRuntimeBridge({ transport: pipe(() => receiver) });
    const sender = createRuntimeBridge({ transport: pipe(() => receiver) });
    const res = await sender.post(env('evil'));
    expect(res).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
  });

  it('lastError 控制器 set/get/clear', () => {
    const le = createRuntimeLastErrorController();
    expect(le.get()).toBeUndefined();
    le.set({ message: 'x' });
    expect(le.get()?.message).toBe('x');
    le.clear();
    expect(le.get()).toBeUndefined();
  });
});
