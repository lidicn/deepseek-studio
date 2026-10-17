/**
 * C-3: context-budget 测试
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens, trimMessages, type Message } from '../../src/shared/context-budget';

describe('C-3 context-budget', () => {
  it('估算 token 数：中文和英文分别计算', () => {
    expect(estimateTokens('你好世界')).toBe(4); // 4 个中文字 = 4 tokens
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('')).toBe(0);
  });

  it('超预算输入 → 产出仍在预算内且保留最近 N 轮', () => {
    // 造 10 条消息，每条 100 tokens
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'a'.repeat(400) }); // 每条约 100 tokens
    }

    // 预算只有 500 tokens（最近 2 轮约 400 tokens，刚好够）
    const trimmed = trimMessages(messages, { maxTokens: 500, recentRounds: 2 });

    // 总 token 数应该在预算内
    const totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    expect(totalTokens).toBeLessThanOrEqual(550); // 加一点余量

    // 最近的消息应该保留（至少 2 条）
    const recentMsgs = trimmed.filter((m) => m.content.includes('a'.repeat(400)));
    expect(recentMsgs.length).toBeGreaterThanOrEqual(2);

    // 应该有省略标记
    const hasOmitted = trimmed.some((m) => m.content.includes('已省略'));
    expect(hasOmitted).toBe(true);
  });

  it('未超预算 → 原样返回', () => {
    const messages: Message[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮你的？' },
    ];
    const trimmed = trimMessages(messages, { maxTokens: 1000 });
    expect(trimmed).toEqual(messages);
  });
});
