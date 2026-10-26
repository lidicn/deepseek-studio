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
 * 省略标记自身的 token 预留。
 * F-0-3：旧值 50 是硬编码魔数——实测标记文本 22~31 token，50 偏保守但可用；
 * 提为常量是为了让「预留量 ≥ 实际标记长度」这条前提可被测试断言，
 * 避免将来标记文案变长后预算被自己挤穿。
 */
export const OMITTED_MARKER_TOKEN_OVERHEAD = 50;

/**
 * 裁剪消息列表，使其不超过预算。
 *
 * 策略：
 * 1. 系统消息始终保留
 * 2. 最近 recentRounds 轮（user + assistant 为一轮）始终原文保留
 * 3. 中间的消息如果超预算，用「[历史对话已省略]」替代
 *
 * 已知边界（F-0，见 tests/desktop/shared-context-budget.test.ts 同名用例）：
 * 当「系统消息 + 最近 N 轮原文」本身就超预算时，本策略受「最近 N 轮必须原文保留」
 * 的约束，无法再压——此时返回**尽力裁剪**的结果，它严格小于输入但仍可能 > maxTokens。
 * 调用方若要硬保证不超预算，必须在更外层继续削减 recent 段。
 */
export function trimMessages(messages: Message[], options: ContextBudgetOptions): Message[] {
  const { maxTokens, recentRounds = 2 } = options;

  // 估算总 token 数
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
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

  // F-0-1：没有中间消息可裁时原样返回。旧实现会走下面的裁剪分支，给空数组
  // 套一条「[历史对话已省略 0 条消息，约 0 tokens]」——消息数变多、token 变多，
  // 既违反「不超预算」契约，又把一句无意义的话塞进模型上下文。
  if (middleMsgs.length === 0) return messages;

  // 如果中间消息的 token 数 > 预算 - 系统 - 最近，就裁剪中间消息
  // F-0-2：下限钳到 0。旧实现可能算出负预算（recent/system 已吃满），
  // 而「middleTokens <= 负数」对任何非空 middle 恒为假，判断语义是反的。
  const budgetForMiddle = Math.max(0, maxTokens - systemTokens - recentTokens - OMITTED_MARKER_TOKEN_OVERHEAD);
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
