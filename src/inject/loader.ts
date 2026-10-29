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
  // lifecycle 尚未就绪时收到的重注入请求先挂起，就绪后补执行一次。
  let pendingReinject = false;

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
    if (!lifecycle) {
      pendingReinject = true;
      return;
    }
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
        // 不写 installed：origin 在文档早期可能取不到（如 srcdoc iframe / about:blank），
        // 一次误判不该把「本轮不注入」固化成「永远不注入」。
        console.warn('[injection-loader] origin not allowed:', locationOrigin());
        status = 'skipped';
        return { installed: false, status: 'skipped', generation, reason: 'origin-not-allowed' };
      }
      if (!verifyInstallOrder()) {
        installed = true;
        return { installed: false, status: 'failed', generation, reason: 'install-order' };
      }
      installed = true;
      generation += 1;
      status = 'running';
      void startLifecycle().finally(() => {
        // lifecycle 就绪后再开路由监听，消除 install 尾部的竞态窗口。
        navigation.start();
        if (pendingReinject) {
          pendingReinject = false;
          void reinject();
        }
      });
      return { installed: true, status: 'running', generation };
    },
    getLifecycle: () => lifecycle,
    getStatus: () => status,
    getGeneration: () => generation,
    async dispose(reason: 'manual' | 'pagehide' = 'manual'): Promise<void> {
      navigation.stop();
      if (lifecycle) await lifecycle.dispose(reason);
      lifecycle = undefined;
      installed = false;
      status = 'pending';
      pendingReinject = false;
      // 清掉全局缓存，避免 bootstrap 拿到已失效的实例。
      registry.delete(Symbol.for(SYMBOL_KEY));
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
