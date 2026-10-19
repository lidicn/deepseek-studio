/**
 * markdown.ts — Markdown 渲染（基于 marked + DOMPurify 清洗）
 * @upstream-commit 187f6227 @upstream-path src/core/inline-agent/markdown.ts
 *
 * 用 marked 库渲染（GFM + breaks），支持表格、嵌套列表、删除线、任务列表、
 * 代码块语言标签等。渲染后经 DOMPurify 清洗，移除 script/on* 属性等危险内容。
 * 失败时回退到 HTML 转义纯文本，保证不抛异常。
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

let securityHookInstalled = false;

/**
 * W4：惰性安装安全 hook——剥离 javascript:/data:/vbscript: 链接 href。
 * node 测试环境 DOMPurify 无 addHook，故先判类型；浏览器/jsdom 首次渲染时注册一次。
 */
function ensureSecurityHook(): void {
  if (securityHookInstalled) return;
  if (typeof DOMPurify.addHook !== 'function') return;
  securityHookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      if (href && /^\s*(javascript|data|vbscript):/i.test(href)) {
        node.removeAttribute('href');
        node.removeAttribute('target');
        node.removeAttribute('rel');
      }
    }
  });
}

/** 渲染 markdown 文本为安全 HTML 字符串（同步） */
export function renderMarkdown(text: string): string {
  try {
    ensureSecurityHook();
    const src = String(text == null ? '' : text);
    if (!src) return '';
    const html = marked.parse(src, { async: false }) as string;
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p','br','strong','em','u','del','code','pre','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','a','img','table','thead','tbody','tr','th','td','hr','span','div','input','details','summary'],
      ALLOWED_ATTR: ['href','src','alt','title','class','id','type','checked','disabled','target','rel'],
      ALLOW_DATA_ATTR: false,
    });
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
