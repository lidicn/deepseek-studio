// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  mountWorkbenchShell,
  layoutForWidth,
  renderDesktopHint,
} from '../../src/ui/workbench/workbench-shell';

describe('Workbench shell · 三栏节点', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('挂载后存在 rail / left-panel / center-canvas / right-inspector / drawer 五节点', () => {
    const h = mountWorkbenchShell();
    expect(document.querySelector('.left-rail')).not.toBeNull();
    expect(document.querySelector('.left-panel')).not.toBeNull();
    expect(document.querySelector('.center-canvas')).not.toBeNull();
    expect(document.querySelector('.right-inspector')).not.toBeNull();
    expect(document.querySelector('.inspector-drawer')).not.toBeNull();
    expect(h.getCenterCanvas().className).toContain('center-canvas');
    h.dispose();
  });

  it('节点在 Light DOM，不进 Shadow Root', () => {
    const h = mountWorkbenchShell();
    const canvas = h.getCenterCanvas();
    expect(canvas.getRootNode()).toBe(document);
    expect(canvas.shadowRoot).toBeNull();
    h.dispose();
  });
});

describe('Workbench shell · 响应式断点（§10.7）', () => {
  it('layoutForWidth: ≥1440 wide / 1200-1439 medium / 900-1199 compact / <900 desktop-only', () => {
    expect(layoutForWidth(1440)).toBe('wide');
    expect(layoutForWidth(1600)).toBe('wide');
    expect(layoutForWidth(1200)).toBe('medium');
    expect(layoutForWidth(1439)).toBe('medium');
    expect(layoutForWidth(1199)).toBe('compact');
    expect(layoutForWidth(900)).toBe('compact');
    expect(layoutForWidth(899)).toBe('desktop-only');
  });

  it('<900 显示语义化桌面提示，≥900 移除', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderDesktopHint(host, true);
    const hint = host.querySelector('#studio-desktop-hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('role')).toBe('note');
    renderDesktopHint(host, false);
    expect(host.querySelector('#studio-desktop-hint')).toBeNull();
  });

  it('setLayout(800) 标记 desktop-only 并注入提示', () => {
    const h = mountWorkbenchShell();
    const mode = h.setLayout(800);
    expect(mode).toBe('desktop-only');
    expect(document.querySelector('.desktop-hint')).not.toBeNull();
    h.dispose();
  });
});

describe('Workbench shell · 抽屉开关', () => {
  it('toggleInspector 只切 class，不修改中栏最小宽度', () => {
    const h = mountWorkbenchShell();
    const canvas = h.getCenterCanvas();
    const before = canvas.style.minWidth;
    h.toggleInspector();
    expect(canvas.style.minWidth).toBe(before);
    expect(document.querySelector('.workbench-layout')?.classList.contains('inspector-open')).toBe(true);
    h.toggleInspector();
    expect(canvas.style.minWidth).toBe(before);
    h.dispose();
  });
});
