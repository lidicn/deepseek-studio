import { describe, expect, it } from 'vitest';
import { webFetch, type WebFetchTransport } from '../../src/capabilities/web-fetch';

function transport(routes: Record<string, { status: number; body: string; headers?: Record<string, string> }>): WebFetchTransport {
  return async (url) => {
    const hit = routes[url];
    if (!hit) throw new Error('not found');
    return { url, status: hit.status, body: hit.body, headers: hit.headers };
  };
}

describe('webFetch', () => {
  it('正常抓取：抽取 title 与正文', async () => {
    const t = transport({
      'https://a.test/page': {
        status: 200,
        body: '<html><head><title>Hi</title><style>.x{}</style></head><body><h1>Hello</h1><p>World&nbsp;foo</p><script>bad()</script></body></html>',
      },
    });
    const res = await webFetch({ url: 'https://a.test/page', transport: t });
    expect(res.ok).toBe(true);
    const d = res.data as any;
    expect(d.status).toBe(200);
    expect(d.title).toBe('Hi');
    expect(d.text).toContain('Hello');
    expect(d.text).toContain('World foo');
    expect(d.text).not.toContain('bad()');
    expect(d.text).not.toContain('.x');
  });

  it('缺 url → missing-argument', async () => {
    // @ts-expect-error 故意缺参
    const res = await webFetch({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('missing-argument');
  });

  it('非法/非 http(s) URL → invalid-argument', async () => {
    expect((await webFetch({ url: 'ftp://x.test', transport: async () => ({ url: 'ftp://x.test', status: 200, body: '' }) })).error).toBe('invalid-argument');
    expect((await webFetch({ url: 'not a url', transport: async () => ({ url: 'not a url', status: 200, body: '' }) })).error).toBe('invalid-argument');
  });

  it('无注入 transport → io-error（fail-closed，不真连）', async () => {
    const res = await webFetch({ url: 'https://a.test' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('io-error');
  });

  it('超时 → 不崩，返回 io-error', async () => {
    const slow: WebFetchTransport = () => new Promise((r) => setTimeout(() => r({ url: 'https://a.test', status: 200, body: 'x' }), 50));
    const res = await webFetch({ url: 'https://a.test', transport: slow, timeoutMs: 10 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('io-error');
  });

  it('正文超 maxBytes → limit-exceeded', async () => {
    const t = transport({ 'https://a.test': { status: 200, body: 'x'.repeat(5000) } });
    const res = await webFetch({ url: 'https://a.test', transport: t, maxBytes: 100 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('limit-exceeded');
  });

  it('循环/超上限重定向 → limit-exceeded 不崩', async () => {
    // A -> B -> A 循环，maxRedirects=1 时应在二次跳转时超限
    const loop: WebFetchTransport = async (url) => {
      if (url === 'https://a.test/a') return { status: 302, body: '', headers: { location: '/b' }, url };
      return { status: 302, body: '', headers: { location: '/a' }, url };
    };
    const res = await webFetch({ url: 'https://a.test/a', transport: loop, maxRedirects: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('limit-exceeded');
  });

  it('正常重定向跟随到最终页', async () => {
    const chain: WebFetchTransport = async (url) => {
      if (url === 'https://a.test/a') return { status: 301, body: '', headers: { location: 'https://a.test/b' }, url };
      return { status: 200, body: '<title>Final</title><p>done</p>', url };
    };
    const res = await webFetch({ url: 'https://a.test/a', transport: chain, maxRedirects: 3 });
    expect(res.ok).toBe(true);
    expect((res.data as any).title).toBe('Final');
  });
});
