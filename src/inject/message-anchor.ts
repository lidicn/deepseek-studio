/**
 * message-anchor.ts — 助手消息 DOM 定位（移植自 deepseek++ message-anchor.ts）
 * @upstream-commit 187f6227 @upstream-path core/inline-agent/message-anchor.ts
 *
 * 功能：
 * - 排除扩展注入 UI 后获取消息自身文本
 * - 通过内容片段查找最新助手消息
 */

/** 扩展注入的 UI 选择器，获取消息文本时需排除 */
export const EXTENSION_INJECTED_UI_SELECTOR =
  '.ds-sf-container, .ds-studio-tools-container, .ds-studio-sidebar, [data-ds-studio]';

/** 获取助手消息的纯文本（排除扩展注入的 UI） */
export function getMessageOwnText(message: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.matches(EXTENSION_INJECTED_UI_SELECTOR)) return;
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(message);
  return parts.join(' ');
}

function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, '').trim();
}

/** 通过内容片段查找最新助手消息（从后往前找） */
export function findMessageBySnippet(
  messages: Element[],
  snippet: string,
  usedMessages: Set<Element>,
): Element | null {
  const normalized = normalizeText(snippet).slice(0, 100);
  if (normalized.length < 12) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (usedMessages.has(msg)) continue;
    const ownText = normalizeText(getMessageOwnText(msg));
    if (ownText.includes(normalized)) return msg;
  }
  return null;
}

/** 获取所有助手消息元素（从旧到新排序） */
export function getAllAssistantMessages(): Element[] {
  const selectors = ['.ds-assistant-message-main-content', '[class*="assistant-message"]', '[class*="message-item"]'];
  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    if (nodes.length > 0) return Array.from(nodes);
  }
  return [];
}
