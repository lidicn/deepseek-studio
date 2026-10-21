/**
 * 元宝自动继续
 *
 * 在审计空闲时自动向输入框发送"继续"。
 * 通过模拟真实用户操作（focus → input 事件 → click 发送），
 * 兼容 React 受控组件。
 */

const EDITOR_SELECTORS = [
  'textarea[class*="input"]',
  'textarea',
  '[contenteditable="true"]',
  '.ql-editor',
  'div[role="textbox"]',
];

const SEND_BTN_SELECTORS = [
  'button[class*="send"]',
  'button[class*="Send"]',
  'button[type="submit"]',
  '[class*="send-button"]',
  '[aria-label*="发送"]',
];

export interface SendResult {
  ok: boolean;
  reason?: string;
}

function findEditor(): HTMLElement | null {
  for (const sel of EDITOR_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el as HTMLElement;
  }
  return null;
}

function findSendButton(): HTMLElement | null {
  for (const sel of SEND_BTN_SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const btn = el as HTMLButtonElement;
      // 跳过禁用的按钮
      if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        return btn;
      }
    }
  }
  return null;
}

/** 判断页面是否正在生成回复（发送按钮变成停止按钮） */
export function isGenerating(): boolean {
  const stopSelectors = [
    'button[class*="stop"]',
    'button[class*="Stop"]',
    '[class*="stop-button"]',
    '[aria-label*="停止"]',
  ];
  for (const sel of stopSelectors) {
    if (document.querySelector(sel)) return true;
  }
  return false;
}

/**
 * 设置 React 受控 textarea 的值。
 * 直接设 .value 不会触发 React 的 onChange，需要用原生 setter + input 事件。
 */
function setNativeValue(el: HTMLElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(el, value);
  } else {
    (el as HTMLTextAreaElement).value = value;
  }
}

/**
 * 向输入框发送文本（默认"继续"）。
 * 模拟完整用户操作链：focus → 输入 → input 事件 → 点击发送。
 */
export function sendContinue(text = '继续'): SendResult {
  const editor = findEditor();
  if (!editor) return { ok: false, reason: '找不到输入框' };

  try {
    editor.focus();

    if (editor instanceof HTMLTextAreaElement) {
      setNativeValue(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (editor.isContentEditable) {
      // contenteditable：直接插入文本并派发 input
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    } else {
      setNativeValue(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch (e) {
    return { ok: false, reason: `输入失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 短暂等待 React 状态更新后点击发送
  const btn = findSendButton();
  if (btn) {
    try {
      btn.click();
      return { ok: true };
    } catch (e) {
      // fallback：回车发送
      try {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        }));
        return { ok: true };
      } catch {
        return { ok: false, reason: '发送失败' };
      }
    }
  }

  // 没找到发送按钮，尝试回车
  try {
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    }));
    return { ok: true };
  } catch {
    return { ok: false, reason: '找不到发送按钮且回车失败' };
  }
}
