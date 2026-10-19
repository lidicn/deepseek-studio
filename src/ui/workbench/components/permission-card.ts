/**
 * PermissionCard：显示当前 policyMode。修改走 set-policy，等待 state/ack 回传，
 * ack 前只显示 pending，不在本地假装成功。Focus 只读。
 */
import { POLICY_MODE_LABELS, type PolicyMode } from '../../../shared/policy-contract';

export interface PermissionCardInput {
  mode: PolicyMode | null | undefined;
  pending?: boolean;
}

export function renderPermissionCard(input: PermissionCardInput): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wb-permission-card';

  const label = document.createElement('div');
  label.className = 'wb-permission-label';
  label.textContent = '当前权限档位';

  const value = document.createElement('div');
  value.className = 'wb-permission-value';
  if (input.pending) {
    value.textContent = '切换中…';
    value.setAttribute('data-pending', 'true');
  } else if (input.mode) {
    value.textContent = POLICY_MODE_LABELS[input.mode] ?? input.mode;
    value.setAttribute('data-confirmed', 'true');
  } else {
    value.textContent = '未设置';
  }

  el.appendChild(label);
  el.appendChild(value);
  return el;
}
