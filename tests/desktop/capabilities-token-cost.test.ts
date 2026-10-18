import { describe, expect, it } from 'vitest';
import { addUsage, estimateTokens, trackUsage, zeroCost } from '../../src/capabilities/token-cost';

describe('estimateTokens', () => {
  it('空串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('CJK 与拉丁混合粗估', () => {
    expect(estimateTokens('你好世界')).toBe(4); // 4 CJK
    expect(estimateTokens('hello world')).toBe(3); // 11 chars -> ceil(11/4)=3
  });
});

describe('addUsage / zeroCost', () => {
  it('可累计：两次 usage 相加', () => {
    let s = zeroCost();
    s = addUsage(s, { promptTokens: 100, completionTokens: 50 });
    s = addUsage(s, { promptTokens: 200, completionTokens: 100 });
    expect(s.promptTokens).toBe(300);
    expect(s.completionTokens).toBe(150);
    expect(s.totalTokens).toBe(450);
  });

  it('按价格算 cost', () => {
    const s = addUsage(zeroCost(), { promptTokens: 1000, completionTokens: 1000 }, { prompt: 2, completion: 4 });
    // 1k * 2 + 1k * 4 = 6
    expect(s.costUsd).toBe(6);
  });

  it('可重置', () => {
    let s = addUsage(zeroCost(), { promptTokens: 50 });
    expect(s.totalTokens).toBe(50);
    s = zeroCost();
    expect(s.totalTokens).toBe(0);
  });
});

describe('trackUsage', () => {
  it('从空 state 累计', async () => {
    const res = await trackUsage({ usage: { promptTokens: 10, completionTokens: 5 } });
    expect(res.ok).toBe(true);
    expect((res.data as any).totalTokens).toBe(15);
  });

  it('text 走估算口径计入', async () => {
    const res = await trackUsage({ text: '你好世界hello' });
    const d = res.data as any;
    // 4 CJK + 'hello'(5)->2 => 6
    expect(d.promptTokens).toBe(6);
  });

  it('reset=true 先清零', async () => {
    const res = await trackUsage({ state: { promptTokens: 100, completionTokens: 1, totalTokens: 101, costUsd: 0.1 }, reset: true, usage: { promptTokens: 1 } });
    const d = res.data as any;
    expect(d.promptTokens).toBe(1);
    expect(d.totalTokens).toBe(1);
  });

  it('空/非法输入不崩', async () => {
    expect((await trackUsage({})).ok).toBe(true);
    // @ts-expect-error 故意传错
    expect((await trackUsage(null)).error).toBe('invalid-argument');
  });
});
