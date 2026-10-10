/**
 * chat-read 能力（v0.3.3，read 风险，自动放行）
 *
 * 读取当前 DeepSeek 对话的消息列表。选择器多候选回退；未找到消息 → no-messages-found。
 * 角色推断为启发式（类名/文本命中 user/assistant 关键词），未知归 'unknown'，不阻塞读取。
 */

import type { ContentCapabilityController } from '../inject/types';
import type { ExecutableCapability, ExecuteResult } from './types';
import { queryAll } from './dom';

/**
 * 消息选择器（v0.6 真机实测 chat.deepseek.com）：
 *   - 模型回复容器 = .ds-markdown.ds-assistant-message-main-content（首选，纯答案不含推理段）
 *   - 通用回退 = .ds-markdown（含推理块），最后才是规范假设的旧选择器
 */
const MESSAGE_SELECTORS = [
  '.ds-assistant-message-main-content',
  '.ds-markdown',
  '[class*="message-item"]',
  '[class*="chat-message"]',
  '#chat-messages > *',
  '.message',
];

const USER_HINT = /(^|\s)(user|human|你|我发)/i;
const ASSISTANT_HINT = /(^|\s)(assistant|bot|ai|deepseek|助理|助手|思考|reasoning)/i;

function inferRole(el: Element): 'user' | 'assistant' | 'unknown' {
  const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
  const head = (el.textContent ?? '').slice(0, 48);
  if (USER_HINT.test(cls) || USER_HINT.test(head)) return 'user';
  if (ASSISTANT_HINT.test(cls) || ASSISTANT_HINT.test(head)) return 'assistant';
  return 'unknown';
}

export function createChatReadCapability(): ContentCapabilityController & ExecutableCapability {
  return {
    id: 'chat-read',
    start() {},
    async stop() {},
    async execute(): Promise<ExecuteResult> {
      const doc = globalThis.document;
      if (!doc) return { ok: false, error: 'no-document' };
      const root = (doc.querySelector('#chat-container') ?? doc.body) as ParentNode;
      const nodes = queryAll(root, MESSAGE_SELECTORS);
      if (nodes.length === 0) return { ok: false, error: 'no-messages-found' };
      const messages = nodes
        .map((n) => ({ role: inferRole(n), text: (n.textContent ?? '').replace(/\s+/g, ' ').trim() }))
        .filter((m) => m.text.length > 0);
      return { ok: true, data: { count: messages.length, messages } };
    },
  };
}
