/**
 * 页面 DOM 辅助（v0.3.3），全部防御式：找不到即返回 null/false，由调用方转结构化错误。
 *
 * 注意：chat.deepseek.com 的真实 DOM 结构可能随站点更新变化，选择器以「多候选 + 回退」应对；
 * 任一候选命中即返回，未命中由能力返回 no-*-found 错误码（fail-closed，不崩溃、不静默）。
 */

export function queryAll(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const sel of selectors) {
    const found = Array.from(root.querySelectorAll(sel));
    if (found.length > 0) return found;
  }
  return [];
}

export function queryFirst(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const sel of selectors) {
    const found = root.querySelector(sel);
    if (found) return found;
  }
  return null;
}

export function setInputValue(el: Element, value: string): boolean {
  // React 受控组件：直接 el.value=... 会被 React 的 value tracker 判定为「没变」，
  // 状态不更新（发送按钮恒灰）。必须用原型上的原生 setter 改值再派发 input 事件。
  const fireInput = (): void => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    fireInput();
    return true;
  }
  if (el instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    fireInput();
    return true;
  }
  if (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute('contenteditable') === 'true')) {
    el.textContent = value;
    fireInput();
    return true;
  }
  return false;
}

/** 合成 Enter 键按下（React 受 onKeyDown 委托监听，合成事件可触达）。 */
export function pressEnter(el: Element): boolean {
  const init: KeyboardEventInit & { keyCode?: number } = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return true;
}

export function clickElement(el: Element): boolean {
  if (el instanceof HTMLElement) {
    el.click();
    return true;
  }
  return false;
}
