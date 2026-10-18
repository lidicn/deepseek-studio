import { describe, expect, it } from 'vitest';
import { buildSearchQuery, webSearch } from '../../src/capabilities/web-search';

describe('buildSearchQuery', () => {
  it('归一空白并 URL 编码', () => {
    expect(buildSearchQuery('  hello   world  ')).toEqual({ q: 'hello world', encoded: 'hello%20world' });
    expect(buildSearchQuery('中文 词').encoded).toBe('%E4%B8%AD%E6%96%87%20%E8%AF%8D');
  });
});

describe('webSearch', () => {
  it('缺 query → missing-argument', async () => {
    // @ts-expect-error 故意缺 query
    const res = await webSearch({});
    expect(res.error).toBe('missing-argument');
  });

  it('无 fixtures → workspace-unconfigured', async () => {
    const res = await webSearch({ query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('workspace-unconfigured');
  });

  it('解析 {results:[...]} 标准形状', async () => {
    const res = await webSearch({
      query: 'deepseek',
      fixtures: { results: [{ title: 'A', url: 'https://a/1', snippet: 'snippet one' }] },
    });
    expect(res.ok).toBe(true);
    const d = res.data as any;
    expect(d.items.length).toBe(1);
    expect(d.items[0]).toEqual({ title: 'A', url: 'https://a/1', snippet: 'snippet one' });
  });

  it('容忍 google 风格 {items:[{title,link,description}]}', async () => {
    const res = await webSearch({
      query: 'x',
      fixtures: { items: [{ title: 'T', link: 'https://t', description: 'desc' }] },
    });
    expect((res.data as any).items[0]).toEqual({ title: 'T', url: 'https://t', snippet: 'desc' });
  });

  it('坏 fixture 不崩，返回空 items', async () => {
    const res = await webSearch({ query: 'x', fixtures: 'this is not an object' });
    expect(res.ok).toBe(true);
    expect((res.data as any).items).toEqual([]);
  });

  it('fixture 为数组但元素形状奇怪 → 跳过坏项不崩', async () => {
    const res = await webSearch({
      query: 'x',
      fixtures: [null, 42, { title: 'Good', url: 'https://g', snippet: 'ok' }],
    });
    const d = res.data as any;
    expect(d.items.length).toBe(1);
    expect(d.items[0].title).toBe('Good');
  });

  it('limit 生效截断', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `https://${i}`, snippet: 's' }));
    const res = await webSearch({ query: 'x', fixtures: { results: many }, limit: 2 });
    expect((res.data as any).items.length).toBe(2);
  });
});
