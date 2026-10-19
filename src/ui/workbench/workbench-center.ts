/**
 * 中栏画布：把 user/assistant/status/error 消息追加到 center-canvas。
 * 一律 textContent，不使用 innerHTML（安全由 W4 统一收口）。
 */

export type CenterMessageKind = 'user' | 'assistant' | 'status' | 'error';

/** 取中栏主体；不存在则创建 .canvas-body。 */
export function getCenterBody(canvas: HTMLElement): HTMLElement {
  let body = canvas.querySelector<HTMLElement>('.canvas-body, .pane-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'pane-body canvas-body';
    canvas.appendChild(body);
  }
  return body;
}

/** 追加一条消息；首次有内容时移除欢迎空态。 */
export function appendMessage(canvas: HTMLElement, kind: CenterMessageKind, text: string): HTMLElement {
  const body = getCenterBody(canvas);
  body.querySelectorAll('.welcome, .empty-state, [data-empty]').forEach((n) => n.remove());

  const el = document.createElement('div');
  el.className = `msg msg-${kind}`;
  el.textContent = text;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}
