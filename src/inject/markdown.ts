/**
 * markdown.ts — 内联 Markdown 渲染（移植自 deepseek++ markdown.ts 精简版）
 *
 * 功能：
 * - 基本 markdown 语法渲染（粗体/斜体/代码/链接/列表/标题）
 * - 代码块保留原生样式
 * - XSS 安全转义
 */

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export interface MarkdownRenderOptions {
  /** 要保留为原生渲染的代码块语言（不转 HTML） */
  omitFencedCodeLanguages?: ReadonlySet<string>;
}

/** 渲染 markdown 文本为 HTML */
export function renderMarkdown(
  text: string,
  options: MarkdownRenderOptions = {},
): string {
  try {
    const codeBlocks: string[] = [];
    const normalizedText = text.replace(/\r\n?/g, '\n');
    let html = extractCodeBlocks(normalizedText, codeBlocks, options.omitFencedCodeLanguages);
    html = escapeHtml(html);
    html = renderInlineFormatting(html);
    html = renderBlockLayout(html);
    html = html.replace(/@@CODE_BLOCK_(\d+)@@/g, (_match, index) => codeBlocks[Number(index)] ?? '');
    return html;
  } catch {
    return escapeHtml(text);
  }
}

function extractCodeBlocks(
  text: string,
  codeBlocks: string[],
  omitLangs?: ReadonlySet<string>,
): string {
  return text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langLower = (lang || '').toLowerCase();
    if (omitLangs && omitLangs.has(langLower)) {
      // 保留为占位符，由原生渲染器处理
      codeBlocks.push(`<pre><code class="language-${lang}">${escapeHtml(code.trimEnd())}</code></pre>`);
    } else {
      codeBlocks.push(`<pre><code class="language-${lang}">${escapeHtml(code.trimEnd())}</code></pre>`);
    }
    return `\n@@CODE_BLOCK_${codeBlocks.length - 1}@@\n`;
  });
}

function renderInlineFormatting(html: string): string {
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const decodedHref = href.trim();
    if (!isSafeHref(decodedHref)) return `${label} (${href})`;
    return `<a href="${escapeAttr(decodedHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return html;
}

function renderBlockLayout(html: string): string {
  const lines = html.split('\n');
  const blocks: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };

  const closeList = () => {
    if (inList) {
      blocks.push(`</${inList}>`);
      inList = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    // 标题
    if (/^#{1,6}\s/.test(trimmed)) {
      flushParagraph();
      closeList();
      const level = trimmed.match(/^(#+)/)?.[1].length ?? 1;
      const text = trimmed.replace(/^#+\s/, '');
      blocks.push(`<h${level}>${text}</h${level}>`);
      continue;
    }
    // 无序列表
    if (/^[-*•]\s/.test(trimmed)) {
      flushParagraph();
      if (inList !== 'ul') {
        closeList();
        blocks.push('<ul>');
        inList = 'ul';
      }
      blocks.push(`<li>${trimmed.replace(/^[-*•]\s/, '')}</li>`);
      continue;
    }
    // 有序列表
    if (/^\d+\.\s/.test(trimmed)) {
      flushParagraph();
      if (inList !== 'ol') {
        closeList();
        blocks.push('<ol>');
        inList = 'ol';
      }
      blocks.push(`<li>${trimmed.replace(/^\d+\.\s/, '')}</li>`);
      continue;
    }
    // 引用
    if (/^>\s/.test(trimmed)) {
      flushParagraph();
      blocks.push(`<blockquote>${trimmed.replace(/^>\s/, '')}</blockquote>`);
      continue;
    }
    // 代码块占位符
    if (/^@@CODE_BLOCK_\d+@@$/.test(trimmed)) {
      flushParagraph();
      closeList();
      blocks.push(trimmed);
      continue;
    }
    // 普通段落
    paragraph.push(trimmed);
  }
  flushParagraph();
  closeList();
  return blocks.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, '&#39;');
}

function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href, window.location.href);
    return SAFE_LINK_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}
