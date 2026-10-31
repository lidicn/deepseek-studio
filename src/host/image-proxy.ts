/**
 * 宿主侧图片代理：把页端拿不到的远程图（豆瓣等防盗链图源）取回来，
 * 转成 `data:` URL 交给渲染层。
 *
 * 安全边界（这是公网页可以请求的 runtime 命令，按不可信输入对待）：
 *  - 只允许 http/https；
 *  - 解析后**所有**地址都必须是公网地址（拒绝回环/私网/链路本地/组播等）；
 *  - 手动跟随重定向，每一跳重新做协议 + 地址校验，最多 5 跳；
 *  - 10s 超时，响应体上限 8 MiB；
 *  - Content-Type 必须是 image/*，且文件头魔数必须匹配 JPEG/PNG/WebP/GIF/AVIF，
 *    否则视为反爬 HTML 页，不能喂给 <img>。
 *
 * 只做「取字节」，不落盘、不缓存到宿主；缓存交给页端（见 vis-card.ts）。
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** 单张图上限：8 MiB（海报/封面绰绰有余，避免被大文件拖死）。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

/** 豆瓣图床对桌面 Chrome UA + movie.douban.com Referer 放行；其余图源不伪造。 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';
const DOUBAN_REFERER = 'https://movie.douban.com/';

export type ImageProxyResult =
  | { ok: true; dataUrl: string; contentType: string; bytes: number }
  | { ok: false; error: string };

export interface ImageProxyDeps {
  /** 测试注入点：返回该主机解析到的全部 IP。 */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** 测试注入点：默认用 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
}

function isDoubanHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'douban.com' ||
    host.endsWith('.douban.com') ||
    host === 'doubanio.com' ||
    host.endsWith('.doubanio.com')
  );
}

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateIPv4(ip: string): boolean {
  const p = parseIPv4(ip);
  if (p === null) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // 链路本地（云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 0 && p[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && p[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && p[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 组播 / 保留 / 广播
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped：::ffff:127.0.0.1 / ::ffff:7f00:1
  const mapped = addr.match(/^::ffff:(.+)$/);
  if (mapped !== null) {
    const rest = mapped[1];
    if (isIP(rest) === 4) return isPrivateIPv4(rest);
    const hex = rest.split(':');
    if (hex.length === 2) {
      const hi = parseInt(hex[0], 16);
      const lo = parseInt(hex[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
    }
    return true;
  }
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(addr)) return true; // 链路本地 fe80::/10
  if (addr.startsWith('ff')) return true; // 组播
  if (addr.startsWith('64:ff9b:')) return true; // NAT64
  return false;
}

function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return !isPrivateIPv4(ip);
  if (version === 6) return !isPrivateIPv6(ip);
  return false;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/** 校验 URL 并解析出全部公网地址；返回规范化 URL。 */
async function assertPublicUrl(
  raw: string,
  deps: ImageProxyDeps,
): Promise<{ url: URL } | { error: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'blocked_scheme' };
  if (url.username !== '' || url.password !== '') return { error: 'blocked_credentials' };
  if (url.port !== '' && url.port !== '80' && url.port !== '443') return { error: 'blocked_port' };

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '' || blockedHostname(hostname)) return { error: 'blocked_host' };

  if (isIP(hostname) !== 0) {
    return isPublicAddress(hostname) ? { url } : { error: 'blocked_address' };
  }

  let addresses: string[];
  try {
    addresses = await (deps.resolveHost ?? defaultResolveHost)(hostname);
  } catch {
    return { error: 'dns_failed' };
  }
  if (addresses.length === 0) return { error: 'dns_failed' };
  if (!addresses.every(isPublicAddress)) return { error: 'blocked_address' };
  return { url };
}

function sniffImageType(buf: Uint8Array): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 6) {
    const head = String.fromCharCode(...buf.slice(0, 6));
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12) {
    const riff = String.fromCharCode(...buf.slice(0, 4));
    const webp = String.fromCharCode(...buf.slice(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  if (buf.length >= 12 && String.fromCharCode(...buf.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...buf.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function headersFor(url: URL): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
  };
  if (isDoubanHost(url.hostname)) {
    headers.Referer = DOUBAN_REFERER;
    headers['User-Agent'] = DESKTOP_UA;
  }
  return headers;
}

/**
 * 抓取远程图片并编码成 data URL。
 * 永不 throw：所有失败都走 `{ok:false}`，方便页端统一降级到渐变占位。
 */
export async function fetchImageAsDataUrl(
  rawUrl: unknown,
  deps: ImageProxyDeps = {},
): Promise<ImageProxyResult> {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return { ok: false, error: 'invalid_url' };

  let current = rawUrl.trim();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable' };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const checked = await assertPublicUrl(current, deps);
    if ('error' in checked) return { ok: false, error: checked.error };
    const url = checked.url;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: headersFor(url),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const name = (e as { name?: string })?.name;
      return { ok: false, error: name === 'AbortError' ? 'timeout' : 'fetch_failed' };
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      const location = response.headers.get('location');
      if (location === null || location === '') return { ok: false, error: 'bad_redirect' };
      try {
        current = new URL(location, url).toString();
      } catch {
        return { ok: false, error: 'bad_redirect' };
      }
      continue;
    }

    if (!response.ok) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: `http_status:${response.status}` };
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: `not_image:${contentType || 'unknown'}` };
    }

    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, error: 'too_large' };
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(response.body);
    } catch {
      clearTimeout(timer);
      return { ok: false, error: 'read_failed' };
    }
    clearTimeout(timer);
    if (bytes === null) return { ok: false, error: 'too_large' };
    if (bytes.byteLength === 0) return { ok: false, error: 'empty_body' };

    const sniffed = sniffImageType(bytes);
    if (sniffed === null) return { ok: false, error: 'invalid_image' };

    return {
      ok: true,
      dataUrl: `data:${sniffed};base64,${Buffer.from(bytes).toString('base64')}`,
      contentType: sniffed,
      bytes: bytes.byteLength,
    };
  }

  return { ok: false, error: 'too_many_redirects' };
}
