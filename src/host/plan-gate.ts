/**
 * plan-gate.ts — Plan/Act 分离闸门（E3）
 *
 * 用户发 plan 消息 → 模型只输出计划文本，禁止工具调用。
 * 用户发 act 消息 → 模型可正常调工具。
 * 纯函数。
 */

export type Phase = 'plan' | 'act';

export interface PlanGateInput {
  /** 本 turn 用户消息是否带 plan 标记（如 /plan 前缀或 UI 按钮）。 */
  readonly isPlanRequest: boolean;
  /** 当前会话阶段：上一轮是 plan 还是 act。 */
  readonly currentPhase: Phase;
  /** 模型本轮是否发起了工具调用。 */
  readonly toolCalls: readonly unknown[];
}

export interface PlanGateResult {
  /** 本轮允许的阶段。 */
  readonly phase: Phase;
  /** 是否阻断工具调用。 */
  readonly blockTools: boolean;
  /** 阻断原因。 */
  readonly reason?: 'plan-no-tools' | 'plan-to-act-confirmation' | 'act-normal';
}

/**
 * Plan/Act 状态机：
 * - plan 请求进来 → phase=plan，blockTools=true
 * - plan 阶段模型输出纯文本 → 用户确认后切 act
 * - act 阶段 → 正常放行
 */
export function evaluatePlanGate(input: PlanGateInput): PlanGateResult {
  if (input.isPlanRequest) {
    if (input.toolCalls.length > 0) {
      return { phase: 'plan', blockTools: true, reason: 'plan-no-tools' };
    }
    return { phase: 'plan', blockTools: true, reason: 'plan-no-tools' };
  }

  if (input.currentPhase === 'plan') {
    // plan 阶段非 plan 请求：视为用户确认，切 act
    return { phase: 'act', blockTools: false, reason: 'plan-to-act-confirmation' };
  }

  return { phase: 'act', blockTools: false, reason: 'act-normal' };
}

/**
 * 从用户消息文本检测 plan 标记。
 * 规则：以 /plan 开头（允许空白）。
 */
export function detectPlanRequest(message: string): boolean {
  return /^\s*\/plan\b/i.test(message);
}
