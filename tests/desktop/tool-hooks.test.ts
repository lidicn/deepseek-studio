import { describe, expect, it } from 'vitest';

import { clearHooks, createToolHooks, registerBefore, runBefore } from '../../src/shared/tool-hooks';
import type {
  AfterToolCallHook,
  BeforeToolCallHook,
  ToolCallParams,
  ToolCallResult,
  ToolHookError,
} from '../../src/shared/tool-hooks';

/** 微任务级停顿：不依赖定时器，用于验证"异步串行"语义。 */
async function stall(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('tool-hooks · runBefore（before 钩子闸门）', () => {
  it('无任何钩子时直通：proceed=true，params 保持同一引用', async () => {
    const hooks = createToolHooks();
    const params: ToolCallParams = { cmd: 'ls' };
    const out = await hooks.runBefore('shell.exec', params);
    expect(out.proceed).toBe(true);
    expect(out.params).toBe(params);
    expect(out.hookErrors).toEqual([]);
  });

  it('before 钩子返回 false → proceed=false，工具不应执行', async () => {
    const hooks = createToolHooks();
    let hookCalls = 0;
    hooks.registerBefore('shell.exec', () => {
      hookCalls += 1;
      return false;
    });
    const out = await hooks.runBefore('shell.exec', { cmd: 'rm -rf /' });
    expect(out.proceed).toBe(false);
    expect(out.reason).toBe('before-hook-deny');
    expect(hookCalls).toBe(1);
  });

  it('before 钩子返回 { params } → 参数被整体替换', async () => {
    const hooks = createToolHooks();
    hooks.registerBefore('shell.exec', (params) => ({ params: { ...params, timeout: 30 } }));
    const out = await hooks.runBefore('shell.exec', { timeout: 1, cmd: 'ls' });
    expect(out.proceed).toBe(true);
    expect(out.params).toEqual({ timeout: 30, cmd: 'ls' });
  });

  it('多个 before 钩子按注册顺序串行，后一个看到前一个改写后的参数', async () => {
    const hooks = createToolHooks();
    const seen: ToolCallParams[] = [];
    hooks.registerBefore('*', (params) => ({ params: { ...params, step: 1 } }));
    hooks.registerBefore('shell.exec', (params) => {
      seen.push(params);
      return undefined;
    });
    const out = await hooks.runBefore('shell.exec', {});
    expect(seen).toEqual([{ step: 1 }]);
    expect(out.params).toEqual({ step: 1 });
  });

  it('异步 before 钩子被逐个 await（串行而非并发）', async () => {
    const hooks = createToolHooks();
    const order: string[] = [];
    const seen: ToolCallParams[] = [];
    hooks.registerBefore('*', async (params) => {
      order.push('first-in');
      await stall();
      order.push('first-out');
      return { params: { ...params, step: 1 } };
    });
    hooks.registerBefore('shell.exec', async (params) => {
      order.push('second-in');
      seen.push(params);
      return undefined;
    });
    const out = await hooks.runBefore('shell.exec', {});
    expect(order).toEqual(['first-in', 'first-out', 'second-in']);
    expect(seen).toEqual([{ step: 1 }]);
    expect(out.params).toEqual({ step: 1 });
  });

  it("'*' 通配钩子对所有工具生效", async () => {
    const hooks = createToolHooks();
    const hit: string[] = [];
    hooks.registerBefore('*', (_params, ctx) => {
      hit.push(ctx.toolName);
      return undefined;
    });
    await hooks.runBefore('shell.exec', {});
    await hooks.runBefore('file.read', {});
    await hooks.runBefore('python.exec', {});
    expect(hit).toEqual(['shell.exec', 'file.read', 'python.exec']);
  });

  it('具名钩子只作用于同名工具', async () => {
    const hooks = createToolHooks();
    let calls = 0;
    hooks.registerBefore('shell.exec', () => {
      calls += 1;
      return false;
    });
    const other = await hooks.runBefore('file.read', {});
    expect(calls).toBe(0);
    expect(other.proceed).toBe(true);
    const mine = await hooks.runBefore('shell.exec', {});
    expect(calls).toBe(1);
    expect(mine.proceed).toBe(false);
  });

  it("具名与 '*' 混排时严格按注册先后执行", async () => {
    const hooks = createToolHooks();
    const order: string[] = [];
    hooks.registerBefore('shell.exec', () => {
      order.push('named-1');
      return undefined;
    });
    hooks.registerBefore('*', () => {
      order.push('wild-1');
      return undefined;
    });
    hooks.registerBefore('shell.exec', () => {
      order.push('named-2');
      return undefined;
    });
    await hooks.runBefore('shell.exec', {});
    expect(order).toEqual(['named-1', 'wild-1', 'named-2']);
  });

  it('before 钩子返回 false 后短路，后续钩子不再执行', async () => {
    const hooks = createToolHooks();
    const order: string[] = [];
    hooks.registerBefore('*', () => {
      order.push('first');
      return false;
    });
    hooks.registerBefore('*', () => {
      order.push('second');
      return undefined;
    });
    const out = await hooks.runBefore('shell.exec', {});
    expect(out.proceed).toBe(false);
    expect(order).toEqual(['first']);
  });

  it('before 钩子抛错 → fail-closed（proceed=false）并上报 onHookError', async () => {
    const errors: ToolHookError[] = [];
    const hooks = createToolHooks({ onHookError: (e) => { errors.push(e); } });
    let laterRan = false;
    hooks.registerBefore('shell.exec', () => {
      throw new Error('boom');
    });
    hooks.registerBefore('shell.exec', () => {
      laterRan = true;
      return undefined;
    });
    const out = await hooks.runBefore('shell.exec', { a: 1 });
    expect(out.proceed).toBe(false);
    expect(out.reason).toBe('hook-threw');
    expect(out.params).toEqual({ a: 1 });
    expect(laterRan).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.phase).toBe('before');
    expect(errors[0]?.reason).toBe('hook-threw');
    expect(errors[0]?.error instanceof Error).toBe(true);
  });

  it('before 钩子返回非法值 → fail-closed 并上报 onHookError', async () => {
    const errors: ToolHookError[] = [];
    const hooks = createToolHooks({ onHookError: (e) => { errors.push(e); } });
    hooks.registerBefore('shell.exec', (() => true) as unknown as BeforeToolCallHook);
    const out = await hooks.runBefore('shell.exec', {});
    expect(out.proceed).toBe(false);
    expect(out.reason).toBe('hook-invalid-return');
    expect(errors[0]?.reason).toBe('hook-invalid-return');
  });

  it('registerBefore 返回的卸载函数会移除钩子，且重复调用安全', async () => {
    const hooks = createToolHooks();
    let calls = 0;
    const off = hooks.registerBefore('*', () => {
      calls += 1;
      return undefined;
    });
    await hooks.runBefore('shell.exec', {});
    expect(calls).toBe(1);
    off();
    off();
    await hooks.runBefore('shell.exec', {});
    expect(calls).toBe(1);
    expect(hooks.hookCount().before).toBe(0);
  });

  it('registerBefore / registerAfter 对非法 toolName / 非法 hook 抛 TypeError', () => {
    const hooks = createToolHooks();
    expect(() => hooks.registerBefore('', () => undefined)).toThrow(TypeError);
    expect(() =>
      hooks.registerBefore('shell.exec', undefined as unknown as BeforeToolCallHook),
    ).toThrow(TypeError);
    expect(() => hooks.registerAfter('shell.exec', 42 as unknown as AfterToolCallHook)).toThrow(
      TypeError,
    );
  });

  it('clearHooks 清空后回到直通', async () => {
    const hooks = createToolHooks();
    hooks.registerBefore('*', () => false);
    hooks.registerAfter('*', () => ({ ok: false }));
    expect(hooks.hookCount()).toEqual({ before: 1, after: 1 });
    hooks.clearHooks();
    expect(hooks.hookCount()).toEqual({ before: 0, after: 0 });
    const out = await hooks.runBefore('shell.exec', {});
    expect(out.proceed).toBe(true);
  });
});

describe('tool-hooks · runAfter（after 钩子改写）', () => {
  it('无任何钩子时直通：结果保持同一引用', async () => {
    const hooks = createToolHooks();
    const result: ToolCallResult = { ok: true, data: { stdout: 'hi' } };
    const out = await hooks.runAfter('shell.exec', {}, result);
    expect(out).toBe(result);
  });

  it('after 钩子返回对象 → 结果被替换', async () => {
    const hooks = createToolHooks();
    hooks.registerAfter('shell.exec', (_params, result) => ({
      ...result,
      ok: false,
      isError: true,
      content: [{ type: 'text', text: '被改写了' }],
    }));
    const result: ToolCallResult = { ok: true, content: [{ type: 'text', text: '原始输出' }] };
    const out = await hooks.runAfter('shell.exec', {}, result);
    expect(out).not.toBe(result);
    expect(out.isError).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.content).toEqual([{ type: 'text', text: '被改写了' }]);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: '原始输出' }]);
  });

  it('after 钩子返回 undefined → 结果不变（同一引用、字段未改）', async () => {
    const hooks = createToolHooks();
    hooks.registerAfter('shell.exec', () => undefined);
    const result: ToolCallResult = { ok: true, content: [{ type: 'text', text: 'x' }] };
    const out = await hooks.runAfter('shell.exec', {}, result);
    expect(out).toBe(result);
    expect(out).toEqual({ ok: true, content: [{ type: 'text', text: 'x' }] });
  });

  it('after 钩子可修改 content / details / isError / terminate（返回替换）', async () => {
    const hooks = createToolHooks();
    hooks.registerAfter('shell.exec', (_params, result) => ({
      ...result,
      content: [{ type: 'text', text: 'final' }],
      details: { ...(result.details ?? {}), exitCode: 3 },
      isError: true,
      terminate: true,
    }));
    const out = await hooks.runAfter('shell.exec', {}, { ok: true });
    expect(out.content).toEqual([{ type: 'text', text: 'final' }]);
    expect(out.details).toEqual({ exitCode: 3 });
    expect(out.isError).toBe(true);
    expect(out.terminate).toBe(true);
  });

  it('after 钩子原地改字段并返回 undefined 时，改动同样生效（共享引用语义）', async () => {
    const hooks = createToolHooks();
    hooks.registerAfter('shell.exec', (_params, result) => {
      result.isError = true;
      result.details = { ...(result.details ?? {}), note: 'in-place' };
      return undefined;
    });
    const result: ToolCallResult = { ok: true, details: {} };
    const out = await hooks.runAfter('shell.exec', {}, result);
    expect(out).toBe(result);
    expect(out.isError).toBe(true);
    expect(out.details).toEqual({ note: 'in-place' });
  });

  it('多个 after 钩子串行，后一个看到前一个替换后的结果', async () => {
    const hooks = createToolHooks();
    const seen: Array<ToolCallResult | undefined> = [];
    hooks.registerAfter('shell.exec', (_params, result) => ({ ...result, details: { step: 1 } }));
    hooks.registerAfter('*', (_params, result) => {
      seen.push(result);
      return undefined;
    });
    await hooks.runAfter('shell.exec', {}, { ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.details).toEqual({ step: 1 });
  });

  it('after 钩子抛错 → fail-open：保持当前结果、后续钩子照跑、并上报', async () => {
    const errors: ToolHookError[] = [];
    const hooks = createToolHooks({ onHookError: (e) => { errors.push(e); } });
    let laterRan = false;
    hooks.registerAfter('shell.exec', () => {
      throw new Error('boom');
    });
    hooks.registerAfter('shell.exec', (_params, result) => {
      laterRan = true;
      return { ...result, terminate: true };
    });
    const result: ToolCallResult = { ok: true };
    const out = await hooks.runAfter('shell.exec', {}, result);
    expect(laterRan).toBe(true);
    expect(out).not.toBe(result);
    expect(out.ok).toBe(true);
    expect(out.terminate).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.phase).toBe('after');
    expect(errors[0]?.reason).toBe('hook-threw');
  });

  it('after 钩子返回非法值 → fail-open，保持当前结果并上报', async () => {
    const errors: ToolHookError[] = [];
    const hooks = createToolHooks({ onHookError: (e) => { errors.push(e); } });
    hooks.registerAfter('shell.exec', (() => 'nope') as unknown as AfterToolCallHook);
    const result: ToolCallResult = { ok: true };
    const out = await hooks.runAfter('shell.exec', {}, result);
    expect(out).toBe(result);
    expect(errors[0]?.reason).toBe('hook-invalid-return');
  });

  it("'*' 通配 after 钩子对所有工具生效，并能拿到本次 toolName", async () => {
    const hooks = createToolHooks();
    const hit: string[] = [];
    hooks.registerAfter('*', (_params, result, ctx) => {
      hit.push(ctx.toolName);
      return { ...result, details: { ...(result.details ?? {}), seen: ctx.toolName } };
    });
    const a = await hooks.runAfter('shell.exec', {}, { ok: true });
    const b = await hooks.runAfter('file.read', {}, { ok: true });
    expect(hit).toEqual(['shell.exec', 'file.read']);
    expect(a.details).toEqual({ seen: 'shell.exec' });
    expect(b.details).toEqual({ seen: 'file.read' });
  });

  it('after 钩子拿到的 params 是 runAfter 传入的参数', async () => {
    const hooks = createToolHooks();
    let captured: ToolCallParams | undefined;
    hooks.registerAfter('shell.exec', (params) => {
      captured = params;
      return undefined;
    });
    await hooks.runAfter('shell.exec', { path: '/tmp/a' }, { ok: true });
    expect(captured).toEqual({ path: '/tmp/a' });
  });
});

describe('tool-hooks · 默认注册表（模块级 API）', () => {
  it('模块级 registerBefore / runBefore / clearHooks 共用同一注册表', async () => {
    const off = registerBefore('*', () => ({ params: { patched: true } }));
    try {
      const out = await runBefore('any.tool', { patched: false });
      expect(out.params).toEqual({ patched: true });
    } finally {
      off();
      clearHooks();
    }
  });
});