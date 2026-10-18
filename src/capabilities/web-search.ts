/**
 * web-search —— 本地、纯函数、离线的搜索查询构造 + 结果解析（ORD-003）
 *
 * 不真连网络：原始结果由调用方以 fixtures 注入（mock 通道）。
 * 模块只做：查询归一/编码、把任意形状的 fixture 稳健映射到稳定结果结构。
 * 解析坏 fixture 不崩：返回空 items，不抛异常。错误码见 CONTRACTS §6.1。
 */

import type { ExecuteResult } from './types';

export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchInput {
  query: string;
  fixtures?: unknown; // mock 通道返回的原始数据；缺省 = 通道未配置
  limit?: number; // 最多返回几条，默认 10
}

const DEFAULT_LIMIT = 10;
const MAX_SNIPPET = 300;

function ok(data: unknown): ExecuteResult {
  return { ok: true, data };
}
function fail(error: string): ExecuteResult {
  return { ok: false, error };
}

/** 查询归一 + 构造搜索 URL（纯函数，便于单测快照）。 */
export function buildSearchQuery(query: string): { q: string; encoded: string } {
  const q = query.trim().replace(/\s+/g, ' ');
  return { q, encoded: encodeURIComponent(q) };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function cleanSnippet(s: string): string {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > MAX_SNIPPET ? c.slice(0, MAX_SNIPPET) : c;
}

/**
 * 从任意 fixture 中抽取结果数组。容忍常见形状：
 * - { results: [...] } / { items: [...] } / { data: { results: [...] } } / 直接是数组
 * 每条容忍 {title,url,snippet|desc|summary} 或 {name,link,description}。
 */
function extractItems(fixtures: unknown): WebSearchItem[] {
  let arr: unknown = fixtures;
  if (arr && typeof arr === 'object' && !Array.isArray(arr)) {
    const rec = arr as Record<string, unknown>;
    arr = rec.results ?? rec.items ?? rec.docs ?? rec.webPages ?? (rec.data as Record<string, unknown>)?.results ?? [];
  }
  if (!Array.isArray(arr)) return [];

  const out: WebSearchItem[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const title = asString(r.title ?? r.name ?? r.headline);
    const url = asString(r.url ?? r.link ?? r.href ?? r.displayUrl);
    const snippet = cleanSnippet(asString(r.snippet ?? r.description ?? r.summary ?? r.content));
    out.push({ title, url, snippet });
  }
  return out;
}

export async function webSearch(input: WebSearchInput): Promise<ExecuteResult> {
  if (typeof input.query !== 'string' || input.query.trim().length === 0) {
    return fail('missing-argument');
  }
  if (input.fixtures === undefined) {
    return fail('workspace-unconfigured');
  }

  const limit =
    typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT;

  const { q, encoded } = buildSearchQuery(input.query);
  const items = extractItems(input.fixtures).slice(0, limit);

  return ok({ query: q, encoded, items, total: items.length, truncated: false });
}
