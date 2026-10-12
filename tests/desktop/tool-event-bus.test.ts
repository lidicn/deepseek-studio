import { describe, expect, it } from 'vitest';

import { clearToolEvents, createToolEventBus, emit, on } from '../../src/shared/tool-event-bus';
import type {
  ToolEvent,
  ToolEventHandlerError,
  ToolEventInput,
  ToolEventName,
  ToolEventPayload,
} from '../../src/shared/tool-event-bus';
import type { ToolCallParams, ToolCallResult } from '../../src/shared/tool-hooks';

async function stall(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

interface InputExtras {
  toolName?: string | undefined;
  params?: ToolCallParams | undefined;
  result?: ToolCallResult | undefined;
  durationMs?: number | undefined;
  reason?: string | undefined;
  callId?: string | undefined;
  event?: ToolEvent | undefined;
}

function makeInput(extras: InputExtras = {}): ToolEventInput {
  return {
    toolName: extras.toolName ?? 'shell.exec',
    params: extras.params ?? { cmd: 'ls' },
    result: extras.result,
    durationMs: extras.durationMs,
    ...(extras.reason !== undefined ? { reason: extras.reason } : {}),
    ...(extras.callId !== undefined ? { callId: extras.callId } : {}),
    ...(extras.event !== undefined ? { event: extras.event } : {}),
  };
}

describe('tool-event-bus · 订阅与派发', () => {
  it('emit 后所有具名订阅者都收到 payload（同一份、形状补齐）', () => {
    const bus = createToolEventBus();
    const a: ToolEventPayload[] = [];
    const b: ToolEventPayload[] = [];
    bus.on('after-call', (p) => {
      a.push(p);
      return undefined;
    });
    bus.on('after-call', (p) => {
      b.push(p);
      return undefined;
    });
    bus.emit('after-call', makeInput({ result: { ok: true }, durationMs: 3 }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(b[0]);
    expect(a[0]).toEqual({
      event: 'after-call',
      toolName: 'shell.exec',
      params: { cmd: 'ls' },
      result: { ok: true },
      durationMs: 3,
    });
  });

  it('payload 形状固定：event / toolName / params / result / durationMs 恒在', () => {
    const bus = createToolEventBus();
    const seen: ToolEventPayload[] = [];
    bus.on('*', (p) => {
      seen.push(p);
      return undefined;
    });
    bus.emit('before-call', makeInput());
    bus.emit('after-call', makeInput({ result: { ok: true }, durationMs: 7 }));
    expect(seen).toHaveLength(2);
    for (const p of seen) {
      expect('event' in p).toBe(true);
      expect('toolName' in p).toBe(true);
      expect('params' in p).toBe(true);
      expect('result' in p).toBe(true);
      expect('durationMs' in p).toBe(true);
    }
    expect(seen[0]?.event).toBe('before-call');
    expect(seen[0]?.result).toBeUndefined();
    expect(seen[0]?.durationMs).toBeUndefined();
    expect(seen[1]?.durationMs).toBe(7);
  });

  it("emit 按第一个参数补齐 / 覆盖 payload.event", () => {
    const bus = createToolEventBus();
    const seen: ToolEventPayload[] = [];
    bus.on('*', (p) => {
      seen.push(p);
      return undefined;
    });
    bus.emit('call-skip', makeInput({ event: 'after-call', reason: 'r' }));
    expect(seen[0]?.event).toBe('call-skip');
    expect(seen[0]?.reason).toBe('r');
  });

  it('取消订阅后不再收到事件；卸载函数可重复调用', () => {
    const bus = createToolEventBus();
    const calls: ToolEventPayload[] = [];
    const off = bus.on('call-skip', (p) => {
      calls.push(p);
      return undefined;
    });
    bus.emit('call-skip', makeInput({ reason: 'x' }));
    off();
    off();
    bus.emit('call-skip', makeInput({ reason: 'y' }));
    expect(calls).toHaveLength(1);
    expect(bus.listenerCount('call-skip')).toBe(0);
  });

  it("'*' 订阅者收到全部四类事件", () => {
    const bus = createToolEventBus();
    const names: string[] = [];
    bus.on('*', (p) => {
      names.push(p.event);
      return undefined;
    });
    bus.emit('before-call', makeInput());
    bus.emit('after-call', makeInput());
    bus.emit('call-error', makeInput());
    bus.emit('call-skip', makeInput());
    expect(names).toEqual(['before-call', 'after-call', 'call-error', 'call-skip']);
  });

  it("具名 handler 排在 '*' handler 之前", () => {
    const bus = createToolEventBus();
    const order: string[] = [];
    bus.on('*', () => {
      order.push('wild-1');
      return undefined;
    });
    bus.on('after-call', () => {
      order.push('named-1');
      return undefined;
    });
    bus.on('*', () => {
      order.push('wild-2');
      return undefined;
    });
    bus.emit('after-call', makeInput());
    expect(order).toEqual(['named-1', 'wild-1', 'wild-2']);
  });

  it('handler 同步抛错不影响其他 handler，错误上报 onHandlerError', () => {
    const reported: ToolEventHandlerError[] = [];
    const bus = createToolEventBus({ onHandlerError: (info) => { reported.push(info); } });
    const calls: string[] = [];
    bus.on('after-call', () => {
      calls.push('first');
      throw new Error('boom');
    });
    bus.on('after-call', () => {
      calls.push('second');
      return undefined;
    });
    bus.emit('after-call', makeInput());
    expect(calls).toEqual(['first', 'second']);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.event).toBe('after-call');
    expect(reported[0]?.error instanceof Error).toBe(true);
  });

  it('handler 返回被拒绝的 promise：不会变成未处理拒绝，且被上报', async () => {
    const reported: ToolEventHandlerError[] = [];
    const bus = createToolEventBus({ onHandlerError: (info) => { reported.push(info); } });
    bus.on('call-error', () => Promise.reject(new Error('async boom')));
    bus.emit('call-error', makeInput());
    await stall();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error instanceof Error).toBe(true);
  });

  it('emitAsync 逐个 await 每个 handler（异步串行）', async () => {
    const bus = createToolEventBus();
    const order: string[] = [];
    bus.on('after-call', async () => {
      order.push('a-in');
      await stall();
      order.push('a-out');
    });
    bus.on('after-call', async () => {
      order.push('b-in');
      await stall();
      order.push('b-out');
    });
    await bus.emitAsync('after-call', makeInput());
    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out']);
  });

  it('emitAsync 会等所有 handler 完成后才 resolve', async () => {
    const bus = createToolEventBus();
    let done = false;
    bus.on('after-call', async () => {
      await stall();
      done = true;
    });
    await bus.emitAsync('after-call', makeInput());
    expect(done).toBe(true);
  });

  it('emitAsync 中某个 handler 抛错，后续 handler 仍会执行并上报', async () => {
    const reported: ToolEventHandlerError[] = [];
    const bus = createToolEventBus({ onHandlerError: (info) => { reported.push(info); } });
    const calls: string[] = [];
    bus.on('after-call', async () => {
      calls.push('first');
      throw new Error('boom');
    });
    bus.on('after-call', async () => {
      calls.push('second');
    });
    await bus.emitAsync('after-call', makeInput());
    expect(calls).toEqual(['first', 'second']);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error instanceof Error).toBe(true);
  });

  it('派发过程中卸载自己不影响本次派发的其他 handler', () => {
    const bus = createToolEventBus();
    const calls: string[] = [];
    const off = bus.on('before-call', () => {
      calls.push('self');
      off();
      return undefined;
    });
    bus.on('before-call', () => {
      calls.push('other');
      return undefined;
    });
    bus.emit('before-call', makeInput());
    bus.emit('before-call', makeInput());
    expect(calls).toEqual(['self', 'other', 'other']);
  });

  it('派发过程中新增的订阅者不会收到本次事件', () => {
    const bus = createToolEventBus();
    const calls: string[] = [];
    bus.on('after-call', () => {
      calls.push('first');
      bus.on('after-call', () => {
        calls.push('late');
        return undefined;
      });
      return undefined;
    });
    bus.emit('after-call', makeInput());
    expect(calls).toEqual(['first']);
    bus.emit('after-call', makeInput());
    expect(calls).toEqual(['first', 'first', 'late']);
  });

  it('clear() 清空全部订阅，clear(event) 只清指定事件', () => {
    const bus = createToolEventBus();
    bus.on('before-call', () => undefined);
    bus.on('*', () => undefined);
    expect(bus.listenerCount()).toBe(2);
    bus.clear('before-call');
    expect(bus.listenerCount()).toBe(1);
    expect(bus.listenerCount('*')).toBe(1);
    bus.clear();
    expect(bus.listenerCount()).toBe(0);
  });

  it("listenerCount 按事件统计，'*' 单独计数", () => {
    const bus = createToolEventBus();
    bus.on('after-call', () => undefined);
    bus.on('after-call', () => undefined);
    bus.on('*', () => undefined);
    expect(bus.listenerCount('after-call')).toBe(2);
    expect(bus.listenerCount('*')).toBe(1);
    expect(bus.listenerCount('call-error')).toBe(0);
    expect(bus.listenerCount()).toBe(3);
  });

  it('off(event, handler) 移除最先注册的那一条', () => {
    const bus = createToolEventBus();
    const calls: string[] = [];
    const handler = (): void => {
      calls.push('h');
    };
    bus.on('after-call', handler);
    bus.on('after-call', handler);
    bus.off('after-call', handler);
    bus.emit('after-call', makeInput());
    expect(calls).toEqual(['h']);
    expect(bus.listenerCount('after-call')).toBe(1);
  });

  it('多个 bus 实例互不干扰', () => {
    const a = createToolEventBus();
    const b = createToolEventBus();
    const calls: string[] = [];
    a.on('after-call', () => {
      calls.push('a');
      return undefined;
    });
    b.emit('after-call', makeInput());
    expect(calls).toEqual([]);
    a.emit('after-call', makeInput());
    expect(calls).toEqual(['a']);
  });

  it('模块级 on / emit 共用默认实例', () => {
    const calls: string[] = [];
    const off = on('call-skip', (p) => {
      calls.push(p.reason ?? '');
      return undefined;
    });
    try {
      emit('call-skip', makeInput({ reason: 'before-hook-deny' }));
      expect(calls).toEqual(['before-hook-deny']);
    } finally {
      off();
      clearToolEvents();
    }
  });

  it("非法事件名、非函数 handler、emit('*') 都抛 TypeError", () => {
    const bus = createToolEventBus();
    expect(() => bus.on('nope' as unknown as ToolEventName, () => undefined)).toThrow(TypeError);
    expect(() => bus.on('*', undefined as unknown as () => void)).toThrow(TypeError);
    expect(() => bus.emit('*' as unknown as ToolEvent, makeInput())).toThrow(TypeError);
  });
});