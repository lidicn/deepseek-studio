/**
 * ErrorCard：用 ui-error-codes 的中文映射展示错误；未知 code 显示原 code + 通用说明，不白屏。
 */
import { describeErrorCode } from '../../../shared/ui-error-codes';

export interface ErrorCardInput {
  errorCode?: string | null;
  text?: string | null;
}

export function renderErrorCard(input: ErrorCardInput | null | undefined): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wb-error-card';

  const code = document.createElement('div');
  code.className = 'wb-error-code';
  code.textContent = describeErrorCode(input?.errorCode);

  el.appendChild(code);

  if (input?.text) {
    const detail = document.createElement('div');
    detail.className = 'wb-error-detail';
    detail.textContent = input.text;
    el.appendChild(detail);
  }
  return el;
}
