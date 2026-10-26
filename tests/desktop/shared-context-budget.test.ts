/**
 * C-3: context-budget 测试
 *
 * F-0（2026-10-26 复核）：旧实现有一处放水断言（预算 500 却断言 `<=550`），
 * 且当「最近 N 轮自身超预算」时根本压不进预算。本文件把断言收紧到真契约，
 * 并为 F-0 的三个修复点各补一条用例。
 */
import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  trimMessages,
  OMITTED_MARKER_TOKEN_OVERHEAD,
  type Message,
} from '../../src/shared/context-budget';

describe('C-3 context-budget', () => {
  it('估算 token 数：中文和英文分别计算', () => {
    expect(estimateTokens('你好世界')).toBe(4); // 4 个中文字 = 4 tokens
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens('')).toBe(0);
  });

  it('超预算输入 → 产出严格不超预算且保留最近 N 轮', () => {
    // 造 10 条消息，每条 100 tokens
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'a'.repeat(400) }); // 每条约 100 tokens
    }

    // 预算 500 tokens（最近 2 轮约 400 tokens，middle 段裁掉后能进预算）
    const trimmed = trimMessages(messages, { maxTokens: 500, recentRounds: 2 });

    // 真契约：产出 <= 预算，不再放 50 的余量（旧断言 <=550 掩盖了负预算分支）。
    const totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    expect(totalTokens).toBeLessThanOrEqual(500);

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

  it('F-0-1：无可裁中间消息时原样返回，绝不插入「省略 0 条」空标记', () => {
    // 复现报告的故障：2 条消息（user 1000 + system 3），maxTokens=10。
    // 非 system 只有 1 条 < recentCount(4)，middleMsgs 为空；旧实现仍走裁剪分支，
    // 产出 3 条（多一条「已省略 0 条消息」）且 token 从 1001 涨到 1016。
    const messages: Message[] = [
      { role: 'user', content: '啊'.repeat(1000) },
      { role: 'system', content: 'sys' },
    ];
    const trimmed = trimMessages(messages, { maxTokens: 10 });
    // 原样返回：条数不减、不加空标记。
    expect(trimmed.length).toBe(2);
    expect(trimmed.some((m) => m.content.includes('已省略 0 条'))).toBe(false);
    // 关键回归：产出 token 绝不能超过输入的 1001。
    const total = trimmed.reduce((s, m) => s + estimateTokens(m.content), 0);
    expect(total).toBeLessThanOrEqual(1001);
  });

  it('F-0-4：最近 N 轮自身超预算时返回尽力裁剪结果（严格小于输入，但可能仍 > 预算）', () => {
    // 诚实钉死已知边界：预算 100，但最近 4 条各 ~100 token（仅 a.repeat(400)≈100）
    // 已 400，策略受「recent 原文保留」约束无法再压。契约在此无法满足——
    // 本用例断言「尽力」而非「达标」，避免将来有人误以为它能硬守预算。
    const messages: Message[] = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'a'.repeat(400) },
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'a'.repeat(400) },
      { role: 'user', content: '中间应被裁掉'.repeat(50) },
    ];
    const before = messages.reduce((s, m) => s + estimateTokens(m.content), 0);
    const trimmed = trimMessages(messages, { maxTokens: 100, recentRounds: 2 });
    const after = trimmed.reduce((s, m) => s + estimateTokens(m.content), 0);
    // 尽力裁剪：结果严格小于输入（裁掉了 middle），即便仍超 100。
    expect(after).toBeLessThan(before);
  });

  it('F-0-3：省略标记预留量 >= 标记实际估算 token（预算不被自己挤穿）', () => {
    // 标记文案含条数与 token 数，最坏是长数字。断言预留常量覆盖得住。
    const marker: Message = {
      role: 'system',
      content: `[历史对话已省略 999 条消息，约 99999 tokens]`,
    };
    expect(estimateTokens(marker.content)).toBeLessThanOrEqual(OMITTED_MARKER_TOKEN_OVERHEAD);
  });
});
