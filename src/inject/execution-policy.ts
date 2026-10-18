/**
 * execution-policy.ts — 工具执行策略（移植自 deepseek++ execution-policy.ts）
 * @upstream-commit 187f6227 @upstream-path src/core/inline-agent/execution-policy.ts
 *
 * 功能：
 * - 工具风险评估
 * - 审批策略
 * - 哪些工具执行后不需要续跑
 */

/** 高风险工具（需要审批） */
const HIGH_RISK_TOOLS = new Set<string>([
  'shell_exec',
  'python_exec',
  'local_file_write',
  'local_file_delete',
  'memory_delete',
]);

/** 执行后不需要续跑的工具（纯本地副作用，结果已渲染在 UI） */
const NO_CONTINUATION_TOOLS = new Set<string>([
  // 目前所有工具都需要续跑，保持空集合
]);

/** 评估工具风险等级 */
export function assessToolRisk(toolName: string): 'low' | 'medium' | 'high' {
  if (HIGH_RISK_TOOLS.has(toolName)) return 'high';
  if (toolName.startsWith('local_file_') || toolName.startsWith('memory_')) return 'medium';
  return 'low';
}

/** 判断工具执行后是否需要续跑 */
export function needsContinuation(toolName: string): boolean {
  return !NO_CONTINUATION_TOOLS.has(toolName);
}

/** 过滤出需要续跑的工具执行记录 */
export function filterContinuableTools(toolNames: string[]): string[] {
  return toolNames.filter((name) => !NO_CONTINUATION_TOOLS.has(name));
}

/** 判断是否需要用户审批 */
export function requiresConsent(toolName: string): boolean {
  return assessToolRisk(toolName) === 'high';
}
