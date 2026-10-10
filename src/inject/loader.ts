/**
 * 注入加载器：在目标文档就绪时按既定顺序启动能力模块，在文档卸载 / 同文档路由切换时
 * 按上游资源管理规则完整回收，并支持重装载代数与幂等。
 *
 * 关键不变量：
 *  - 幂等：Symbol.for('deepseek-studio.injection-loader') 全局唯一，重复 install 不二次装载。
 *  - fail-closed：源不在白名单 → 状态 'skipped'，一个能力都不启动。
 *  - fail-open：装载时机断言失败 → 仅告警继续；路由重装载超限 → 告警跳过。
 *  - 资源所有权：stop 之后由上游 kernel 保证 snapshot 归零（验收跑 tests/desktop/inject-loader.test.ts）。
 */

import { isAllowedOrigin, DEFAULT_ORIGIN_WHITELIST } from './origin-guard';
import { createNavigationObserver, type NavigationObserver } from './navigation';
import { replaceContentDocumentLifecycle } from './lifecycle';
import type {
  ContentCapabilityController,
  ContentDocumentLifecycle,
  ContentLifecycleStopReason,
  InjectionBootstrapOptions,
  InjectionResult,
  InjectionStatus,
} from './types';

const SYMBOL_KEY = 'deepseek-studio.injection-loader';
const registry = new Map<symbol, Injector>();

function locationOrigin(): string | undefined {
  return (globalThis as { location?: { origin?: string } }).location?.origin;
}

async function defaultLifecycleFactory(options: {
  capabilities: readonly ContentCapabilityController[];
  onError?: (error: unknown, capabilityId: string) => void;
}): Promise<ContentDocumentLifecycle> {
  // v0.4：使用本地 lifecycle（取代缺失的 deepseek-pp 实现），保持注入加载器契约不变。
  return replaceContentDocumentLifecycle(options);
}

export interface Injector {
  install(): InjectionResult;
  getLifecycle(): ContentDocumentLifecycle | undefined;
  getStatus(): InjectionStatus;
  getGeneration(): number;
  dispose(reason?: ContentLifecycleStopReason): Promise<void>;
}

export function createInjector(options: InjectionBootstrapOptions): Injector {
  const whitelist = options.originWhitelist ?? DEFAULT_ORIGIN_WHITELIST;
  const factory = options.lifecycleFactory ?? defaultLifecycleFactory;
  const navigation: NavigationObserver = createNavigationObserver({
    reinjectOnRouteChange: options.reinjectOnRouteChange,
    maxReinjections: options.maxReinjections,
    onReinject: () => void reinject(),
    onLimit: (c) => console.warn(`[injection-loader] reinjection limit ${c} reached, skip`),
  });

  let lifecycle: ContentDocumentLifecycle | undefined;
  let status: InjectionStatus = 'pending';
  let generation = 0;
  let installed = false;

  function verifyInstallOrder(): boolean {
    const rs = (globalThis as { document?: { readyState?: string } }).document?.readyState;
    const ok = rs === 'loading' || rs === undefined;
    if (!ok && options.strictInstallOrder) {
      status = 'failed';
      return false;
    }
    if (!ok) console.warn('[injection-loader] readyState !== "loading"; proceeding (fail-open)');
    return true;
  }

  async function startLifecycle(): Promise<void> {
    try {
      lifecycle = await factory({
        capabilities: options.capabilities,
        onError: (error, _capabilityId) => {
          status = 'failed';
          options.onStartupError?.(error);
        },
      });
      await lifecycle.start();
      status = 'running';
    } catch (error) {
      status = 'failed';
      options.onStartupError?.(error);
    }
  }

  async function reinject(): Promise<void> {
    if (!lifecycle) return;
    await lifecycle.dispose('reinjection');
    generation += 1;
    await startLifecycle();
  }

  return {
    install(): InjectionResult {
      if (installed) {
        return { installed: false, status, generation, reason: 'already-installed' };
      }
      if (!isAllowedOrigin(locationOrigin(), whitelist)) {
        installed = true;
        status = 'skipped';
        return { installed: true, status: 'skipped', generation, reason: 'origin-not-allowed' };
      }
      if (!verifyInstallOrder()) {
        installed = true;
        return { installed: false, status: 'failed', generation, reason: 'install-order' };
      }
      installed = true;
      generation += 1;
      status = 'running';
      void startLifecycle();
      navigation.start();
      return { installed: true, status: 'running', generation };
    },
    getLifecycle: () => lifecycle,
    getStatus: () => status,
    getGeneration: () => generation,
    async dispose(reason: 'manual' | 'pagehide' = 'manual'): Promise<void> {
      navigation.stop();
      if (lifecycle) await lifecycle.dispose(reason);
    },
  };
}

/** 全局幂等入口：重复调用只第一次真正装载。同步执行，不返回 Promise。 */
export function bootstrapInjection(options: InjectionBootstrapOptions): InjectionResult {
  const sym = Symbol.for(SYMBOL_KEY);
  const existing = registry.get(sym);
  if (existing) return existing.install();
  const injector = createInjector(options);
  registry.set(sym, injector);
  return injector.install();
}
