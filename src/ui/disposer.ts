/**
 * 生命周期 Disposer 工具
 *
 * 所有订阅、定时器、Observer 必须返回 disposer。
 * destroy() 必须幂等，逆序执行。
 */

export type Disposer = () => void;

export interface StudioDisposable {
  dispose(): void;
}

export interface DisposerBag extends Disposer {
  add(fn: Disposer): void;
  readonly disposed: boolean;
}

export function createDisposerBag(): DisposerBag {
  const fns: Disposer[] = [];
  let disposed = false;

  const bag = (() => {
    if (disposed) return;
    disposed = true;
    for (let i = fns.length - 1; i >= 0; i--) {
      try { fns[i](); } catch { /* ignore individual failure */ }
    }
    fns.length = 0;
  }) as DisposerBag;

  bag.add = (fn: Disposer) => {
    if (disposed) { try { fn(); } catch { /* ignore */ } return; }
    fns.push(fn);
  };

  Object.defineProperty(bag, 'disposed', { get: () => disposed });
  return bag;
}
