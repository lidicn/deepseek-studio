/**
 * C-3: context-budget — 真实 token 计数 + 上下文裁剪。
 *
 * 策略：
 * 1. estimate：估算 token 数（中文按 1 字 = 1 token，英文按 4 字符 = 1 token）
 * 2. trim：超预算时，保留最近 N 轮，中间的用摘要替代
 * 3. verbatim：最近的一轮始终原文保留
 */

/** 估算文本的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // 简单估算：中文按 1 字 = 1 token，英文按 4 字符 = 1 token
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars + otherChars / 4);
}

/** 一条消息 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ContextBudgetOptions {
  /** 最大 token 数 */
  maxTokens: number;
  /** 最近几轮原文保留 */
  recentRounds?: number;
}

/**
 * 裁剪消息列表，使其不超过预算。
 *
 * 策略：
 * 1. 系统消息始终保留
 * 2. 最近 recentRounds 轮（user + assistant 为一轮）始终原文保留
 * 3. 中间的消息如果超预算，用「[历史对话已省略]」替代
 */
export function trimMessages(messages: Message[], options: ContextBudgetOptions): Message[] {
  const { maxTokens, recentRounds = 2 } = options;

  // 估算总 token 数
  let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (totalTokens <= maxTokens) {
    return messages;
  }

  // 分离系统消息和其他消息
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const otherMsgs = messages.filter((m) => m.role !== 'system');

  // 最近 N 轮 = 2N 条消息（user + assistant）
  const recentCount = recentRounds * 2;
  const recentMsgs = otherMsgs.slice(-recentCount);
  const middleMsgs = otherMsgs.slice(0, -recentCount);

  // 估算中间消息的 token 数
  const middleTokens = middleMsgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const recentTokens = recentMsgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const systemTokens = systemMsgs.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // 如果中间消息的 token 数 > 预算 - 系统 - 最近，就裁剪中间消息
  const budgetForMiddle = maxTokens - systemTokens - recentTokens - 50; // 50 是省略标记的 token 数
  if (middleTokens <= budgetForMiddle) {
    return messages;
  }

  // 裁剪中间消息：用一条省略消息替代
  const omittedMsg: Message = {
    role: 'system',
    content: `[历史对话已省略 ${middleMsgs.length} 条消息，约 ${middleTokens} tokens]`,
  };

  return [...systemMsgs, omittedMsg, ...recentMsgs];
}
