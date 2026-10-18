import { describe, expect, it } from 'vitest';
import { compressHistory, type HistoryMessage } from '../../src/capabilities/context-compress';

describe('compressHistory', () => {
  it('空/短 history 不压缩原样返回', async () => {
    const h: HistoryMessage[] = [{ role: 'user', content: 'hi' }];
    const res = await compressHistory({ history: h, budget: 1000 });
    expect(res.ok).toBe(true);
    const d = res.data as any;
    expect(d.compressed).toBe(false);
    expect(d.messages.length).toBe(1);
    expect(d.dropped).toBe(0);
  });

  it('超长 history 压缩：保留最新 user 与最近 assistant', async () => {
    const h: HistoryMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'old question ' + 'x'.repeat(200) },
      { role: 'assistant', content: 'old answer ' + 'y'.repeat(200) },
      { role: 'user', content: 'another old ' + 'z'.repeat(200) },
      { role: 'assistant', content: 'recent answer ' + 'w'.repeat(200) },
      { role: 'user', content: 'THE LATEST USER QUESTION' },
    ];
    const res = await compressHistory({ history: h, budget: 400 });
    expect(res.ok).toBe(true);
    const d = res.data as any;
    expect(d.compressed).toBe(true);
    // system 保留
    expect(d.messages.some((m: HistoryMessage) => m.content === 'SYS')).toBe(true);
    // 最新 user 原文保留
    const last = d.messages[d.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe('THE LATEST USER QUESTION');
    // 产出比输入短
    expect(d.outputChars).toBeLessThan(d.inputChars);
  });

  it('非数组 history → invalid-argument 不崩', async () => {
    // @ts-expect-error 故意传错类型
    const res = await compressHistory({ history: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
  });

  it('空数组不崩', async () => {
    const res = await compressHistory({ history: [] });
    expect(res.ok).toBe(true);
    expect((res.data as any).messages).toEqual([]);
  });
});
