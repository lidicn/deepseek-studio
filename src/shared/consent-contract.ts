/**
 * 审批决策契约（共享层）
 *
 * 唯一允许的三种审批结果。禁止出现"始终允许"。
 * allow-session 的语义：工具 + 参数指纹 + 10 分钟 TTL。
 */

export type ConsentDecision = 'allow-once' | 'deny' | 'allow-session';

export const CONSENT_DECISIONS = ['allow-once', 'deny', 'allow-session'] as const;

export const CONSENT_BUTTON_LABELS: Readonly<Record<ConsentDecision, string>> = {
  'allow-once': '允许一次',
  deny: '拒绝',
  'allow-session': '本次会话允许（10 分钟）',
};
