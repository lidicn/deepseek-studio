/**
 * 桌面提示：窗口宽度不足时提示"请在桌面窗口使用"。
 *
 * 显隐由 JS 按 WORKBENCH_BREAKPOINTS.compact 判定并创建/移除 DOM 节点，
 * CSS 只负责样式不负责显隐——避免"JS 以为建了、CSS 却藏着"的两套状态。
 * 与 workbench-shell 的 renderDesktopHint 共用同一阈值常量，不写死 900。
 */

import { renderDesktopHint } from './workbench-shell';
import { WORKBENCH_BREAKPOINTS } from '../ui-contract';
import type { Disposer } from '../disposer';

export interface DesktopHintControl {
  /** 当前是否显示提示（宽度 < compact 断点）。 */
  readonly shown: boolean;
  /** 按指定宽度刷新显隐，返回刷新后的状态。幂等。 */
  sync(width: number): boolean;
  dispose(): void;
}

export interface DesktopHintOptions {
  /** 提示挂载点（`#app`）。 */
  parent: HTMLElement;
  /** 初始宽度；缺省 `window.innerWidth`。 */
  width?: number;
  /** 是否监听 window resize；缺省 true。测试可关掉。 */
  observeResize?: boolean;
}

export function mountDesktopHint(options: DesktopHintOptions): DesktopHintControl {
  const { parent } = options;
  const observeResize = options.observeResize ?? true;
  let width = options.width
    ?? (typeof window !== 'undefined' ? window.innerWidth : WORKBENCH_BREAKPOINTS.compact);
  let shown = false;

  const sync = (next: number): boolean => {
    width = next;
    shown = next < WORKBENCH_BREAKPOINTS.compact;
    // renderDesktopHint 幂等：show=false 时移除，true 时已存在则直接返回。
    renderDesktopHint(parent, shown);
    return shown;
  };

  let disposeResize: Disposer = () => {};
  if (observeResize && typeof window !== 'undefined') {
    const onResize = () => {
      const next = window.innerWidth;
      if (next === width) return;
      sync(next);
    };
    window.addEventListener('resize', onResize);
    disposeResize = () => window.removeEventListener('resize', onResize);
  }

  sync(width);

  return {
    get shown() {
      return shown;
    },
    sync,
    dispose() {
      disposeResize();
      disposeResize = () => {};
    },
  };
}
