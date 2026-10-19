/**
 * Reasoning 组件：当前无 reasoning 数据源，不渲染、不据普通 assistant 文本猜测思考过程。
 * 未来接入真实字段时默认折叠；本期传入空即返回 null。
 */

export function renderReasoning(text: string | null | undefined): HTMLElement | null {
  if (!text) return null;
  const el = document.createElement('details');
  el.className = 'wb-reasoning';
  const summary = document.createElement('summary');
  summary.textContent = '思考过程';
  const body = document.createElement('div');
  body.className = 'wb-reasoning-body';
  body.textContent = text;
  el.appendChild(summary);
  el.appendChild(body);
  return el;
}
