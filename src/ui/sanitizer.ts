/**
 * HTML 转义工具（安全）
 *
 * 禁止 innerHTML 拼接不可信内容。所有用户输入/工具输出必须经此转义后再插入 DOM。
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/** 创建安全文本节点（不解析 HTML） */
export function safeText(text: string): Text {
  return document.createTextNode(text);
}

/** 设置元素的安全文本内容（等价于 textContent） */
export function setSafeContent(el: HTMLElement, text: string): void {
  el.textContent = text;
}
