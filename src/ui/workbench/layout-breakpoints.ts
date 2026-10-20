/**
 * 响应式断点：以 WORKBENCH_BREAKPOINTS 为唯一真相源，把窗口宽度映射成
 * #studio-workbench-root 上的 .is-wide / .is-medium / .is-compact / .is-desktop-only class。
 *
 * 为什么需要这个模块：此前断点有两套——agent.css 的 @media（1439/1199/899）
 * 与 layoutForWidth() + WORKBENCH_BREAKPOINTS。后者只被测试引用，
 * is-compact / is-desktop-only 这些 class 永远不会出现在真实 DOM 上。
 * 本模块把后者接到运行时，CSS 的 @media 随之删除，只剩一条真相源。
 *
 * 桌面提示（desktop-hint.ts）与这里共用同一个 resize 监听，不建两个。
 */

import { layoutForWidth } from './workbench-shell';
import { WORKBENCH_BREAKPOINTS } from '../ui-contract';
import type { Disposer } from '../disposer';
import { createWidthObserver, type WidthObserver } from './width-observer';

const LAYOUT_CLASSES = ['is-wide', 'is-medium', 'is-compact', 'is-desktop-only'] as const;

export interface LayoutBreakpointControl {
  /** 当前断点档位。 */
  readonly mode: string;
  /** 按指定宽度刷新 class，返回档位。幂等。 */
  sync(width: number): string;
  dispose(): void;
}

export interface LayoutBreakpointOptions {
  /** 布局根节点（#studio-workbench-root）。 */
  root: HTMLElement;
  /** 共享宽度观察者。传入则复用同一个 resize 监听；缺省自建一个（仅测试用）。 */
  observer?: WidthObserver;
}

export function mountLayoutBreakpoints(options: LayoutBreakpointOptions): LayoutBreakpointControl {
  const { root } = options;
  const observer = options.observer ?? createWidthObserver(
    typeof window !== 'undefined' ? window.innerWidth : WORKBENCH_BREAKPOINTS.wide,
  );
  let width = observer.width;
  let mode = layoutForWidth(width);

  const apply = (next: string): void => {
    // 先全清再单开：避免档位切换时残留上一个档位的 class。
    for (const cls of LAYOUT_CLASSES) root.classList.remove(cls);
    root.classList.add(`is-${next}`);
    root.dataset.layout = next;
  };

  const sync = (next: number): string => {
    width = next;
    mode = layoutForWidth(next);
    apply(mode);
    return mode;
  };

  let disposeResize: Disposer = () => {};
  disposeResize = observer.subscribe((next) => sync(next));

  sync(width);

  return {
    get mode() {
      return mode;
    },
    sync,
    dispose() {
      disposeResize();
      disposeResize = () => {};
    },
  };
}
