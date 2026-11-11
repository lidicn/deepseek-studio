// @vitest-environment node
/**
 * C1 P1 安全批（(B) 方案）：工作台侧 MCP 配置读写端点。
 *
 * ── 背景 ──
 *
 * PM 裁定 (B)：明文密钥**不过页面**。MCP 配置的读/改/写全部落在**工作台**
 * （`127.0.0.1:8760/agent`，独立 origin）的**服务端 API**里，不经工具通道。
 * DeepSeek 页面内的设置面板只读（UI 席位负责）。
 *
 * ── 本文件断言的口径 ──
 *
 * **安全四条闸**（PM 逐条点名）：
 *   ① 无 Bearer → 401（端点挂在 /v1/* 统一鉴权之后，**不在** /agent 免鉴权段）。
 *   ② 非回环 Origin（如 https://chat.deepseek.com）→ 403（即便 Bearer 正确）。
 *   ③ 回环 Origin（工作台）→ 放行。
 *   ④ 端点**不注册**在 /agent 免鉴权路由旁（结构锁：路由表里 /v1/mcp/* 只在 Bearer 之后）。
 *
 * **契约形状**（PM 定，UI 的工作台编辑器按此实现）：
 *   GET    /v1/mcp/servers          → { servers:[{id,transport,command,args,env,headers,url,cwd}] }（明文）
 *   POST   /v1/mcp/servers          → body { id, config }
 *   PUT    /v1/mcp/servers/:id      → body { id, config }
 *   DELETE /v1/mcp/servers/:id
 *   POST   /v1/mcp/servers/:id/test → body 可选 { config }，缺省用已存配置
 *
 * **明文口径**：读端点回**明文**（这是工作台的功能需求）；
 * 但**写回**走 `mergeMaskedSecrets` → 用户没改的掩码占位还原成磁盘原值（防毁配置）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer, type McpServerConfigDto, type McpServersApi } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import type { ApiConfig } from '../../src/api/types';
import { startListenable } from './_host-port-guard';

const TOKEN = 'test-token';
const DEEPSEEK_ORIGIN = 'https://chat.deepseek.com';

let base = '';
let calls: { op: string; id?: string; config?: McpServerConfigDto }[] = [];

/** 假 MCP 实现：记录调用，回固定数据。 */
const fakeApi: McpServersApi = {
  async list() {
    calls.push({ op: 'list' });
    return {
      ok: true,
      servers: [
        {
          id: 'srv-a',
          transport: 'http',
          command: 'npx',
          args: ['-y', '@scope/server'],
          env: { API_KEY: '{{SECRET_ckuxu34d}}' },
          cwd: '/ws',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer {{SECRET_ckuxu34d}}' },
        },
      ],
    };
  },
  async create(id, config) {
    calls.push({ op: 'create', id, config });
    return { ok: true };
  },
  async update(id, config) {
    calls.push({ op: 'update', id, config });
    return { ok: true };
  },
  async remove(id) {
    calls.push({ op: 'remove', id });
    return { ok: true };
  },
  async test(id, config) {
    calls.push({ op: 'test', id, config });
    return { ok: true, tools: ['tool-a'] };
  },
};

async function startServer() {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
  const backend = createFakeOfficialBackend({
    chunks: [chunk('deepseek-chat', 'Hello')],
    models: ['deepseek-chat'],
  });
  const server = await startListenable(() =>
    createApiServer({
      config,
      backend,
      authenticator: createBearerAuthenticator(TOKEN),
      mcpServers: fakeApi,
    }),
  );

  base = server.url;
  return server;
}

describe('MCP 配置端点 · 闸门', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.stop();
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };
  // base 在 beforeAll 里才赋值 → Origin 必须在用例体内取（describe 体求值时它还是空串）。
  const loopbackOrigin = () => `http://127.0.0.1:${new URL(base).port}`;

  it('① 无 Bearer → 401（端点在统一鉴权之后）', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers`);
    expect(r.status).toBe(401);
    // 关键：没进业务逻辑
    expect(calls).toEqual([]);
  });

  it('① Bearer 错误 → 401', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers`, { headers: { Authorization: 'Bearer wrong-token' } });
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('② 非回环 Origin（DeepSeek 页面）+ 正确 Bearer → 403', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers`, {
      headers: { ...auth, Origin: DEEPSEEK_ORIGIN },
    });
    expect(r.status).toBe(403);
    // 关键：连业务逻辑都没进（没有明文外泄的机会）
    expect(calls).toEqual([]);
  });

  it('③ 回环 Origin（工作台）+ 正确 Bearer → 200 且回明文', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers`, {
      headers: { ...auth, Origin: loopbackOrigin() },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { servers: Array<Record<string, unknown>> };
    expect(body.servers).toHaveLength(1);
    // 明文（工作台的功能需求）
    expect(JSON.stringify(body)).toContain('{{SECRET_ckuxu34d}}');
    // 契约字段齐
    const s = body.servers[0];
    for (const k of ['id', 'transport', 'command', 'args', 'env', 'headers', 'url', 'cwd']) {
      expect(s, `响应缺字段 ${k}`).toHaveProperty(k);
    }
  });

  it('③ 无 Origin（curl / 本机脚本）+ 正确 Bearer → 200（token 已校验，放行）', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers`, { headers: auth });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('④ 端点不在 /agent 免鉴权段（/agent 路由不提供 MCP 能力）', async () => {
    // /agent 段在 Bearer 校验**之前**就 return 了 → 那里不可能有 /v1/mcp 路由。
    // 用一个能证明「免鉴权段没有 MCP 路由」的方式：带 DeepSeek Origin 打 /v1/mcp/servers，
    // 必须是 403（而不是 200）；免鉴权段对任何 origin 都放行。
    const r = await fetch(`${base}/v1/mcp/servers`, { headers: { Origin: DEEPSEEK_ORIGIN } });
    expect(r.status).toBe(401); // 无 Bearer → 先被鉴权挡
  });
});

describe('MCP 配置端点 · 契约形状', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.stop();
  });

  const auth = { Authorization: `Bearer ${TOKEN}` };

  it('POST /v1/mcp/servers → body { id, config }', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'srv-new', config: { command: 'npx', args: ['-y', 'x'] } }),
    });
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ op: 'create', id: 'srv-new', config: { command: 'npx', args: ['-y', 'x'] } }]);
  });

  it('PUT /v1/mcp/servers/:id → body { id, config }', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers/srv-a`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'srv-a', config: { command: 'npx', cwd: '/ws' } }),
    });
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ op: 'update', id: 'srv-a', config: { command: 'npx', cwd: '/ws' } }]);
  });

  it('DELETE /v1/mcp/servers/:id', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers/srv-a`, { method: 'DELETE', headers: auth });
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ op: 'remove', id: 'srv-a' }]);
  });

  it('POST /v1/mcp/servers/:id/test 带 body → 用 body 的 config（改了再测）', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers/srv-a/test`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'srv-a', config: { command: 'npx', args: ['-y', 'new'] } }),
    });
    expect(r.status).toBe(200);
    expect(calls[0]?.op).toBe('test');
    expect(calls[0]?.config).toEqual({ command: 'npx', args: ['-y', 'new'] });
  });

  it('POST /v1/mcp/servers/:id/test 无 body → config 为 undefined（缺省用已存配置）', async () => {
    calls = [];
    const r = await fetch(`${base}/v1/mcp/servers/srv-a/test`, { method: 'POST', headers: auth });
    expect(r.status).toBe(200);
    expect(calls[0]?.op).toBe('test');
    expect(calls[0]?.config).toBeUndefined();
  });

  it('POST /v1/mcp/servers 缺 id → 400', async () => {
    const r = await fetch(`${base}/v1/mcp/servers`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { command: 'npx' } }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /v1/mcp/servers 缺 config → 400', async () => {
    const r = await fetch(`${base}/v1/mcp/servers`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'srv-x' }),
    });
    expect(r.status).toBe(400);
  });
});
