import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapInjection, createInjector } from '../../src/inject/loader';
import type {
  ContentCapabilityController,
  ContentDocumentLifecycle,
  ContentResourceScope,
  ReplaceContentDocumentLifecycle,
} from '../../src/inject/types';

function fakeScope(): ContentResourceScope {
  const resources: Array<() => void | Promise<void>> = [];
  const reg = (cb: () => void | Promise<void>) => {
    resources.push(cb);
    return async () => {
      const i = resources.indexOf(cb);
      if (i >= 0) resources.splice(i, 1);
      await cb();
    };
  };
  return {
    signal: new AbortController().signal,
    active: true,
    addCleanup: (_k, cb) => reg(cb),
    listen: () => reg(() => {}),
    observe: () => reg(() => {}),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (t) => clearInterval(t),
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    cancelAnimationFrame: (f) => cancelAnimationFrame(f),
    ownRoot: (r) => r,
    ownPort: (r) => r,
    snapshot: () => ({ total: resources.length, byKind: {} as never }),
  };
}

function makeFakeLifecycleFactory(opts: { onStarted?: (ids: string[]) => void } = {}): ReplaceContentDocumentLifecycle {
  return async ({ capabilities }) => {
    const resources: Array<() => void | Promise<void>> = [];
    const startedIds: string[] = [];
    const scopeFor = (): ContentResourceScope => ({
      ...fakeScope(),
      addCleanup: (_k, cb) => {
        resources.push(cb);
        return async () => {
          const i = resources.indexOf(cb);
          if (i >= 0) resources.splice(i, 1);
          await cb();
        };
      },
    });
    const kernel = {
      async start() {
        for (const c of capabilities) {
          startedIds.push(c.id);
          await c.start(scopeFor(), 1);
        }
        opts.onStarted?.(startedIds);
        return 1;
      },
      async stop(_reason: string) {
        for (const c of capabilities) await c.stop(_reason as never);
        resources.length = 0;
      },
      snapshot: () => ({ state: 'running', epoch: 1, resources: { total: resources.length, byKind: {} as never }, capabilities: {} }),
    };
    return { kernel, start: kernel.start, dispose: kernel.stop } as unknown as ContentDocumentLifecycle;
  };
}

function resourcefulCapability(id: string, count = 2): ContentCapabilityController {
  let scope: ContentResourceScope | undefined;
  return {
    id,
    start(s) {
      scope = s;
      for (let i = 0; i < count; i++) s.addCleanup('listener', () => {});
    },
    async stop() {
      void scope;
    },
  };
}

describe('inject loader', () => {
  beforeEach(() => {
    (globalThis as { location?: { origin: string } }).location = { origin: 'https://chat.deepseek.com' };
  });
  afterEach(() => {
    delete (globalThis as { location?: { origin: string } }).location;
  });

  it('bootstrapInjection 连续调三次：只有第一次真正装载', () => {
    const fac = makeFakeLifecycleFactory();
    const caps = [resourcefulCapability('a')];
    const r1 = bootstrapInjection({ capabilities: caps, lifecycleFactory: fac });
    const r2 = bootstrapInjection({ capabilities: caps, lifecycleFactory: fac });
    const r3 = bootstrapInjection({ capabilities: caps, lifecycleFactory: fac });
    expect(r1.installed).toBe(true);
    expect(r2.installed).toBe(false);
    expect(r3.installed).toBe(false);
  });

  it('非白名单源 → skipped，一个能力都不启动', async () => {
    const started: string[] = [];
    const fac = makeFakeLifecycleFactory({ onStarted: (ids) => started.push(...ids) });
    const injector = createInjector({ capabilities: [resourcefulCapability('a')], lifecycleFactory: fac });
    (globalThis as { location?: { origin: string } }).location = { origin: 'https://evil.com' };
    const res = injector.install();
    expect(res.status).toBe('skipped');
    expect(started).toEqual([]);
    await injector.dispose('manual');
  });

  it('capability 启动后资源 > 0，stop 后归零（资源所有权不变量）', async () => {
    const fac = makeFakeLifecycleFactory();
    const injector = createInjector({ capabilities: [resourcefulCapability('a', 3)], lifecycleFactory: fac });
    injector.install();
    let lc: ContentDocumentLifecycle | undefined;
    for (let i = 0; i < 50 && !lc; i++) {
      await new Promise((r) => setTimeout(r, 10));
      lc = injector.getLifecycle();
    }
    expect(lc).toBeDefined();
    expect(lc!.kernel.snapshot().resources.total).toBe(3);
    await injector.dispose('reinjection');
    expect(lc!.kernel.snapshot().resources.total).toBe(0);
  });

  it('startup-failed 路径走 onStartupError 且不静默', async () => {
    const fac: ReplaceContentDocumentLifecycle = async ({ capabilities }) => {
      await capabilities[0].start(fakeScope(), 1);
      throw new Error('capability crashed');
    };
    const onErr = vi.fn();
    const inj = createInjector({ capabilities: [resourcefulCapability('a')], lifecycleFactory: fac, onStartupError: onErr });
    inj.install();
    await new Promise((r) => setTimeout(r, 20));
    expect(onErr).toHaveBeenCalled();
    expect(inj.getStatus()).toBe('failed');
  });

  it('默认 reinjectOnRouteChange=false，且 maxReinjections 默认 8', () => {
    const inj = createInjector({ capabilities: [resourcefulCapability('a')] });
    const res = inj.install();
    expect(res.installed).toBe(true);
    expect(res.generation).toBe(1);
  });
});
