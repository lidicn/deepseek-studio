// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mountInspectorDrawer } from '../../src/ui/workbench/inspector-drawer';

describe('Inspector 抽屉开关（窄屏）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('点击切换 open class 与 aria-expanded/aria-hidden，关闭按钮收起', () => {
    const drawer = document.createElement('aside');
    drawer.id = 'inspector-drawer';
    const toggle = document.createElement('button');
    const close = document.createElement('button');
    document.body.append(drawer, toggle, close);

    const ctrl = mountInspectorDrawer({ drawer, toggleButton: toggle, closeButton: close });

    // 初始收起
    expect(ctrl.open).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.getAttribute('aria-hidden')).toBe('true');

    // 第一次点击展开
    toggle.click();
    expect(ctrl.open).toBe(true);
    expect(drawer.classList.contains('open')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(drawer.getAttribute('aria-hidden')).toBe('false');

    // 关闭按钮收起
    close.click();
    expect(ctrl.open).toBe(false);
    expect(drawer.classList.contains('open')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
