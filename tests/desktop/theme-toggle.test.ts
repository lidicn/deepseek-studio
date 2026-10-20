// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountThemeToggle } from '../../src/ui/workbench/theme-toggle';

/** jsdom 的 matchMedia 不可配置 matches，按需替换以模拟系统主题与其变化。 */
function stubPrefersDark(dark: boolean): { fireChange: (nextDark: boolean) => void; restore: () => void } {
  const listeners: Array<() => void> = [];
  let darkNow = dark;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: darkNow && query.includes('dark'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, cb: () => void) => listeners.push(cb),
    removeEventListener: (_: string, cb: () => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    fireChange: (nextDark: boolean) => {
      darkNow = nextDark;
      listeners.slice().forEach((cb) => cb());
    },
    restore: () => {
      window.matchMedia = original;
    },
  };
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme-toggle · 默认浅色（X3）', () => {
  it('无用户选择、系统浅色 → 默认 light 且写入浅色 token', () => {
    const media = stubPrefersDark(false);
    const ctl = mountThemeToggle();
    expect(ctl.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--studio-bg-page')).toBe('#F7F8FA');
    ctl.dispose();
    media.restore();
  });

  it('applyWorkbenchTheme 把 --studio-bg-page 写进 documentElement.style', () => {
    const media = stubPrefersDark(false);
    const ctl = mountThemeToggle();
    expect(document.documentElement.style.getPropertyValue('--studio-bg-page')).toBe('#F7F8FA');
    ctl.dispose();
    media.restore();
  });
});

describe('theme-toggle · 用户点击切深色并记忆', () => {
  it('toggle → dark，写入 data-theme 与深色 token，localStorage 记忆', () => {
    const media = stubPrefersDark(false);
    const ctl = mountThemeToggle();
    const next = ctl.toggle();
    expect(next).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--studio-bg-page')).toBe('#111318');
    expect(localStorage.getItem('ds-studio-theme')).toBe('dark');
    ctl.dispose();
    media.restore();
  });

  it('下次启动沿用上次选择的 dark（不回到 light）', () => {
    const media = stubPrefersDark(false);
    localStorage.setItem('ds-studio-theme', 'dark');
    const ctl = mountThemeToggle();
    expect(ctl.theme).toBe('dark');
    ctl.dispose();
    media.restore();
  });

  it('localStorage 读抛出时降级为探测主题，不抛到调用方', () => {
    const media = stubPrefersDark(false);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => mountThemeToggle()).not.toThrow();
    spy.mockRestore();
    media.restore();
  });
});

describe('theme-toggle · 跟随系统但不覆盖用户选择', () => {
  it('用户未选择时，系统切深色 → 自动跟随', () => {
    const media = stubPrefersDark(false);
    const ctl = mountThemeToggle();
    expect(ctl.theme).toBe('light');
    media.fireChange(true);
    // 跟随系统只更新运行时 token，不写 data-theme（那是用户显式选择的标记）。
    expect(ctl.theme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--studio-bg-page')).toBe('#111318');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    ctl.dispose();
    media.restore();
  });

  it('用户显式选过之后，系统变化不再覆盖用户选择', () => {
    const media = stubPrefersDark(false);
    const ctl = mountThemeToggle();
    ctl.toggle();
    ctl.set('light');
    media.fireChange(true);
    expect(ctl.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--studio-bg-page')).toBe('#F7F8FA');
    expect(localStorage.getItem('ds-studio-theme')).toBe('light');
    ctl.dispose();
    media.restore();
  });

  it('toggle 按钮同步 aria-pressed', () => {
    const media = stubPrefersDark(false);
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const ctl = mountThemeToggle({ toggleButton: btn });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    ctl.toggle();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    ctl.dispose();
    media.restore();
  });

  it('dispose 后按钮点击不再生效', () => {
    const media = stubPrefersDark(false);
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const ctl = mountThemeToggle({ toggleButton: btn });
    ctl.dispose();
    btn.click();
    // 用户未显式选择过 → 不写 data-theme；token 保持浅色。
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--studio-bg-page')).toBe('#F7F8FA');
    media.restore();
  });

  it('用户未选择时刻意不写 data-theme，避免宿主适配器把自己写死', () => {
    const media = stubPrefersDark(false);
    const ctl = mountThemeToggle();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    ctl.dispose();
    media.restore();
  });

  it('用户上次选过 → 启动即写 data-theme（CSS 静态兜底同步）', () => {
    const media = stubPrefersDark(false);
    localStorage.setItem('ds-studio-theme', 'dark');
    const ctl = mountThemeToggle();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    ctl.dispose();
    media.restore();
  });
});
