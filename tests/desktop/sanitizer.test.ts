// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { escapeHtml, safeText, setSafeContent } from '../../src/ui/sanitizer';

describe('sanitizer 转义与安全文本（W8）', () => {
  it('escapeHtml 转义五个危险字符', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('safeText 返回 Text 节点且不解析 HTML', () => {
    const node = safeText('<b>not bold</b>');
    expect(node.nodeType).toBe(Node.TEXT_NODE);
    expect(node.textContent).toBe('<b>not bold</b>');
  });

  it('setSafeContent 等价 textContent（不解析标签）', () => {
    const el = document.createElement('div');
    setSafeContent(el, '<i>plain</i>');
    expect(el.textContent).toBe('<i>plain</i>');
    expect(el.querySelector('i')).toBeNull();
    // 与直接 textContent 等价
    const ref = document.createElement('div');
    ref.textContent = '<i>plain</i>';
    expect(el.innerHTML).toBe(ref.innerHTML);
  });
});
