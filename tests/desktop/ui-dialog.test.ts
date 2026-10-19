// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { dialog } from '../../src/ui/primitives/dialog';

function buildContent(): HTMLElement {
  const c = document.createElement('div');
  const a = document.createElement('button');
  a.textContent = '第一个';
  a.dataset.id = 'a';
  const b = document.createElement('button');
  b.textContent = '第二个';
  b.dataset.id = 'b';
  c.appendChild(a);
  c.appendChild(b);
  return c;
}

function pressKey(key: string, shiftKey = false): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
}

describe('Dialog 焦点陷阱（W4）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('Tab 在末元素循环回首元素（不落到遮罩外）', () => {
    const anchor = document.createElement('button');
    anchor.textContent = '外部';
    document.body.appendChild(anchor);
    anchor.focus();
    const content = buildContent();
    const handle = dialog('标题', content);
    const btns = handle.el.querySelectorAll('button');
    btns[1].focus();
    expect(document.activeElement).toBe(btns[1]);
    pressKey('Tab');
    expect(document.activeElement).toBe(btns[0]);
    handle.close();
  });

  it('Shift+Tab 在首元素循环回末元素', () => {
    const handle = dialog('标题', buildContent());
    const btns = handle.el.querySelectorAll('button');
    btns[0].focus();
    pressKey('Tab', true);
    expect(document.activeElement).toBe(btns[1]);
    handle.close();
  });

  it('Esc 关闭并把焦点恢复到打开前元素', () => {
    const anchor = document.createElement('button');
    anchor.textContent = '外部锚点';
    document.body.appendChild(anchor);
    anchor.focus();
    const handle = dialog('标题', buildContent(), { closable: true });
    expect(document.body.contains(handle.el)).toBe(true);
    pressKey('Escape');
    expect(document.body.contains(handle.el)).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });
});
