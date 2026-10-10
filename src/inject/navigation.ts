/**
 * 路由观察器：监听历史栈（pushState/replaceState）与哈希/弹栈变化，
 * 按策略决定是否触发能力模块重装载，带 maxReinjections 限流。
 *
 * 整篇文档重建不特殊处理：宿主对象随文档销毁、早期装载入口自然重跑形成新一代，
 * 装载器在新文档里识别并递增 generation（见 loader.ts）。
 */

export interface NavigationObserverOptions {
  /** 默认 false：路由变化不重装载。 */
  reinjectOnRouteChange?: boolean;
  /** 开启时的最大重装载次数，默认 8。 */
  maxReinjections?: number;
  /** 达到重装载条件时回调（由装载器执行 replace）。 */
  onReinject?: () => void;
  /** 达到上限时回调（告警，fail-open 跳过）。 */
  onLimit?: (count: number) => void;
}

export interface NavigationObserver {
  start(): void;
  stop(): void;
  readonly reinjectionCount: number;
}

export function createNavigationObserver(options: NavigationObserverOptions = {}): NavigationObserver {
  const enabled = options.reinjectOnRouteChange ?? false;
  const max = options.maxReinjections ?? 8;
  let count = 0;
  let stopped = false;
  const history = globalThis.history as
    | (History & { pushState: (s: unknown, t: string, url?: string | URL | null) => void; replaceState: (s: unknown, t: string, url?: string | URL | null) => void })
    | undefined;

  const trigger = (): void => {
    if (stopped || !enabled) return;
    if (count >= max) {
      options.onLimit?.(count);
      return;
    }
    count += 1;
    options.onReinject?.();
  };

  const patchedPush = history?.pushState?.bind(history);
  const patchedReplace = history?.replaceState?.bind(history);
  const onPop = (): void => trigger();

  if (enabled && history && patchedPush && patchedReplace) {
    history.pushState = (...args) => {
      patchedPush(...args);
      trigger();
    };
    history.replaceState = (...args) => {
      patchedReplace(...args);
      trigger();
    };
    globalThis.addEventListener('popstate', onPop);
    globalThis.addEventListener('hashchange', onPop);
  }

  return {
    start() {
      stopped = false;
    },
    stop() {
      stopped = true;
      if (enabled && history) {
        globalThis.removeEventListener('popstate', onPop);
        globalThis.removeEventListener('hashchange', onPop);
      }
    },
    get reinjectionCount() {
      return count;
    },
  };
}
