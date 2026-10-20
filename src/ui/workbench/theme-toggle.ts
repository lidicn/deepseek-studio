/**
 * 主题切换：默认浅色，用户点击图标切深色，选择记 localStorage，下次启动沿用。
 *
 * 优先级（与施工计划 §7.4 一致，用户显式选择最高）：
 *   1. localStorage 里用户上次选的主题
 *   2. host-theme-adapter 探测（宿主 data-theme / prefers-color-scheme）
 *   3. 默认 light
 *
 * 落地方式：调 applyWorkbenchTheme 把 token 写进 documentElement.style（运行时权威）；
 * 仅当用户显式选择过，才写 data-theme 属性（让 CSS 的 :root[data-theme] 静态兜底也切到深色）。
 * 用户未选择时刻意不写 data-theme —— 否则 host-theme-adapter.getTheme() 会优先读到它，
 * 把"跟随系统"变成"被自己写死"，系统切深色时无法透传。
 */

import { applyWorkbenchTheme, type WorkbenchTheme } from './workbench-theme';
import { createHostThemeAdapter } from '../host-theme-adapter';

export type { WorkbenchTheme } from './workbench-theme';

const STORAGE_KEY = 'ds-studio-theme';

export interface ThemeToggleControl {
  /** 当前生效主题。 */
  readonly theme: WorkbenchTheme;
  /** 设置主题（用户显式选择，写入 localStorage）。 */
  set(theme: WorkbenchTheme): void;
  /** 切换并返回切换后的主题。 */
  toggle(): WorkbenchTheme;
  dispose(): void;
}

/** localStorage 读写全部 try/catch：隐私模式或禁用存储时降级为"仅本次会话生效"，不得抛到调用方。 */
function readStoredTheme(): WorkbenchTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: WorkbenchTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* 忽略：存储不可用时不阻断主题切换 */
  }
}

export interface ThemeToggleOptions {
  /** 切换按钮（顶栏 🌗）。 */
  toggleButton?: HTMLElement | null;
}

export function mountThemeToggle(options: ThemeToggleOptions = {}): ThemeToggleControl {
  const stored = readStoredTheme();
  const host = createHostThemeAdapter();
  // 用户选过就用用户的；否则按宿主/系统探测；探测异常时 host-theme-adapter 自己兜底 light。
  const userChose = stored !== null;
  let theme: WorkbenchTheme = stored ?? host.getTheme();

  const apply = (next: WorkbenchTheme): void => {
    theme = next;
    applyWorkbenchTheme(next);
    options.toggleButton?.setAttribute('aria-pressed', String(next === 'dark'));
  };

  apply(theme);

  // 用户上次选过：本次启动就写 data-theme，让 CSS 静态兜底与运行时 token 保持同一主题。
  if (userChose) document.documentElement.setAttribute('data-theme', theme);

  // 用户未显式选择时跟随系统变化；选过就不再跟随（用户意图优先）。
  let disposeObserve = () => {};
  if (!userChose) {
    disposeObserve = host.observe((detected) => {
      if (readStoredTheme()) return;
      apply(detected);
    });
  }

  /** 用户显式选择主题：写 data-theme、停掉系统跟随。 */
  const choose = (next: WorkbenchTheme): void => {
    writeStoredTheme(next);
    disposeObserve();
    disposeObserve = () => {};
    document.documentElement.setAttribute('data-theme', next);
    apply(next);
  };

  const onClick = () => {
    const next: WorkbenchTheme = theme === 'dark' ? 'light' : 'dark';
    choose(next);
  };

  options.toggleButton?.addEventListener('click', onClick);

  return {
    get theme() {
      return theme;
    },
    set(next) {
      choose(next);
    },
    toggle() {
      const next: WorkbenchTheme = theme === 'dark' ? 'light' : 'dark';
      onClick();
      return next;
    },
    dispose() {
      disposeObserve();
      options.toggleButton?.removeEventListener('click', onClick);
      host.dispose();
    },
  };
}
