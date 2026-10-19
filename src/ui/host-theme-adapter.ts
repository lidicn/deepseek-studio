/**
 * 宿主主题适配层
 *
 * 优先级：宿主显式 data-theme > computedStyle 背景亮度 > prefers-color-scheme > light
 */

import type { Disposer } from './disposer';

export type StudioTheme = 'light' | 'dark';

export interface HostThemeAdapter {
  getTheme(): StudioTheme;
  observe(callback: (theme: StudioTheme) => void): Disposer;
  dispose(): void;
}

export function createHostThemeAdapter(): HostThemeAdapter {
  let disposed = false;
  let mediaQuery: MediaQueryList | null = null;

  function getTheme(): StudioTheme {
    if (disposed) return 'light';
    // 1. 宿主显式声明
    const htmlTheme = document.documentElement.getAttribute('data-theme');
    const bodyTheme = document.body?.getAttribute('data-theme');
    const cls = document.documentElement.className || '';
    if (htmlTheme === 'dark' || bodyTheme === 'dark' || cls.includes('dark')) return 'dark';
    if (htmlTheme === 'light' || bodyTheme === 'light' || cls.includes('light')) return 'light';

    // 2. prefers-color-scheme
    try {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch { /* ignore */ }

    return 'light';
  }

  function observe(callback: (theme: StudioTheme) => void): Disposer {
    if (disposed) return () => {};
    try {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => callback(getTheme());
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery?.removeEventListener('change', handler);
    } catch {
      return () => {};
    }
  }

  function dispose(): void {
    disposed = true;
    mediaQuery = null;
  }

  return { getTheme, observe, dispose };
}
