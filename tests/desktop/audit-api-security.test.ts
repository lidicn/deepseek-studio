/**
 * 审计修复回归：R1-01（debug/eval 鉴权）、R1-06（并发拒绝如实计数）、R1-04（SSE 客户端断开中止上游）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApiServer } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import type { ApiConfig } from '../../src/api/types';
import type { OfficialBackend } from '../../src/api/official-backend';

const TOKEN = 'audit-token';
let base = '';

async function startServer(backend: OfficialBackend) {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
  const server = createApiServer({ config, backend, authenticator: createBearerAuthenticator(TOKEN) });
  await server.start();
  base = server.url;
  return server;
}

describe('R1-01 /v1/debug/eval 必须鉴权', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer(createFakeOfficialBackend({ chunks: [chunk('m', 'hi')] }));
  });
  afterAll(async () => { await server.stop(); });

  it('不带 Authorization → 401（不再豁免）', async () => {
    const r = await fetch(`${base}/v1/debug/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '1+1' }),
    });
    expect(r.status).toBe(401);
  });

  it('带正确 Bearer 但未开 STUDIO_DEBUG → 501（默认关闭，不常驻任意 JS 执行面）', async () => {
    const r = await fetch(`${base}/v1/debug/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ code: '1+1' }),
    });
    expect(r.status).toBe(501);
  });
});

describe('R1-06 并发拒绝如实计入 rejectedByConcurrency', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    const slow: OfficialBackend = {
      async *chatCompletion() {
        await new Promise((r) => setTimeout(r, 400));
        yield chunk('m', 'ok');
      },
      async models() { return ['m']; },
    };
    server = await startServer(slow);
  });
  afterAll(async () => { await server.stop(); });

  it('超限请求 429，queue/status 报告 rejectedByConcurrency≥1', async () => {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    const [a, b] = await Promise.all([
      fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body }),
      fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 429]);
    const s = await (await fetch(`${base}/v1/queue/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { rejectedByConcurrency: number };
    expect(s.rejectedByConcurrency).toBeGreaterThanOrEqual(1);
  });
});

describe('R1-04 SSE 客户端断开 → 中止上游', () => {
  it('客户端 abort 触发上游 AbortSignal（不再白耗配额、空占并发位）', async () => {
    const aborted = { v: false };
    const backend: OfficialBackend = {
      async *chatCompletion(_req, signal) {
        // 轮询观察 aborted（测试探针）：覆盖 abort 事件早于监听器注册的竞态，
        // 生产上游客户端以自身 signal 订阅为准。
        await new Promise<void>((res) => {
          if (signal?.aborted) { aborted.v = true; res(); return; }
          const t = setTimeout(res, 3000);
          signal?.addEventListener('abort', () => { clearTimeout(t); aborted.v = true; res(); });
          const poll = setInterval(() => {
            if (signal?.aborted) { clearInterval(poll); clearTimeout(t); aborted.v = true; res(); }
          }, 20);
        });
        yield chunk('m', 'never');
      },
      async models() { return ['m']; },
    };
    const server = await startServer(backend);
    try {
      // 用原生 http 客户端，发出请求并稳定连接后主动 destroy，模拟「客户端中途断开」。
      await new Promise<void>((resolve) => {
        const u = new URL(`${base}/v1/chat/completions`);
        const req = http.request({
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        }, (res) => { res.resume(); });
        req.on('error', () => resolve());
        req.end(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }));
        setTimeout(() => { req.destroy(); resolve(); }, 200);
      });
      await new Promise((res) => setTimeout(res, 500));
      expect(aborted.v).toBe(true);
    } finally {
      await server.stop();
    }
  }, 8000);
});
