/**
 * markdown.ts — Markdown 渲染（基于 marked 库，参考 cuckoo-code）
 * @upstream-commit 187f6227 @upstream-path core/inline-agent/markdown.ts
 *
 * 用 marked 库渲染（GFM + breaks），支持表格、嵌套列表、删除线、任务列表、
 * 代码块语言标签等。比自建正则渲染器更完整可靠。
 * 失败时回退到 HTML 转义纯文本，保证不抛异常。
 *
 * marked 的 sanitize 默认关闭——输入文本来自模型输出，已在 chat UI 内
 * 通过 innerHTML 渲染（同 cuckoo harness 的 renderMarkdown 策略）。
 * 不引入 DOMPurify 以减依赖；如需严格 XSS 防护后续再加。
 */

import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** 渲染 markdown 文本为 HTML 字符串（同步，非 Promise） */
export function renderMarkdown(text: string): string {
  try {
    const src = String(text == null ? '' : text);
    if (!src) return '';
    // marked.parse 在新版默认返回 string | Promise<string>；
    // 不设 async 时返回 string。强制同步取值。
    const html = marked.parse(src, { async: false }) as string;
    return html;
  } catch {
    return escapeHtml(text);
  }
}

/** HTML 转义（兜底用） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
