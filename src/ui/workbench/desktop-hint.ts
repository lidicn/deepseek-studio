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
import type { WidthObserver } from './width-observer';
import { createWidthObserver } from './width-observer';

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
  /** 共享宽度观察者。传入则复用同一个 resize 监听；缺省自建一个（仅测试用）。 */
  observer?: WidthObserver;
  /** 移动端视口：窄宽度不显示桌面提示（P2，手机/PWA 窄是常态）。 */
  mobile?: boolean;
}

export function mountDesktopHint(options: DesktopHintOptions): DesktopHintControl {
  const { parent } = options;
  const mobile = options.mobile ?? false;
  const observer = options.observer ?? createWidthObserver(
    typeof window !== 'undefined' ? window.innerWidth : WORKBENCH_BREAKPOINTS.compact,
  );
  let width = observer.width;
  let shown = false;

  const sync = (next: number): boolean => {
    width = next;
    // 移动端窄是常态，不提示"请用桌面窗口"（P2）。
    shown = !mobile && next < WORKBENCH_BREAKPOINTS.compact;
    // renderDesktopHint 幂等：show=false 时移除，true 时已存在则直接返回。
    renderDesktopHint(parent, shown);
    return shown;
  };

  let disposeResize: Disposer = () => {};
  disposeResize = observer.subscribe((next) => sync(next));

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