/**
 * 权限策略契约（共享层）
 *
 * 唯一真源。src/host/policy.ts 从本文件 import 并 re-export，保持既有 import 路径不变。
 * 禁止在其他地方重复定义 POLICY_MODES / PANEL_POLICY_MODES / DEFAULT_POLICY_MODE。
 */

export const POLICY_MODES = ['workspace', 'ask', 'auto', 'full'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

/** 面板 UI 暴露的三档（ask 为旧档，不在 UI 中出现）。 */
export const PANEL_POLICY_MODES = ['workspace', 'auto', 'full'] as const;

export const DEFAULT_POLICY_MODE: PolicyMode = 'auto';

/** 档位展示名。 */
export const POLICY_MODE_LABELS: Readonly<Record<PolicyMode, string>> = {
  workspace: '仅工作区',
  ask: '询问审批',
  auto: '风险审批',
  full: '完全放开',
};

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value);
}
