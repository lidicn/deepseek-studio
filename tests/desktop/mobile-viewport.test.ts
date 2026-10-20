// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isMobileViewport, mountLayoutBreakpoints } from '../../src/ui/workbench/layout-breakpoints';
import { mountDesktopHint } from '../../src/ui/workbench/desktop-hint';
import { createWidthObserver, type WidthObserver } from '../../src/ui/workbench/width-observer';

/** stub matchMedia：coarse/noHover 决定 isMobileViewport 的指针判定。 */
function stubMatchMedia(opts: { coarse: boolean; noHover: boolean }): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('coarse') ? opts.coarse : query.includes('hover') ? opts.noHover : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

function makeObserver(initial: number): WidthObserver {
  window.innerWidth = initial;
  return createWidthObserver(initial);
}

beforeEach(() => {
  document.documentElement.className = '';
  document.body.innerHTML =
    '<div id="app"><main class="workbench-layout" id="studio-workbench-root"></main></div>';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isMobileViewport · 指针能力判定', () => {
  it('coarse + noHover → 移动端', () => {
    const restore = stubMatchMedia({ coarse: true, noHover: true });
    expect(isMobileViewport()).toBe(true);
    restore();
  });

  it('fine pointer + hover → 非移动端（桌面）', () => {
    const restore = stubMatchMedia({ coarse: false, noHover: false });
    expect(isMobileViewport()).toBe(false);
    restore();
  });

  it('UA 含 Mobi 兜底判定为移动端', () => {
    const restore = stubMatchMedia({ coarse: false, noHover: false });
    const spy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    );
    expect(isMobileViewport()).toBe(true);
    spy.mockRestore();
    restore();
  });
});

describe('移动端 · 窄宽度不降级为桌面提示（P2）', () => {
  it('宽度 700 + 移动端 → mode 仍为 compact，不是 desktop-only', () => {
    const restore = stubMatchMedia({ coarse: true, noHover: true });
    const root = document.getElementById('studio-workbench-root') as HTMLElement;
    const ctl = mountLayoutBreakpoints({ root, observer: makeObserver(700) });
    expect(ctl.mobile).toBe(true);
    expect(ctl.mode).toBe('compact');
    expect(root.classList.contains('is-compact')).toBe(true);
    expect(root.classList.contains('is-desktop-only')).toBe(false);
    ctl.dispose();
    restore();
  });

  it('移动端写 .is-mobile 到 <html>，供 CSS 消费', () => {
    const restore = stubMatchMedia({ coarse: true, noHover: true });
    const root = document.getElementById('studio-workbench-root') as HTMLElement;
    const ctl = mountLayoutBreakpoints({ root, observer: makeObserver(700) });
    expect(document.documentElement.classList.contains('is-mobile')).toBe(true);
    ctl.dispose();
    restore();
  });

  it('桌面窄宽度仍降级为 desktop-only（回归保护）', () => {
    const restore = stubMatchMedia({ coarse: false, noHover: false });
    const root = document.getElementById('studio-workbench-root') as HTMLElement;
    const ctl = mountLayoutBreakpoints({ root, observer: makeObserver(700) });
    expect(ctl.mobile).toBe(false);
    expect(ctl.mode).toBe('desktop-only');
    ctl.dispose();
    restore();
  });

  it('移动端 700px 不显示桌面提示', () => {
    const restore = stubMatchMedia({ coarse: true, noHover: true });
    const root = document.getElementById('app') as HTMLElement;
    const obs = makeObserver(700);
    const bp = mountLayoutBreakpoints({
      root: document.getElementById('studio-workbench-root') as HTMLElement,
      observer: obs,
    });
    const hint = mountDesktopHint({ parent: root, observer: obs, mobile: bp.mobile });
    expect(hint.shown).toBe(false);
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
    bp.dispose();
    hint.dispose();
    restore();
  });

  it('桌面 700px 仍显示桌面提示（回归保护）', () => {
    const restore = stubMatchMedia({ coarse: false, noHover: false });
    const root = document.getElementById('app') as HTMLElement;
    const obs = makeObserver(700);
    const bp = mountLayoutBreakpoints({
      root: document.getElementById('studio-workbench-root') as HTMLElement,
      observer: obs,
    });
    const hint = mountDesktopHint({ parent: root, observer: obs, mobile: bp.mobile });
    expect(hint.shown).toBe(true);
    bp.dispose();
    hint.dispose();
    restore();
  });
});
