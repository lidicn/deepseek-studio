/**
 * chat-insert 能力（v0.3.3，insert 风险，需用户同意）
 *
 * 向当前对话输入框写入文本。参数缺 text → missing-text；输入框找不到/不可写 → 结构化错误。
 */

import type { ContentCapabilityController } from '../inject/types';
import type { ExecutableCapability, ExecuteResult } from './types';
import { queryFirst, setInputValue } from './dom';

const INPUT_SELECTORS = [
  'textarea#chat-input',
  '#chat-input',
  '[contenteditable="true"]',
  'textarea',
  '.chat-input',
];

export function createChatInsertCapability(): ContentCapabilityController & ExecutableCapability {
  return {
    id: 'chat-insert',
    start() {},
    async stop() {},
    async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
      const text = typeof params.text === 'string' ? params.text : '';
      if (text.length === 0) return { ok: false, error: 'missing-text' };
      const doc = globalThis.document;
      if (!doc) return { ok: false, error: 'no-document' };
      const el = queryFirst(doc, INPUT_SELECTORS);
      if (!el) return { ok: false, error: 'input-not-found' };
      if (!setInputValue(el, text)) return { ok: false, error: 'input-not-writable' };
      return { ok: true, data: { inserted: text.length } };
    },
  };
}
