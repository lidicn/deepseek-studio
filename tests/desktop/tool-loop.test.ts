import { describe, expect, it } from 'vitest';

import { createToolHooks } from '../../src/shared/tool-hooks';
import type { ToolCallParams, ToolCallResult } from '../../src/shared/tool-hooks';
import { createToolEventBus } from '../../src/shared/tool-event-bus';
import type { ToolEventPayload } from '../../src/shared/tool-event-bus';
import { runToolCall } from '../../src/shared/tool-loop';

function makeDeps() {
  const hooks = createToolHooks();
  const events = createToolEventBus();
  const seen: ToolEventPayload[] = [];
  events.on('*', (payload) => {
    seen.push(payload);
    return undefined;
  });
  return { hooks, events, seen };
}

describe('tool-loop · runToolCall', () => {
  it('正常路径：before 改写参数 → execute 收到新参数；after 改写结果；after-call 带最终结果与 durationMs', async () => {
    const { hooks, events, seen } = makeDeps();
    hooks.registerBefore('shell.exec', (params) => ({ params: { ...params, limit: 100 } }));
    hooks.registerAfter('shell.exec', (_params, result) => ({ ...result, terminate: true }));

    let captured: ToolCallParams | undefined;
    let clock = 0;
    const result = await runToolCall({
      toolName: 'shell.exec',
      params: { cmd: 'ls' },
      hooks,
      events,
      now: () => {
        clock += 5;
        return clock;
      },
      execute: (params) => {
        captured = params;
        return { ok: true, content: [{ type: 'text', text: 'out' }] };
      },
    });

    expect(captured).toEqual({ cmd: 'ls', limit: 100 });
    expect(result.content).toEqual([{ type: 'text', text: 'out' }]);
    expect(result.terminate).toBe(true);
    expect(seen.map((p) => p.event)).toEqual(['before-call', 'after-call']);
    const afterEvent = seen[1] as ToolEventPayload;
    expect(afterEvent.result).toBe(result);
    expect(afterEvent.durationMs).toBe(5);
  });

  it('before 钩子拦截：execute 不执行，发 call-skip，结果 isError + terminate', async () => {
    const { hooks, events, seen } = makeDeps();
    hooks.registerBefore('*', () => false);
    let executed = 0;

    const result = await runToolCall({
      toolName: 'shell.exec',
      params: { cmd: 'rm -rf /' },
      hooks,
      events,
      execute: () => {
        executed += 1;
        return { ok: true };
      },
    });

    expect(executed).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.terminate).toBe(true);
    expect(result.details?.reason).toBe('before-hook-deny');
    expect(seen.map((p) => p.event)).toEqual(['call-skip']);
    expect(seen[0]?.result).toBeUndefined();
    expect(seen[0]?.durationMs).toBeUndefined();
    expect(seen[0]?.reason).toBe('before-hook-deny');
  });

  it('execute 抛错：发 call-error（含 error），结果 isError，after 钩子仍可改写', async () => {
    const { hooks, events, seen } = makeDeps();
    hooks.registerAfter('shell.exec', (_params, result) => ({ ...result, terminate: true }));

    const result = await runToolCall({
      toolName: 'shell.exec',
      params: {},
      hooks,
      events,
      execute: () => {
        throw new Error('spawn failed');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'spawn failed' }]);
    expect(result.details?.code).toBe('call-error');
    expect(seen.map((p) => p.event)).toEqual(['before-call', 'call-error']);
    const errEvent = seen[1] as ToolEventPayload;
    expect(errEvent.error instanceof Error).toBe(true);
    expect(errEvent.result).toBe(result);
    expect(typeof errEvent.durationMs).toBe('number');
  });

  it('execute 返回 isError 结果走 after-call，而不是 call-error', async () => {
    const { hooks, events, seen } = makeDeps();
    const raw: ToolCallResult = { ok: false, isError: true, content: [{ type: 'text', text: 'nope' }] };
    const result = await runToolCall({
      toolName: 'shell.exec',
      params: {},
      hooks,
      events,
      execute: () => raw,
    });
    expect(result).toBe(raw);
    expect(seen.map((p) => p.event)).toEqual(['before-call', 'after-call']);
  });

  it('事件顺序：before-call 早于 after-call，且各只发一次', async () => {
    const { hooks, events, seen } = makeDeps();
    await runToolCall({
      toolName: 'file.read',
      params: { path: '/tmp/a' },
      hooks,
      events,
      execute: () => ({ ok: true }),
    });
    expect(seen.map((p) => p.event)).toEqual(['before-call', 'after-call']);
    expect(seen.map((p) => p.toolName)).toEqual(['file.read', 'file.read']);
  });

  it('terminateOnSkip=false 时跳过结果不带 terminate', async () => {
    const { hooks, events } = makeDeps();
    hooks.registerBefore('*', () => false);
    const result = await runToolCall({
      toolName: 'shell.exec',
      params: {},
      hooks,
      events,
      terminateOnSkip: false,
      execute: () => ({ ok: true }),
    });
    expect(result.isError).toBe(true);
    expect(result.terminate).toBeUndefined();
  });

  it('callId 透传到钩子 context 与事件 payload', async () => {
    const { hooks, events, seen } = makeDeps();
    let seenCallId: string | undefined;
    hooks.registerBefore('*', (_params, ctx) => {
      seenCallId = ctx.callId;
      return undefined;
    });
    await runToolCall({
      toolName: 'shell.exec',
      params: {},
      hooks,
      events,
      callId: 'c-1',
      execute: () => ({ ok: true }),
    });
    expect(seenCallId).toBe('c-1');
    expect(seen[0]?.callId).toBe('c-1');
    expect(seen[1]?.callId).toBe('c-1');
  });

  it('无钩子无订阅时 runToolCall 等价于直接执行（结果同一引用）', async () => {
    const hooks = createToolHooks();
    const events = createToolEventBus();
    const raw: ToolCallResult = { ok: true, data: { stdout: 'x' } };
    const out = await runToolCall({
      toolName: 'shell.exec',
      params: {},
      hooks,
      events,
      execute: () => raw,
    });
    expect(out).toBe(raw);
  });
});