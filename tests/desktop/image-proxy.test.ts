/**
 * 宿主侧图片代理测试（默认 node 环境）。
 *
 * 覆盖 SSRF 边界（私网/回环/非公网一律拒绝）、协议/端口限制、Content-Type 与
 * 魔数双重校验、超限拒绝、豆瓣防盗链 Referer 补头，以及成功转 data URL。
 * 网络全部用注入的 fetchImpl / resolveHost 模拟，http(s) 目标按公网地址放行。
 */
import { describe, expect, it } from 'vitest';
import { fetchImageAsDataUrl } from '../../src/host/image-proxy';

/** 1x1 透明 PNG 的魔数前缀（足以通过魔数嗅探）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const PUBLIC_RESOLVER = async () => ['93.184.216.34'];

function imageResponse(bytes: Uint8Array, contentType = 'image/png'): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('image-proxy SSRF 边界', () => {
  it('直接 IP 是私网 ⇒ blocked_address，不发请求', async () => {
    let called = false;
    const res = await fetchImageAsDataUrl('http://192.168.2.200/a.jpg', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async () => {
        called = true;
        return imageResponse(PNG_BYTES);
      }) as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: 'blocked_address' });
    expect(called).toBe(false);
  });

  it('DNS 解析到 127.0.0.1 ⇒ blocked_address', async () => {
    const res = await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: async () => ['127.0.0.1'],
      fetchImpl: (async () => imageResponse(PNG_BYTES)) as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: 'blocked_address' });
  });

  it('DNS 解析到链路本地/元数据地址 ⇒ blocked_address', async () => {
    const res = await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: async () => ['169.254.169.254'],
    });
    expect(res).toEqual({ ok: false, error: 'blocked_address' });
  });

  it('非 http/https 协议 ⇒ blocked_scheme', async () => {
    const res = await fetchImageAsDataUrl('file:///C:/secret.png', {
      resolveHost: PUBLIC_RESOLVER,
    });
    expect(res).toEqual({ ok: false, error: 'blocked_scheme' });
  });

  it('localhost ⇒ blocked_host', async () => {
    const res = await fetchImageAsDataUrl('http://localhost/a.png', {
      resolveHost: PUBLIC_RESOLVER,
    });
    expect(res).toEqual({ ok: false, error: 'blocked_host' });
  });

  it('非 80/443 端口 ⇒ blocked_port', async () => {
    const res = await fetchImageAsDataUrl('http://example.com:8080/a.png', {
      resolveHost: PUBLIC_RESOLVER,
    });
    expect(res).toEqual({ ok: false, error: 'blocked_port' });
  });
});

describe('image-proxy 内容校验', () => {
  it('非 image/* Content-Type ⇒ not_image', async () => {
    const res = await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async () =>
        new Response('<html>反爬</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })) as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: 'not_image:text/html' });
  });

  it('声明 image/* 但魔数不符 ⇒ invalid_image', async () => {
    const res = await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async () =>
        imageResponse(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))) as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: 'invalid_image' });
  });

  it('Content-Length 超 8 MiB ⇒ too_large', async () => {
    const res = await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async () =>
        new Response(PNG_BYTES as unknown as BodyInit, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(9 * 1024 * 1024),
          },
        })) as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: 'too_large' });
  });

  it('HTTP 404 ⇒ http_status:404', async () => {
    const res = await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async () =>
        new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: 'http_status:404' });
  });
});

describe('image-proxy 抓取与编码', () => {
  it('成功：PNG 转成 data URL 并回报类型/字节数', async () => {
    const res = await fetchImageAsDataUrl('https://example.com/poster.png', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async () => imageResponse(PNG_BYTES, 'image/png')) as typeof fetch,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.contentType).toBe('image/png');
    expect(res.bytes).toBe(PNG_BYTES.byteLength);
    expect(res.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('豆瓣图床自动补 Referer 与桌面 UA', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const res = await fetchImageAsDataUrl(
      'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p480747492.jpg',
      {
        resolveHost: PUBLIC_RESOLVER,
        fetchImpl: (async (_input: unknown, init?: RequestInit) => {
          seenHeaders = init?.headers as Record<string, string>;
          return imageResponse(JPEG_BYTES, 'image/jpeg');
        }) as typeof fetch,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.contentType).toBe('image/jpeg');
    expect(seenHeaders?.Referer).toBe('https://movie.douban.com/');
    expect(seenHeaders?.['User-Agent']).toContain('Chrome');
  });

  it('非豆瓣图源不补 Referer', async () => {
    let seenHeaders: Record<string, string> | undefined;
    await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        seenHeaders = init?.headers as Record<string, string>;
        return imageResponse(PNG_BYTES);
      }) as typeof fetch,
    });
    expect(seenHeaders?.Referer).toBeUndefined();
  });

  it('重定向到私网地址 ⇒ blocked_address，不跟随', async () => {
    let calls = 0;
    const res = await fetchImageAsDataUrl('https://example.com/a.png', {
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/secret.png' },
        });
      }) as typeof fetch,
    });
    expect(res).toEqual({ ok: false, error: 'blocked_address' });
    expect(calls).toBe(1);
  });
});
