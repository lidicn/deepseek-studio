/**
 * 窗口宽度观察者：全局唯一一个 resize 监听，多个消费者订阅。
 *
 * 存在的理由：桌面提示（desktop-hint）与断点档位（layout-breakpoints）都要响应
 * 宽度变化。各建一个 resize 监听会有两份状态、两次回调，且难以统一退订。
 * 这里收成一个：只在宽度真实变化时通知，宽度不变不打扰订阅者。
 */

import type { Disposer } from '../disposer';

export interface WidthObserver {
  /** 当前宽度。 */
  readonly width: number;
  /** 订阅宽度变化；立即以当前宽度回调一次。返回 disposer。 */
  subscribe(listener: (width: number) => void): Disposer;
  dispose(): void;
}

export function createWidthObserver(initialWidth: number): WidthObserver {
  let width = initialWidth;
  const listeners = new Set<(width: number) => void>();
  let attached = false;

  const onResize = () => {
    const next = window.innerWidth;
    if (next === width) return;
    width = next;
    for (const l of Array.from(listeners)) l(width);
  };

  const attach = () => {
    if (attached || typeof window === 'undefined') return;
    window.addEventListener('resize', onResize);
    attached = true;
  };

  const detach = () => {
    if (!attached) return;
    window.removeEventListener('resize', onResize);
    attached = false;
  };

  attach();

  return {
    get width() {
      return width;
    },
    subscribe(listener) {
      listeners.add(listener);
      attach();
      // 立即回调一次，让订阅者以当前宽度完成首次同步。
      listener(width);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detach();
      };
    },
    dispose() {
      listeners.clear();
      detach();
    },
  };
}
