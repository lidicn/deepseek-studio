/**
 * 左栏（会话/任务列表）容器。本期只提供真实容器访问与清空，
 * 不捏造会话/任务条目（无数据源时保持空态）。
 */

/** 取左栏主体；不存在则创建 .pane-body。 */
export function getLeftPanelBody(panel: HTMLElement): HTMLElement {
  let body = panel.querySelector<HTMLElement>('.pane-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'pane-body';
    panel.appendChild(body);
  }
  return body;
}

/** 清空左栏条目（不移除空态容器本身）。 */
export function clearLeftPanel(panel: HTMLElement): void {
  const body = getLeftPanelBody(panel);
  body.querySelectorAll('.session-item, .task-item').forEach((n) => n.remove());
}
