/**
 * 会话级上下文预算（v2.0，移植自 deepseek-pp `src/core/chat/context-budget.ts`）
 *
 * 上游是零依赖纯函数，这里原样移植语义，只把命名对齐 Studio 前缀。
 *
 * 用途：把「上下文快满了」变成用户可见的三档提示，而不是让模型 silently 丢早期消息。
 * Studio 此前只有字符级截断（continuation-prompt.ts 的 4000/8000/400/8000 四档），
 * 用户侧表现是「轮次一多模型变笨」，但没有任何信号说明该开新会话。
 *
 * 重要边界（沿用上游注释，防止误用）：
 * - token 数是本地粗估，**不是服务端精确计数**；
 * - 只用于档位提示，**不用于截断决策**——截断仍由 continuation-prompt 的字符预算负责。
 */

export type StudioBudgetLevel = 'ok' | 'warn' | 'critical';

export interface StudioBudgetState {
  readonly level: StudioBudgetLevel;
  /** 剩余字符预算（可能为负，表示已超限）。 */
  readonly remaining: number;
  /** 估算字符数。 */
  readonly estimated: number;
}

export function evaluateStudioBudget(
  messageCount: number,
  estimatedChars: number,
  limit: number,
): StudioBudgetState {
  const ratio = estimatedChars / limit;
  const remaining = limit - estimatedChars;
  // 上游用 messageCount 占位（不参与计算），保留参数以维持签名一致。
  void messageCount;
  let level: StudioBudgetLevel = 'ok';
  if (ratio > 0.8) level = 'critical';
  else if (ratio >= 0.5) level = 'warn';
  return { level, remaining, estimated: estimatedChars };
}

/**
 * 经验占位上限（64k 字符）。非某一模型的精确窗口，仅用于本地粗估的三档可见化；
 * 精确 token 计数待后续 tokenizer / 服务端 usage 管线。
 *
 * 与上游 CHAT_CONTEXT_TOKEN_LIMIT = 64_000 的区别：上游估的是 token，
 * Studio 侧没有 tokenizer，改为按字符估，故上限同为 64k 但单位是字符。
 * 粗估规则下 1 个 CJK 字符 ≈ 1 个 ASCII 字符的权重，与上游的
 * 「CJK 每字约 1，ASCII 每 4 字符约 1」不同——Studio 按字符估，无需区分。
 */
export const STUDIO_CONTEXT_CHAR_LIMIT = 64_000;

/**
 * 统计 messages 数组的总字符数。兼容 content 为字符串或数组两种形态
 * （DeepSeek 请求体里可能是 [{type:'text',text:'...'}]）。
 */
export function estimateMessagesChars(messages: readonly unknown[]): number {
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === 'string') {
      total += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') total += text.length;
        }
      }
    }
  }
  return total;
}

/** 把待估算消息数组过粗估后交给 evaluateStudioBudget，返回三档快照。 */
export function evaluateStudioBudgetForMessages(
  messages: readonly unknown[],
  limit: number = STUDIO_CONTEXT_CHAR_LIMIT,
): StudioBudgetState {
  return evaluateStudioBudget(messages.length, estimateMessagesChars(messages), limit);
}

/** 三档对应的中文提示。ok 档返回空串（不打扰）。 */
export function describeStudioBudget(state: StudioBudgetState): string {
  if (state.level === 'critical') {
    return `上下文已接近上限（约 ${Math.round(state.estimated / 1000)}k / ${Math.round(state.remaining / 1000)}k 剩余），建议开新会话`;
  }
  if (state.level === 'warn') {
    return `上下文已过半（约 ${Math.round(state.estimated / 1000)}k 字符）`;
  }
  return '';
}
