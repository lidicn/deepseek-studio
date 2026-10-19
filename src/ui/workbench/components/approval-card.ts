/**
 * ApprovalCard：Workbench 无审批通道，本期只读。
 * 只提示「审批仍在宿主窗口完成」；不显示允许/拒绝/始终允许三个假按钮，
 * 不把 Plan 批准当成工具授权。
 */

export function renderApprovalCard(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wb-approval-card';
  el.setAttribute('data-readonly', 'true');

  const title = document.createElement('div');
  title.className = 'wb-approval-title';
  title.textContent = '审批仍在宿主窗口完成';

  const hint = document.createElement('div');
  hint.className = 'wb-approval-hint';
  hint.textContent = '请到主窗口处理本次授权，工作台不提供审批按钮。';

  el.appendChild(title);
  el.appendChild(hint);
  return el;
}
