/**
 * 工具调用重试策略（v0.1）
 *
 * 对齐 docs/设计稿/M5-编程工具链最终设计稿.md 第 7.2 节。
 * 只对可重试错误做有限重试，永久失败不重试。
 */

import type { ToolErrorEnvelope } from './tool-error-envelope';

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 3000,
};

/**
 * 计算下次重试的延迟（指数退避）。
 */
export function nextDelay(policy: RetryPolicy, attempt: number): number {
  const delay = policy.baseDelayMs * Math.pow(2, attempt);
  return Math.min(delay, policy.maxDelayMs);
}

/**
 * 判断是否应该重试。
 */
export function shouldRetry(envelope: ToolErrorEnvelope, attempt: number, policy: RetryPolicy): boolean {
  if (envelope.kind !== 'retryable') return false;
  return attempt < policy.maxRetries;
}
