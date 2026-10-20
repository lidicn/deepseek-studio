// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountDesktopHint } from '../../src/ui/workbench/desktop-hint';
import { createWidthObserver, type WidthObserver } from '../../src/ui/workbench/width-observer';
import { WORKBENCH_BREAKPOINTS } from '../../src/ui/ui-contract';

/**
 * 可控宽度源：不依赖真实 window.innerWidth 修改时序。
 * 传 initial 建观察者，之后用 resizeTo 改宽度并派发 resize 事件。
 */
function makeObserver(initial: number): WidthObserver {
  window.innerWidth = initial;
  return createWidthObserver(initial);
}

function resizeTo(next: number): void {
  window.innerWidth = next;
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  document.body.replaceChildren();
});

/** 造一个 #app 容器，复刻 agent.html 的挂载点。 */
function appRoot(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'app';
  document.body.appendChild(el);
  return el;
}

describe('desktop-hint · 断点显隐（P0）', () => {
  it(`宽度 ${WORKBENCH_BREAKPOINTS.compact - 1}（<compact）→ 创建提示且 role=note`, () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(WORKBENCH_BREAKPOINTS.compact - 1) });
    expect(ctl.shown).toBe(true);
    const hint = root.querySelector('#studio-desktop-hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('role')).toBe('note');
    expect(hint?.className).toContain('desktop-hint');
    expect(hint?.textContent).toContain('900');
    ctl.dispose();
  });

  it(`宽度 ${WORKBENCH_BREAKPOINTS.compact}（正好 compact）→ 不创建提示`, () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(WORKBENCH_BREAKPOINTS.compact) });
    expect(ctl.shown).toBe(false);
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
    ctl.dispose();
  });

  it('宽屏 → 不残留提示节点', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(1440) });
    expect(root.querySelector('.desktop-hint')).toBeNull();
    ctl.dispose();
  });

  it('sync() 跨阈值切换：宽 → 窄创建，窄 → 宽移除', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(1440) });
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
    ctl.sync(899);
    expect(root.querySelector('#studio-desktop-hint')).not.toBeNull();
    ctl.sync(1200);
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
    ctl.dispose();
  });

  it('sync() 幂等：同宽度重复调用不重复创建', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(1440) });
    ctl.sync(800);
    ctl.sync(800);
    ctl.sync(800);
    expect(root.querySelectorAll('#studio-desktop-hint')).toHaveLength(1);
    ctl.dispose();
  });

  it('resize 跨阈值时自动切换', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(1440) });
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
    resizeTo(800);
    expect(root.querySelector('#studio-desktop-hint')).not.toBeNull();
    expect(ctl.shown).toBe(true);
    resizeTo(1600);
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
    ctl.dispose();
  });

  it('dispose 后 resize 不再触发显隐', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(1440) });
    ctl.dispose();
    resizeTo(700);
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
  });

  it('宽度完全未变时 resize 不触发任何 DOM 查询', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(1440) });
    const spy = vi.spyOn(root, 'querySelector');
    resizeTo(1440);
    // 宽度未变 → sync 不被调用 → renderDesktopHint 的 querySelector 也不发生。
    expect(spy).not.toHaveBeenCalled();
    ctl.dispose();
    spy.mockRestore();
  });

  it('宽度变化但未跨阈值时仍重算（幂等，不产生节点）', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(1440) });
    resizeTo(1500);
    expect(root.querySelector('#studio-desktop-hint')).toBeNull();
    expect(ctl.shown).toBe(false);
    ctl.dispose();
  });

  it('提示文案语义化：说明需要桌面窗口，不出现"错误/失败"', () => {
    const root = appRoot();
    const ctl = mountDesktopHint({ parent: root, observer: makeObserver(600) });
    const text = root.querySelector('#studio-desktop-hint')?.textContent ?? '';
    expect(text).toContain('桌面');
    expect(text).not.toMatch(/错误|失败|异常/);
    ctl.dispose();
  });
});
