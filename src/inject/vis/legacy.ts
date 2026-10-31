/**
 * 旧版 vis-json 迁移层。
 *
 * 背景：早期会话 / 旧客户端产出的榜单 JSON 形如
 *   {"type":"ranking-list","title":"…","items":[{"rank":1,"title":"…","imdb":8.2}]}
 * 或 {"title":"…","items":[{"rank":1,"name":"…","score":"9.2"}]}
 * 它们没有 `v` / `root`，也没有 `Image` 节点，被严格渲染器整块拒绝，
 * 用户看到的就是「没有卡片 / 没有海报框」。
 *
 * 这里只做**纯数据映射**：认领白名单字段，产出合法的 A2UI v1 文档。
 * 输出仍然要经过 render.ts 的转义、深度和节点上限 —— 本文件不产生 HTML。
 * 图片地址只接受 http(s)，其余一律落到 `src:null` 的渐变海报位。
 */

import { isRecord, toText } from './escape';
import { A2UI_VERSION, MAX_CHILDREN_PER_NODE } from './types';

/** 单张旧卡片最多迁移多少条目（渲染器硬上限是 120 节点）。 */
const MAX_LEGACY_ITEMS = 10;
/** 占位海报的固定色相轮转，保证同一榜单每次渲染配色稳定。 */
const FALLBACK_HUES = [18, 205, 275, 145, 32, 320, 88, 240];
const SAFE_IMAGE_SRC = /^https?:\/\/\S+$/i;
const LEGACY_LIST_TYPES = new Set([
  'ranking-list',
  'ranking_list',
  'rankinglist',
  'ranking',
  'top-list',
  'toplist',
  'list',
  'cards',
  'gallery',
]);

type JsonRecord = Record<string, unknown>;

function textOf(value: unknown): string {
  return toText(value).trim();
}

function firstText(record: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = textOf(record[key]);
    if (value !== '') return value;
  }
  return '';
}

function safeImageSrc(item: JsonRecord): string | null {
  for (const key of ['src', 'poster', 'poster_url', 'posterUrl', 'image', 'image_url', 'cover']) {
    const value = item[key];
    if (typeof value === 'string' && SAFE_IMAGE_SRC.test(value.trim())) return value.trim();
  }
  return null;
}

function scoreLabel(item: JsonRecord): string {
  const parts: string[] = [];
  const imdb = firstText(item, ['imdb', 'imdb_score', 'imdbScore']);
  if (imdb !== '') parts.push(`IMDb ${imdb}`);
  const douban = firstText(item, ['douban', 'douban_score', 'doubanScore']);
  if (douban !== '') parts.push(`豆瓣 ${douban}`);
  if (douban === '') {
    const score = firstText(item, ['score', 'rating']);
    if (score !== '') parts.push(`评分 ${score}`);
  }
  return parts.join(' · ');
}

function legacyItemNode(item: unknown, index: number): JsonRecord | null {
  if (typeof item === 'string') {
    const text = item.trim();
    return text === '' ? null : { type: 'Text', text, variant: 'body' };
  }
  if (!isRecord(item)) return null;

  const title = firstText(item, ['title', 'name', 'original_title', 'originalTitle']);
  if (title === '') return null;

  const meta: string[] = [];
  const rank = textOf(item.rank);
  if (rank !== '') meta.push(`#${rank}`);
  const originalTitle = firstText(item, ['original_title', 'originalTitle']);
  if (originalTitle !== '' && originalTitle !== title) meta.push(originalTitle);
  const year = textOf(item.year);
  if (year !== '') meta.push(year);
  const genre = firstText(item, ['genre', 'type']);
  if (genre !== '') meta.push(genre);
  const director = firstText(item, ['director']);
  if (director !== '') meta.push(`导演 ${director}`);
  const score = scoreLabel(item);
  if (score !== '') meta.push(score);

  const details: JsonRecord[] = [{ type: 'Text', text: title, variant: 'subtitle' }];
  if (meta.length > 0) {
    details.push({ type: 'Text', text: meta.join(' · '), variant: 'meta' });
  }
  const note = firstText(item, ['note', 'summary', 'desc', 'description']);
  if (note !== '') details.push({ type: 'Text', text: note, variant: 'body' });
  if (Array.isArray(item.tags)) {
    const tags = item.tags.filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
      .slice(0, 6);
    if (tags.length > 0) details.push({ type: 'Text', text: tags.join(' · '), variant: 'meta' });
  }

  return {
    type: 'Row',
    children: [
      {
        type: 'Image',
        src: safeImageSrc(item),
        alt: `${title} 海报`,
        ratio: '2/3',
        fallback: { hue: FALLBACK_HUES[index % FALLBACK_HUES.length] },
      },
      { type: 'Column', children: details.slice(0, MAX_CHILDREN_PER_NODE) },
    ],
  };
}

/** 认出旧式榜单结构：显式 ranking type，或 items 里带 rank/score/name 等字段。 */
function isLegacyRanking(record: JsonRecord): boolean {
  if (!Array.isArray(record.items) || record.items.length === 0) return false;
  const kind = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
  if (LEGACY_LIST_TYPES.has(kind)) return true;
  return record.items.some((item) => isRecord(item) && (
    'rank' in item || 'score' in item || 'imdb' in item || 'name' in item || 'rating' in item
  ));
}

export interface LegacyUpgradeResult {
  /** 已经是 v1 文档，或无法识别时原样返回。 */
  doc: unknown;
  upgraded: boolean;
}

/**
 * 若输入是旧式榜单，迁移为 A2UI v1 文档；否则原样返回。
 * 纯函数，不修改入参。
 */
export function upgradeLegacyDocument(input: unknown): LegacyUpgradeResult {
  if (!isRecord(input)) return { doc: input, upgraded: false };
  if (input.v === A2UI_VERSION) return { doc: input, upgraded: false };
  if (!isLegacyRanking(input)) return { doc: input, upgraded: false };

  const items = (input.items as unknown[])
    .slice(0, MAX_LEGACY_ITEMS)
    .map((item, index) => legacyItemNode(item, index))
    .filter((node): node is JsonRecord => node !== null);
  if (items.length === 0) return { doc: input, upgraded: false };

  const children: JsonRecord[] = [
    {
      type: 'Text',
      text: firstText(input, ['title', 'name']) || '榜单',
      variant: 'title',
    },
  ];
  const subtitle = firstText(input, ['subtitle', 'description']);
  if (subtitle !== '') children.push({ type: 'Text', text: subtitle, variant: 'meta' });
  children.push(...items.slice(0, MAX_CHILDREN_PER_NODE - children.length));

  return {
    doc: { v: A2UI_VERSION, root: { type: 'Column', children } },
    upgraded: true,
  };
}
