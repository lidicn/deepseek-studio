// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountLayoutBreakpoints } from '../../src/ui/workbench/layout-breakpoints';
import { createWidthObserver, type WidthObserver } from '../../src/ui/workbench/width-observer';
import { mountDesktopHint } from '../../src/ui/workbench/desktop-hint';
import { WORKBENCH_BREAKPOINTS } from '../../src/ui/ui-contract';

function makeObserver(initial: number): WidthObserver {
  window.innerWidth = initial;
  return createWidthObserver(initial);
}

function resizeTo(next: number): void {
  window.innerWidth = next;
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="app"><main class="workbench-layout" id="studio-workbench-root"></main>' +
    '<footer class="composer"></footer><footer class="statusbar"></footer></div>';
});

function layoutRoot(): HTMLElement {
  return document.getElementById('studio-workbench-root') as HTMLElement;
}

describe('layout-breakpoints · 四档 class（P3）', () => {
  it('≥1440 → is-wide', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(1440) });
    expect(ctl.mode).toBe('wide');
    expect(layoutRoot().classList.contains('is-wide')).toBe(true);
    ctl.dispose();
  });

  it('1200–1439 → is-medium', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(1200) });
    expect(ctl.mode).toBe('medium');
    expect(layoutRoot().classList.contains('is-medium')).toBe(true);
    ctl.dispose();
  });

  it('900–1199 → is-compact', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(900) });
    expect(ctl.mode).toBe('compact');
    expect(layoutRoot().classList.contains('is-compact')).toBe(true);
    ctl.dispose();
  });

  it('<900 → is-desktop-only', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(899) });
    expect(ctl.mode).toBe('desktop-only');
    expect(layoutRoot().classList.contains('is-desktop-only')).toBe(true);
    ctl.dispose();
  });

  it('档位切换不残留上一个档位的 class', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(1600) });
    resizeTo(800);
    const cls = Array.from(layoutRoot().classList).filter((c) => c.startsWith('is-'));
    expect(cls).toEqual(['is-desktop-only']);
    ctl.dispose();
  });

  it('dataset.layout 与 class 同步', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(1000) });
    expect(layoutRoot().dataset.layout).toBe('compact');
    ctl.dispose();
  });

  it('resize 跨档自动切换', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(1600) });
    expect(ctl.mode).toBe('wide');
    resizeTo(1300);
    expect(ctl.mode).toBe('medium');
    resizeTo(1000);
    expect(ctl.mode).toBe('compact');
    resizeTo(700);
    expect(ctl.mode).toBe('desktop-only');
    ctl.dispose();
  });

  it('宽度未变时不重算', () => {
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(1440) });
    const spy = vi.spyOn(layoutRoot().classList, 'remove');
    resizeTo(1440);
    expect(spy).not.toHaveBeenCalled();
    ctl.dispose();
    spy.mockRestore();
  });
});

describe('width-observer · 单一监听多订阅者（P3）', () => {
  it('两个订阅者都收到同一次宽度变化', () => {
    const obs = makeObserver(1600);
    const seenA: number[] = [];
    const seenB: number[] = [];
    obs.subscribe((w) => seenA.push(w));
    obs.subscribe((w) => seenB.push(w));
    resizeTo(1000);
    expect(seenA).toContain(1000);
    expect(seenB).toContain(1000);
    obs.dispose();
  });

  it('订阅时立即以当前宽度回调一次', () => {
    const obs = makeObserver(1234);
    const seen: number[] = [];
    obs.subscribe((w) => seen.push(w));
    expect(seen).toEqual([1234]);
    obs.dispose();
  });

  it('退订后不再收到回调', () => {
    const obs = makeObserver(1600);
    const seen: number[] = [];
    const off = obs.subscribe((w) => seen.push(w));
    off();
    resizeTo(900);
    expect(seen).toEqual([1600]);
    obs.dispose();
  });
});

describe('desktop-hint 与断点共用观察者（P3 集成）', () => {
  it('一次 resize 同时驱动断点 class 与桌面提示', () => {
    const obs = makeObserver(1600);
    const root = document.getElementById('app') as HTMLElement;
    const bp = mountLayoutBreakpoints({ root: layoutRoot(), observer: obs });
    const hint = mountDesktopHint({ parent: root, observer: obs });

    expect(bp.mode).toBe('wide');
    expect(hint.shown).toBe(false);

    resizeTo(700);
    expect(bp.mode).toBe('desktop-only');
    expect(hint.shown).toBe(true);
    expect(root.querySelector('#studio-desktop-hint')).not.toBeNull();
    expect(layoutRoot().classList.contains('is-desktop-only')).toBe(true);

    bp.dispose();
    hint.dispose();
  });

  it('两个消费者都 dispose 后，观察者不再持有监听', () => {
    const obs = makeObserver(1600);
    const root = document.getElementById('app') as HTMLElement;
    const bp = mountLayoutBreakpoints({ root: layoutRoot(), observer: obs });
    const hint = mountDesktopHint({ parent: root, observer: obs });
    bp.dispose();
    hint.dispose();
    const spy = vi.spyOn(layoutRoot().classList, 'remove');
    resizeTo(700);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('断点阈值与 WORKBENCH_BREAKPOINTS 一致（compact=900）', () => {
    expect(WORKBENCH_BREAKPOINTS.compact).toBe(900);
    const ctl = mountLayoutBreakpoints({ root: layoutRoot(), observer: makeObserver(WORKBENCH_BREAKPOINTS.compact) });
    expect(ctl.mode).toBe('compact');
    ctl.dispose();
  });
});
