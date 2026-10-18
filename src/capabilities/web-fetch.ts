/**
 * web-fetch —— 本地、纯函数、离线的 URL 抓取与正文抽取（ORD-002）
 *
 * 不真连网络：transport（取页函数）由调用方注入，单测用 mock。
 * 模块本身只做：URL 校验、超时竞态、正文大小上限、重定向次数上限、HTML→正文抽取。
 * 失败一律 { ok:false, error }，不抛异常。错误码见 CONTRACTS §6.1。
 */

import type { ExecuteResult } from './types';

export interface WebFetchTransportResult {
  status: number;
  headers?: Record<string, string>;
  body: string;
  url?: string; // 实际响应 URL（transport 可选回填；缺省用请求 URL）
}

/** 注入的取页通道：给定 url，返回响应。生产由主进程注入真实实现。 */
export type WebFetchTransport = (url: string) => Promise<WebFetchTransportResult>;

export interface WebFetchInput {
  url: string;
  transport?: WebFetchTransport; // 注入；缺省 fail-closed 返回 io-error
  timeoutMs?: number; // 单次取页超时，默认 10000
  maxBytes?: number; // 正文上限（按 body 字符数近似），默认 1_000_000
  maxRedirects?: number; // 重定向跟随上限，默认 5
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_EXTRACTED_TEXT = 20_000;

function ok(data: unknown): ExecuteResult {
  return { ok: true, data };
}
function fail(error: string): ExecuteResult {
  return { ok: false, error };
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 把 HTML 抽成纯正文：去 script/style/noscript，去标签，解基础实体，压缩空白。 */
function extractText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');

  body = decodeEntities(body).replace(/\s+/g, ' ').trim();
  if (body.length > MAX_EXTRACTED_TEXT) body = body.slice(0, MAX_EXTRACTED_TEXT);
  return { title, text: body };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/** 带超时的 transport 调用。超时 reject，由上层归一为错误码。 */
function callWithTimeout(
  transport: WebFetchTransport,
  url: string,
  timeoutMs: number,
): Promise<WebFetchTransportResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('timeout'));
    }, timeoutMs);
    transport(url).then(
      (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function webFetch(input: WebFetchInput): Promise<ExecuteResult> {
  if (typeof input.url !== 'string' || input.url.length === 0) {
    return fail('missing-argument');
  }
  if (!isHttpUrl(input.url)) {
    return fail('invalid-argument');
  }
  if (typeof input.transport !== 'function') {
    return fail('io-error'); // 无注入通道，fail-closed
  }

  const timeoutMs =
    typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBytes =
    typeof input.maxBytes === 'number' && input.maxBytes > 0 ? input.maxBytes : DEFAULT_MAX_BYTES;
  const maxRedirects =
    typeof input.maxRedirects === 'number' && input.maxRedirects >= 0
      ? Math.floor(input.maxRedirects)
      : DEFAULT_MAX_REDIRECTS;

  let currentUrl = input.url;
  let redirectCount = 0;

  for (;;) {
    let res: WebFetchTransportResult;
    try {
      res = await callWithTimeout(input.transport, currentUrl, timeoutMs);
    } catch (err) {
      return fail(err instanceof Error && err.message === 'timeout' ? 'io-error' : 'io-error');
    }

    const status = res.status || 0;
    const location = res.headers?.location;

    if (status >= 300 && status < 400 && location) {
      if (redirectCount >= maxRedirects) {
        return fail('limit-exceeded');
      }
      // 解析相对/绝对跳转地址
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        return fail('invalid-argument');
      }
      if (!isHttpUrl(next)) {
        return fail('invalid-argument');
      }
      redirectCount += 1;
      currentUrl = next;
      continue;
    }

    if (typeof res.body === 'string' && res.body.length > maxBytes) {
      return fail('limit-exceeded');
    }

    const { title, text } = extractText(typeof res.body === 'string' ? res.body : '');
    return ok({
      url: res.url || currentUrl,
      status,
      title,
      text,
      truncated: typeof res.body === 'string' && res.body.length > MAX_EXTRACTED_TEXT,
    });
  }
}
