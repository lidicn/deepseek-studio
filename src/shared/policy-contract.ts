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

/**
 * 「完全放开（full）」档下**仍然要问一次**的 always 类工具——**显式例外清单**。
 *
 * 语义（2026-11-08 出资人拍板「完全放开改成不会弹窗」，卡 H）：
 *   - full 档下 `approvalClass === 'always'` 的工具**默认不再询问**（用户已选择完全放开）；
 *   - 但本清单里的工具**仍然逐次人工确认**：它们不可撤销、且用户开完全放开时多半没意识到。
 *   - `memory.delete`（归档，可恢复）／`memory.unarchive`（恢复）**不在**清单里，照常放行。
 *
 * 为什么只有 `memory.purge`：它是唯一「彻底删除、不可恢复」（可连审计快照一起抹）的入口。
 * 新增例外必须同时补测试（`tests/desktop/full-mode-no-prompt.test.ts` 有正负控）。
 */
export const FULL_MODE_STILL_ASKS: readonly string[] = ['memory.purge'];

/** full 档下 always 类直接放行时写进审计的 reason 值（可追溯、可检索）。 */
export const FULL_MODE_ALLOW_REASON = 'full-mode-allow';

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
