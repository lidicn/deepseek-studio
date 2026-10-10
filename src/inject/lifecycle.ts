/**
 * 本地 content lifecycle（v0.4 取代缺失的 deepseek-pp 实现）
 *
 * 注入页内只需持有已装配的能力，并在文档生命周期边界调用其 start/stop；
 * 真实能力的工作发生在 host-client 经 ws 路由来的 execute() 调用，而非 start/stop。
 * 因此此处提供最小可用的 scope 与 kernel，保持注入加载器（loader.ts）契约不变，
 * 并消除 loader.ts 对 deepseek-pp/src/entrypoints/content/lifecycle 的动态 import 依赖。
 */

import type {
  ContentCapabilityController,
  ContentDocumentLifecycle,
  ContentResourceScope,
  ReplaceContentDocumentLifecycle,
} from './types';

function noopScope(): ContentResourceScope {
  const noop = (): void => undefined;
  return {
    signal: new AbortController().signal,
    active: true,
    addCleanup: () => async () => noop(),
    listen: () => async () => noop(),
    observe: () => async () => noop(),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (t) => clearInterval(t),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (f) => clearTimeout(f as unknown as ReturnType<typeof setTimeout>),
    ownRoot: (r) => r,
    ownPort: (r) => r,
    snapshot: () => ({ total: 0, byKind: {} as never }),
  };
}

export function createLocalContentLifecycle(options: {
  capabilities: readonly ContentCapabilityController[];
}): ContentDocumentLifecycle {
  const caps = options.capabilities;
  const kernel = {
    async start(): Promise<number> {
      for (const c of caps) await c.start(noopScope(), 1);
      return 1;
    },
    async stop(_reason: string): Promise<void> {
      for (const c of caps) await c.stop(_reason as never);
    },
    snapshot: () => ({
      state: 'running' as const,
      epoch: 1,
      resources: { total: 0, byKind: {} as never },
      capabilities: {},
    }),
  };
  return { kernel, start: kernel.start, dispose: kernel.stop };
}

export const replaceContentDocumentLifecycle: ReplaceContentDocumentLifecycle = async (options) =>
  createLocalContentLifecycle({ capabilities: options.capabilities });
