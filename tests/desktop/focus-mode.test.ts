// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createFocusMode } from '../../src/ui/focus-mode';

function focusHostCount(): number {
  return document.querySelectorAll('.studio-shadow-host-focus-mode').length;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('focus-mode 挂载/Esc/幂等/无泄漏（W8）', () => {
  it('mount 后 host 与 overlay DOM 存在且 isActive', () => {
    const h = createFocusMode({ title: '测试专注' });
    expect(h.isActive()).toBe(true);
    expect(focusHostCount()).toBe(1);
    const host = document.querySelector('.studio-shadow-host-focus-mode')!;
    const root = (host as HTMLElement).shadowRoot!;
    expect(root.querySelector('.overlay')).not.toBeNull();
    expect(root.querySelector('.title')!.textContent).toBe('测试专注');
    h.dispose();
  });

  it('Esc 退出并移除 host', () => {
    const h = createFocusMode();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.isActive()).toBe(false);
    expect(focusHostCount()).toBe(0);
  });

  it('dispose 幂等：连调两次不抛且不残留', () => {
    const h = createFocusMode();
    h.dispose();
    expect(() => h.dispose()).not.toThrow();
    expect(h.isActive()).toBe(false);
    expect(focusHostCount()).toBe(0);
  });

  it('连续 mount/destroy 3 次无 host 残留', () => {
    for (let i = 0; i < 3; i++) {
      const h = createFocusMode();
      expect(focusHostCount()).toBe(1);
      h.dispose();
    }
    expect(focusHostCount()).toBe(0);
  });
});
