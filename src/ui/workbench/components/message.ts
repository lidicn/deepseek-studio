/**
 * Message 组件（user / assistant）：行式布局，不用彩色气泡区分 Agent。
 * 纯文本走 textContent；Markdown 渲染与消毒由 W4 markdown 层统一负责。
 * 长文本换行，不横向撑破中栏。
 */

export type MessageAuthor = 'user' | 'assistant';

export function renderMessage(author: MessageAuthor, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `wb-message wb-message-${author}`;
  el.setAttribute('data-author', author);
  const body = document.createElement('div');
  body.className = 'wb-message-body';
  body.textContent = text ?? '';
  el.appendChild(body);
  return el;
}
