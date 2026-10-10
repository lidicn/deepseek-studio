import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import type { ApiConfig } from '../../src/api/types';

const TOKEN = 'test-token';
let base = '';

async function startServer() {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
  const backend = createFakeOfficialBackend({
    chunks: [chunk('deepseek-chat', 'Hello'), chunk('deepseek-chat', ' world')],
    models: ['deepseek-chat', 'deepseek-reasoner'],
  });
  const server = createApiServer({ config, backend, authenticator: createBearerAuthenticator(TOKEN) });
  await server.start();
  base = server.url;
  return server;
}

describe('local HTTP API', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.stop();
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };

  it('healthz 免鉴权', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
  });

  it('WS 通道 PNA 预检：DeepSeek 聊天页 origin 得到 204 + Allow-Private-Network', async () => {
    const r = await fetch(`${base}/studio`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chat.deepseek.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-private-network')).toBe('true');
    expect(r.headers.get('access-control-allow-origin')).toBe('https://chat.deepseek.com');
  });

  it('WS 通道 PNA 预检：本地回环 origin 同样放行（面板）', async () => {
    const r = await fetch(`${base}/agent-ws`, {
      method: 'OPTIONS',
      headers: { Origin: `http://127.0.0.1:${new URL(base).port}`, 'Access-Control-Request-Method': 'GET' },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('WS 通道 PNA 预检：未知公网 origin → 403（不打通任意网站的本机通道）', async () => {
    const r = await fetch(`${base}/studio`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET' },
    });
    expect(r.status).toBe(403);
  });

  it('缺 token → 401', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    });
    expect(r.status).toBe(401);
  });

  it('非流式 chat completions 返回合并内容', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(r.status).toBe(200);
    const json = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0].message.content).toBe('Hello world');
  });

  it('流式 chat completions 返回 SSE 且以 [DONE] 结束', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const text = await r.text();
    expect(text).toContain('data:');
    expect(text).toContain('[DONE]');
  });

  it('GET /v1/models 返回模型列表', async () => {
    const r = await fetch(`${base}/v1/models`, { headers: auth });
    const json = (await r.json()) as { data: Array<{ id: string }> };
    expect(json.data.map((d) => d.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('GET /v1/queue/status 返回队列状态', async () => {
    const r = await fetch(`${base}/v1/queue/status`, { headers: auth });
    const json = (await r.json()) as { queued: number; active: number };
    expect(typeof json.queued).toBe('number');
    expect(typeof json.active).toBe('number');
  });

  it('未实现路由 → 501', async () => {
    const r = await fetch(`${base}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
    expect(r.status).toBe(501);
  });
});
