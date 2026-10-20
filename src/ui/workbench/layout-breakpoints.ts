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

/**
 * 是否按"移动端浏览器"对待。
 *
 * 需要区分两种窄宽度：
 *   - 桌面窗口被拖窄 → 显示"请在桌面窗口使用"提示（is-desktop-only）
 *   - 手机/PWA 浏览器 → 本来就窄，应当按 compact 正常使用（P2）
 * 判定用 pointer:coarse + 无 hover 能力（触摸设备），叠加 UA 里的 Mobile 关键词兜底。
 * jsdom 下 matchMedia 返回 matches=false，测试需显式 stub。
 */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const noHover = window.matchMedia('(hover: none)').matches;
    if (coarse && noHover) return true;
  } catch {
    /* ignore：探测失败时退回 UA 判断 */
  }
  if (typeof navigator === 'undefined') return false;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent ?? '');
}

export interface LayoutBreakpointControl {
  /** 当前断点档位。 */
  readonly mode: string;
  /** 是否为移动端视口（窄宽度按 compact 处理，不降级桌面提示）。 */
  readonly mobile: boolean;
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

  // 移动端：窄是常态，不降级到 desktop-only（P2）。
  const mobile = isMobileViewport();
  // 写 .is-mobile 到 <html>：移动端专用样式（16px 输入框、安全区、触控尺寸）
  // 由 CSS 消费，不在 JS 里逐条改样式。
  if (mobile && typeof document !== 'undefined') {
    document.documentElement.classList.add('is-mobile');
  }
  if (mobile && mode === 'desktop-only') mode = 'compact';

  const apply = (next: string): void => {
    // 先全清再单开：避免档位切换时残留上一个档位的 class。
    for (const cls of LAYOUT_CLASSES) root.classList.remove(cls);
    root.classList.add(`is-${next}`);
    root.dataset.layout = next;
  };

  const sync = (next: number): string => {
    width = next;
    const raw = layoutForWidth(next);
    mode = mobile && raw === 'desktop-only' ? 'compact' : raw;
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
    /** 是否为移动端视口（窄宽度不降级为桌面提示）。 */
    get mobile() {
      return mobile;
    },
    dispose() {
      disposeResize();
      disposeResize = () => {};
    },
  };
}
