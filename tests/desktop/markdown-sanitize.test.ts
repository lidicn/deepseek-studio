// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/inject/markdown';

describe('renderMarkdown 消毒（W4）', () => {
  it('移除 <script> 标签', () => {
    const html = renderMarkdown('前\n<script>alert(1)</script>\n后');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('img 的 onerror 不保留', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain('alert(1)');
  });

  it('javascript: 链接不生成可执行 href', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const a = doc.querySelector('a');
    expect(a).toBeTruthy();
    expect(a?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });

  it('data: / vbscript: 链接被剥离 href', () => {
    for (const proto of ['data:text/html,x', 'vbscript:msgbox(1)']) {
      const html = renderMarkdown(`[y](${proto})`);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      expect(doc.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/^(data|vbscript):/i);
    }
  });

  it('普通文本与安全链接保留', () => {
    const html = renderMarkdown('**加粗** [官网](https://example.com)');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('https://example.com');
  });
});
