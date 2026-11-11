/**
 * 组 C · api/server.ts 加固（4 条，P2）
 *
 * 验收口径：`docs/Audit/20261103-组A组C验收口径草案.md`「组 C」部分。
 *   C-1 TD-10（=BUG-023） /v1/tools/execute 的 params 零校验 → 形态校验（plain object + 1MB）
 *   C-2 TD-12      限流桶只增不删 → size 有界
 *   C-3 TD-13（=BUG-025） limit 空串被 clamp 成 1 → 统一 parseLimit
 *   C-4 BUG-024    readBody 超限只 reject 不 destroy → 连接悬挂
 *
 * 纪律：断言一律打**真实 HTTP 入口**（起真 server），每条配负控（修法删掉必红）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApiServer, type ApiServer } from '../../src/api/server';
import { createBearerAuthenticator } from '../../src/api/auth';
import { createFakeOfficialBackend, chunk } from '../../src/api/official-backend';
import type { ApiConfig } from '../../src/api/types';
import { startListenable } from './_host-port-guard';

const TOKEN = 'c1p2-token';

let activeServer: ApiServer | null = null;

afterEach(async () => {
  await activeServer?.stop();
  activeServer = null;
});

async function startServer(opts: {
  tokens?: string[];
  rateLimit?: { capacity?: number; refillPerMinute?: number; maxKeys?: number };
  toolExecutor?: (tool: string, params: unknown, ctx: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  auditReader?: (limit?: number) => readonly unknown[];
  automationLogs?: (taskId?: string, limit?: number) => unknown[];
} = {}): Promise<{ base: string; port: number; server: ApiServer }> {
  const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
  const backend = createFakeOfficialBackend({
    chunks: [chunk('deepseek-chat', 'Hello')],
    models: ['deepseek-chat'],
  });
  const server = await startListenable(() =>
    createApiServer({
    config,
    backend,
    authenticator: createBearerAuthenticator(
      opts.tokens ? () => opts.tokens! : TOKEN,
    ),
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.toolExecutor ? { toolExecutor: opts.toolExecutor } : {}),
    ...(opts.auditReader ? { auditReader: opts.auditReader as never } : {}),
    ...(opts.automationLogs
      ? {
        automationManager: {
          list: () => [],
          get: () => undefined,
          create: () => ({}),
          update: () => undefined,
          remove: () => false,
          toggle: () => undefined,
          runNow: async () => undefined,
          logs: (taskId?: string, limit?: number) => opts.automationLogs!(taskId, limit),
          start: () => { /* noop */ },
          stop: () => { /* noop */ },
        },
      }
      : {}),
    }),
  );

  activeServer = server;
  const url = new URL(server.url);
  return { base: server.url, port: Number(url.port), server };
}

function postJson(base: string, path: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('组 C · C-1 TD-10 · /v1/tools/execute 的 params 形态校验', () => {
  it('params 不是 plain object（null / 数组 / 字符串 / 数字）→ 400，且不进 toolExecutor', async () => {
    const calls: unknown[] = [];
    const { base } = await startServer({
      toolExecutor: async (tool, params) => {
        calls.push({ tool, params });
        return { ok: true };
      },
    });
    for (const bad of [null, [], 'str', 42]) {
      const r = await postJson(base, '/v1/tools/execute', { tool: 'x', params: bad });
      expect(r.status, `params=${JSON.stringify(bad)} 应 400`).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  // 负控：合法 object 仍然放行且**原样送达** → 证明上面不是一刀切拒。
  it('负控：合法 object 仍然 200，参数原样送达 toolExecutor', async () => {
    const calls: unknown[] = [];
    const { base } = await startServer({
      toolExecutor: async (tool, params) => {
        calls.push({ tool, params });
        return { ok: true };
      },
    });
    const r = await postJson(base, '/v1/tools/execute', { tool: 'x', params: { a: 1, b: 'z' } });
    expect(r.status).toBe(200);
    expect(calls).toEqual([{ tool: 'x', params: { a: 1, b: 'z' } }]);
  });

  it('params 超过 1MB → 400/413，且不进 toolExecutor', async () => {
    const calls: unknown[] = [];
    const { base } = await startServer({
      toolExecutor: async (tool, params) => {
        calls.push({ tool, params });
        return { ok: true };
      },
    });
    const r = await postJson(base, '/v1/tools/execute', {
      tool: 'x',
      params: { blob: 'a'.repeat(1024 * 1024 + 64) },
    });
    expect([400, 413]).toContain(r.status);
    expect(calls).toHaveLength(0);
  });
});

describe('组 C · C-2 TD-12 · 限流桶回收（size 有界）', () => {
  it('桶数超上限后老 key 被回收 → 它重新拿到满桶（修复前这里仍是 429）', async () => {
    // capacity=1 / 不补充 → 每个 key 的桶用一次就空；
    // maxKeys=1 → 出现第二个 key 时第一个必须被挤掉（桶数有界）。
    const { base } = await startServer({
      tokens: ['A', 'B'],
      rateLimit: { capacity: 1, refillPerMinute: 0, maxKeys: 1 },
    });
    const hit = (token: string) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    });

    expect((await hit('A')).status).toBe(200);
    expect((await hit('A')).status).toBe(429);   // A 的桶空了
    expect((await hit('B')).status).toBe(200);   // 新 key → 桶数超上限 → A 被回收
    expect((await hit('A')).status).toBe(200);   // 修复前：429（A 的空桶还在）
  });

  // 负控：桶**没**被回收时，同 key 第二次必然 429 → 证明上面第 4 步的 200 来自回收。
  it('负控：桶没被回收时同 key 第二次是 429', async () => {
    const { base } = await startServer({
      tokens: ['A'],
      rateLimit: { capacity: 1, refillPerMinute: 0, maxKeys: 100 },
    });
    const hit = (token: string) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    });
    expect((await hit('A')).status).toBe(200);
    expect((await hit('A')).status).toBe(429);
  });
});

describe('组 C · C-3 TD-13 · limit 解析统一', () => {
  const cases: Array<[string, number]> = [
    ['', 50],
    ['abc', 50],
    ['0', 1],
    ['99999', 500],
    ['25', 25],
  ];

  it('audit 端点：空串/非数字 → 缺省 50；0 → 1；超上限 → 500；正常值原样', async () => {
    const seen: number[] = [];
    const { base } = await startServer({
      auditReader: (limit) => {
        seen.push(limit ?? -1);
        return [];
      },
    });
    for (const [raw, expected] of cases) {
      const r = await fetch(`${base}/v1/tools/audit?limit=${raw}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(r.status).toBe(200);
      expect(seen.at(-1), `?limit=${raw}`).toBe(expected);
    }
  });

  it('automation logs 端点：同一组口径', async () => {
    const seen: number[] = [];
    const { base } = await startServer({
      automationLogs: (_taskId, limit) => {
        seen.push(limit ?? -1);
        return [];
      },
    });
    for (const [raw, expected] of cases) {
      const r = await fetch(`${base}/v1/automation/logs?limit=${raw}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(r.status).toBe(200);
      expect(seen.at(-1), `?limit=${raw}`).toBe(expected);
    }
  });

  // 负控：正常值必须是 25（不是固定 50）→ 证明解析确实按输入走。
  it('负控：?limit=25 → 25（不是固定缺省）', async () => {
    const seen: number[] = [];
    const { base } = await startServer({
      auditReader: (limit) => {
        seen.push(limit ?? -1);
        return [];
      },
    });
    await fetch(`${base}/v1/tools/audit?limit=25`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(seen.at(-1)).toBe(25);
  });
});

describe('组 C · C-4 BUG-024 · readBody 超限必须 destroy 连接', () => {
  it('POST 超过 10MB → 服务端提前关闭连接（客户端拿不到正常响应）', async () => {
    // 必须配 toolExecutor：否则路由在读 body **之前**就回了 501（那不是超限分支）。
    const { port, server } = await startServer({ toolExecutor: async () => ({ ok: true }) });
    // 服务端视角：被服务端**自己** destroy 掉的请求（区分力在这里 ——
    // 客户端视角两态都像"提前断了"：修复前服务端也会回 500 再关连接，
    // 但 RST 会把缓冲里的 500 一起丢掉，客户端只看得到 ECONNRESET）。
    let capturedReq: http.IncomingMessage | undefined;
    let capturedRes: http.ServerResponse | undefined;
    server.rawServer.on('request', (r: http.IncomingMessage, s: http.ServerResponse) => { capturedReq = r; capturedRes = s; });
    const total = 11 * 1024 * 1024;
    const state = { responded: false, status: 0, error: '', errorAtMs: 0, wroteMB: 0 };
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/tools/execute',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          'Content-Length': String(total),
        },
      }, (res) => {
        state.responded = true;
        state.status = res.statusCode ?? 0;
        res.resume();
      });
      req.on('error', (e) => {
        state.error = e.message;
        state.errorAtMs = Date.now() - t0;
      });
      const chunkBuf = Buffer.alloc(1024 * 1024, 0x61);
      let written = 0;
      const pump = () => {
        while (written < total) {
          written += 1;
          state.wroteMB = written;
          if (!req.write(chunkBuf)) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
      // 收集 3 秒：两种结局（提前断连 / 回一个正常响应）都要能观察到，不能一见 error 就收。
      setTimeout(resolve, 3000);
    });

    // 修复前：服务端只是 reject → 仍会回一个 400/500 响应 → responded=true。
    // 修复后：服务端 destroy → 连接被提前关闭 → 客户端拿不到正常响应，且断得早。
    expect(state.responded, JSON.stringify(state)).toBe(false);
    expect(state.error, JSON.stringify(state)).not.toBe('');
    expect(state.errorAtMs, JSON.stringify(state)).toBeLessThan(2000);
    // 区分力断言：请求必须被服务端**主动 destroy**（修复前只是 reject，连接由客户端那边断）。
    expect(capturedReq?.destroyed, JSON.stringify(state)).toBe(true);
    // 区分力断言 2：连接已被 destroy → 服务端**不得再补发响应**（修复前会写一个 500）。
    expect(capturedRes?.headersSent, JSON.stringify(state)).toBe(false);
  });
  // 负控：正常大小 body 仍然正常响应 → 证明 destroy 只在超限分支。
  it('负控：正常大小 body 仍然拿到 200 响应', async () => {
    const { base } = await startServer({
      toolExecutor: async () => ({ ok: true }),
    });
    const r = await postJson(base, '/v1/tools/execute', { tool: 'x', params: { a: 1 } });
    expect(r.status).toBe(200);
  });
});
