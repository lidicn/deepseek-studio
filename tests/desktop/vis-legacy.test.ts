/**
 * 旧式榜单 JSON → A2UI v1 迁移层测试。
 *
 * 旧会话里的 `{"type":"ranking-list","items":[...]}` 没有 v/root，也没有 Image 节点。
 * 这里验证迁移结果字段完整、海报位齐全、数量有上限，且不误伤 v1 文档和普通对象。
 */
import { describe, expect, it } from 'vitest';
import { upgradeLegacyDocument } from '../../src/inject/vis/legacy';

interface AnyNode {
  type: string;
  [key: string]: unknown;
}

function rootOf(doc: unknown): AnyNode {
  const record = doc as { root?: AnyNode };
  expect(record.root).toBeTruthy();
  return record.root as AnyNode;
}

function rowsOf(doc: unknown): AnyNode[] {
  const children = rootOf(doc).children as AnyNode[];
  return children.filter((node) => node.type === 'Row');
}

describe('vis legacy 迁移', () => {
  it('映射标题、元信息、备注、标签与 IMDb 评分', () => {
    const legacy = {
      type: 'ranking-list',
      title: '2026 高分悬疑电影',
      subtitle: 'IMDb > 7.0',
      items: [
        {
          rank: 1,
          title: '痴迷',
          original_title: 'Obsession',
          year: 2026,
          genre: '惊悚 / 悬疑',
          director: 'Curry Barker',
          imdb: 8.2,
          note: '许愿 Willow 引发的恐怖连锁。',
          tags: ['惊悚', '悬疑'],
        },
      ],
    };
    const { doc, upgraded } = upgradeLegacyDocument(legacy);
    expect(upgraded).toBe(true);
    expect((doc as { v: number }).v).toBe(1);
    const texts = JSON.stringify(doc);
    expect(texts).toContain('2026 高分悬疑电影');
    expect(texts).toContain('IMDb > 7.0');
    expect(texts).toContain('痴迷');
    expect(texts).toContain('Obsession');
    expect(texts).toContain('2026');
    expect(texts).toContain('导演 Curry Barker');
    expect(texts).toContain('IMDb 8.2');
    expect(texts).toContain('惊悚 · 悬疑');
  });

  it('每条都生成 2:3 海报位，hue 按条轮转', () => {
    const legacy = {
      title: '测试榜单',
      items: [
        { rank: 1, name: 'A' },
        { rank: 2, name: 'B' },
      ],
    };
    const rows = rowsOf(upgradeLegacyDocument(legacy).doc);
    expect(rows).toHaveLength(2);
    const first = rows[0].children as AnyNode[];
    const second = rows[1].children as AnyNode[];
    expect(first[0].type).toBe('Image');
    expect(first[0].ratio).toBe('2/3');
    expect(first[0].src).toBeNull();
    expect((first[0].fallback as { hue: number }).hue).toBe(18);
    expect((second[0].fallback as { hue: number }).hue).toBe(205);
  });

  it('只接受 http(s) 海报地址，其它协议回落 null', () => {
    const legacy = {
      type: 'ranking-list',
      items: [
        { name: 'A', poster: 'https://example.com/a.jpg' },
        { name: 'B', poster: 'javascript:alert(1)' },
        { name: 'C', poster: 'data:image/png;base64,xxx' },
      ],
    };
    const rows = rowsOf(upgradeLegacyDocument(legacy).doc);
    expect(rows).toHaveLength(3);
    expect((rows[0].children as AnyNode[])[0].src).toBe('https://example.com/a.jpg');
    expect((rows[1].children as AnyNode[])[0].src).toBeNull();
    expect((rows[2].children as AnyNode[])[0].src).toBeNull();
  });

  it('最多迁移 10 条', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ rank: i + 1, name: `第 ${i + 1} 条` }));
    const rows = rowsOf(upgradeLegacyDocument({ title: '长榜单', items }).doc);
    expect(rows).toHaveLength(10);
  });

  it('v1 文档原样返回，不重复迁移', () => {
    const v1 = { v: 1, root: { type: 'Text', text: 'x' } };
    const result = upgradeLegacyDocument(v1);
    expect(result.upgraded).toBe(false);
    expect(result.doc).toBe(v1);
  });

  it('普通对象（没有 items）原样返回', () => {
    const plain = { title: '只是数据', foo: [1, 2, 3] };
    const result = upgradeLegacyDocument(plain);
    expect(result.upgraded).toBe(false);
    expect(result.doc).toBe(plain);
  });

  it('有 items 但没有任何榜单特征时不认领', () => {
    const plain = { title: '文章目录', items: [{ slug: 'a' }, { slug: 'b' }] };
    const result = upgradeLegacyDocument(plain);
    expect(result.upgraded).toBe(false);
    expect(result.doc).toBe(plain);
  });
});
