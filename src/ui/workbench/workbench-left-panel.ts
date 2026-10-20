/**
 * 左栏（会话/任务列表）容器。本期只提供真实容器访问与清空，
 * 不捏造会话/任务条目（无数据源时保持空态）。
 *
 * @deprecated 当前 agent.html 直接提供 .left-panel/.pane-body 静态结构，
 * 且没有任何调用方（2026-10-20 X3 孤儿处置实测）。保留而非删除的原因：
 * 后端会话/任务列表数据源落地时，这两个纯 DOM 工具是唯一不需要重写的部分。
 * 一旦接线（workbench-left-panel 被 agent-panel 引用），应立即去掉本标记。
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
