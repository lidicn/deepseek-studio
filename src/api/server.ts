/**
 * 本地 HTTP API server（node:http）
 *
 * 端点：
 *   POST /v1/chat/completions   OpenAI 兼容；stream=true 走 SSE（reasoning 仅在 reasoning_content）
 *   GET  /v1/models             模型列表
 *   GET  /healthz               健康检查（免鉴权）
 *   GET  /v1/queue/status       队列状态
 * 其余 /v1/* 未实现 → 501
 * 鉴权缺失/错误 → 401（fail-closed）
 */

import http from 'node:http';
import type { Server } from 'node:http';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createBearerAuthenticator, type Authenticator } from './auth';

/** 工具执行委托：宿主把已鉴权的工具调用转交 desktop-host 执行（含同意闸门与页端路由）。 */
export type ToolExecutor = (
  tool: string,
  params: unknown,
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
import type { OfficialBackend } from './official-backend';
import { chunksToResponse, emptyDelta, formatSSE, isUnimplementedPath, SSE_DONE } from './compat';
import { DEEPSEEK_ORIGIN } from '../host/tool-definitions';
import type { ApiConfig, ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse, QueueStatus } from './types';

/** 审计条目（结构化最小视图，避免 api 层反向依赖 host 内部类型）。 */
export interface AuditEntry {
  id: string;
  at: number;
  tool: string;
  outcome: string;
  ok: boolean;
  reason?: string;
  mode?: string;
  durationMs?: number;
  summary?: string;
}

export type AuditReader = (limit?: number) => readonly AuditEntry[];

/** 限流与并发配置（v0.5 5.2）。 */
export interface RateLimitOptions {
  /** 令牌桶容量（默认 60）。 */
  capacity?: number;
  /** 每分钟补充的令牌数（默认 60）。 */
  refillPerMinute?: number;
  /** 最大并发执行数，默认 1（串行，防上游风控）。 */
  maxConcurrent?: number;
}

export interface ApiServerOptions {
  config: ApiConfig;
  backend: OfficialBackend;
  authenticator?: Authenticator;
  /** 工具执行委托（可选）；提供后开放 POST /v1/tools/execute。 */
  toolExecutor?: ToolExecutor;
  /** 审计读取（可选）；提供后开放 GET /v1/tools/audit。 */
  auditReader?: AuditReader;
  /** v0.9：工具目录读取；提供后开放 GET /v1/tools/catalog。 */
  toolCatalog?: () => unknown[];
  /** v0.9：外部 agent 控制链；提供后开放 POST /v1/agent/send（发消息到页面并等待最终回答）。 */
  agentSender?: (text: string) => Promise<string>;
  /** v0.12：自动化调度管理器；提供后开放 /v1/automation/* 端点。 */
  automationManager?: {
    list: () => unknown[];
    get: (id: string) => unknown | undefined;
    create: (input: unknown) => unknown;
    update: (id: string, patch: unknown) => unknown | undefined;
    remove: (id: string) => boolean;
    toggle: (id: string, enabled: boolean) => unknown | undefined;
    runNow: (id: string) => Promise<unknown | undefined>;
    logs: (taskId?: string, limit?: number) => unknown[];
    start: () => void;
    stop: () => void;
  };
  /** 调试：向网页发 JS 并等结果。 */
  debugEval?: (code: string) => Promise<{ ok: boolean; result?: string; error?: string }>;
  /** 限流与并发（默认串行 + 60/分钟）。 */
  rateLimit?: RateLimitOptions;
  /**
   * M1 智能体面板静态资源（磁盘路径）。提供后开放：
   *   GET /agent    面板 HTML（服务端把 __STUDIO_TOKEN__ 占位符替换为真实 API 令牌）
   *   GET /agent.js 面板脚本
   * 两个路由**免鉴权**：HTML 里已内嵌令牌，威胁模型与 v0.5 一致（本地进程本就能读 config.json）。
   */
  agentPage?: { htmlPath: string; jsPath: string; cssPath: string };
}

export interface ApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  /** 底层 node:http server，供宿主挂载 ws 通道（页端运行时）。 */
  readonly rawServer: Server;
}

/** 本地回环 origin 白名单（v0.5 5.5：CORS fail-closed）。 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * WS 通道路径。这些路径要接受浏览器「专用网络访问（PNA）」预检：
 * 公网页面（chat.deepseek.com，https）连接本机 ws://127.0.0.1 属于
 * public→local 请求，Chromium（WebView2 ≥122）会先发 OPTIONS 预检并要求
 * 服务端显式回应 Access-Control-Allow-Private-Network: true，否则 WS 握手被
 * 静默拦截（页端表现为所有工具调用 no-host）。
 */
const WS_PREFLIGHT_PATHS: ReadonlySet<string> = new Set(['/studio', '/agent-ws']);

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTS.has(u.hostname) || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * 写 CORS 头。非本地 origin **不写** Allow-Origin（fail-closed）：
 * 宁可让浏览器判定跨域失败，也不给外部站点一个可用凭据的通道。
 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (!isLocalOrigin(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin as string);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

/** 令牌桶：每令牌（按 Bearer 值）独立限流。 */
function createRateLimiter(opts: RateLimitOptions = {}) {
  const capacity = opts.capacity ?? 60;
  const refillPerMinute = opts.refillPerMinute ?? 60;
  const buckets = new Map<string, { tokens: number; last: number }>();

  return {
    /** 取一个令牌；不足时返回需要等待的毫秒数。 */
    take(key: string): { ok: boolean; retryAfterMs: number } {
      const now = Date.now();
      const b = buckets.get(key) ?? { tokens: capacity, last: now };
      const refill = ((now - b.last) / 60_000) * refillPerMinute;
      const tokens = Math.min(capacity, b.tokens + refill);
      if (tokens < 1) {
        buckets.set(key, { tokens, last: now });
        const need = (1 - tokens) / refillPerMinute;
        return { ok: false, retryAfterMs: Math.max(50, Math.ceil(need * 60_000)) };
      }
      buckets.set(key, { tokens: tokens - 1, last: now });
      return { ok: true, retryAfterMs: 0 };
    },
  };
}

/** 最近执行记录，用于 /v1/queue/status 的可观测性（v0.5 5.3）。 */
const RECENT_LIMIT = 20;

export function createApiServer(options: ApiServerOptions): ApiServer {
  const auth = options.authenticator ?? createBearerAuthenticator(options.config.token);
  const limiter = createRateLimiter(options.rateLimit ?? {});
  const maxConcurrent = options.rateLimit?.maxConcurrent ?? 1; // 默认串行

  let active = 0;
  let queued = 0;
  type RecentEntry = { startedAt: number; endedAt?: number; ok?: boolean; waitMs: number };
  const recent: RecentEntry[] = [];

  // 返回对象引用而非索引：数组到达上限时会 shift，索引会错位，引用则始终有效。
  const pushRecent = (rec: { startedAt: number; waitMs: number }): RecentEntry => {
    const entry: RecentEntry = { ...rec };
    recent.push(entry);
    if (recent.length > RECENT_LIMIT) recent.shift();
    return entry;
  };
  const finishRecent = (entry: RecentEntry | undefined, ok: boolean): void => {
    if (!entry) return;
    entry.endedAt = Date.now();
    entry.ok = ok;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${options.config.host}`);
    const pathname = url.pathname;

    const sendJson = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // 5.5 CORS 严格化：只给本地回环源写放行头，其余一律不写（浏览器自会判跨域失败）
    applyCors(req, res);

    // WS 通道 PNA 预检：只放行 DeepSeek 聊天页与本地回环两种 origin。
    // 注意不能放开为 *——否则任意公网网页都能预检通过并连接本机工具通道。
    if (req.method === 'OPTIONS' && WS_PREFLIGHT_PATHS.has(pathname)) {
      const origin = req.headers.origin;
      if (origin && (origin === DEEPSEEK_ORIGIN || isLocalOrigin(origin))) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      sendJson(403, { error: { code: 'origin_not_allowed', message: 'preflight origin not allowed' } });
      return;
    }

    if (req.method === 'OPTIONS') {
      if (!isLocalOrigin(req.headers.origin)) {
        sendJson(403, { error: { code: 'origin_not_allowed', message: 'only localhost origins are allowed' } });
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (pathname === '/healthz') {
        sendJson(200, { ok: true });
        return;
      }

      // —— M1 智能体面板静态路由（免鉴权，页面内嵌令牌）——
      if (
        options.agentPage &&
        req.method === 'GET' &&
        (pathname === '/agent' || pathname === '/agent.js' || pathname === '/agent.css')
      ) {
        try {
          if (pathname === '/agent') {
            // 只替换带引号的字面量占位符（replaceAll 防止多实例遗漏）；
            // JSON.stringify 处理令牌中的特殊字符，保证生成的 JS 字面量合法。
            const html = readFileSync(options.agentPage.htmlPath, 'utf8').replace(
              /"__STUDIO_API_TOKEN__"/g,
              JSON.stringify(options.config.token),
            );
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(html);
          } else if (pathname === '/agent.css') {
            const css = readFileSync(options.agentPage.cssPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
            res.end(css);
          } else {
            const js = readFileSync(options.agentPage.jsPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(js);
          }
        } catch {
          sendJson(500, { error: { code: 'agent_page_missing', message: 'agent panel assets not built' } });
        }
        return;
      }

      // 调试端点免鉴权（本地回环）
      if (pathname === '/v1/debug/eval') {
        // 跳过鉴权，直接处理
      } else if (!auth.authenticate(req.headers['authorization'])) {
        sendJson(401, { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } });
        return;
      }

      if (pathname === '/v1/models' && req.method === 'GET') {
        const models = await options.backend.models();
        sendJson(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
        return;
      }

      if (pathname === '/v1/queue/status' && req.method === 'GET') {
        // 5.3 可观测性：除了计数，还要能看到「等了多久」——
        // 只有计数的话，卡在排队里的请求和跑得慢的请求在监控上长得一模一样。
        const waits = recent.map((r) => r.waitMs);
        const status: QueueStatus = {
          queued,
          active,
          maxConcurrent,
          depth: queued,
          avgWaitMs: waits.length > 0 ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
          recent: recent.map((r) => ({ startedAt: r.startedAt, endedAt: r.endedAt, ok: r.ok, waitMs: r.waitMs })),
        };
        sendJson(200, status);
        return;
      }

      if (pathname === '/v1/tools/audit' && req.method === 'GET') {
        if (!options.auditReader) {
          sendJson(501, { error: { code: 'not_implemented', message: 'audit reader not configured' } });
          return;
        }
        const raw = url.searchParams.get('limit');
        const parsed = raw === null ? 50 : Number(raw);
        const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(500, Math.floor(parsed))) : 50;
        sendJson(200, { object: 'list', data: options.auditReader(limit) });
        return;
      }

      // v0.9：工具目录（页端/面板展示可用工具）。
      if (pathname === '/v1/tools/catalog' && req.method === 'GET') {
        if (!options.toolCatalog) {
          sendJson(501, { error: { code: 'not_implemented', message: 'tool catalog not configured' } });
          return;
        }
        sendJson(200, { object: 'list', data: options.toolCatalog() });
        return;
      }

      if (pathname === '/v1/tools/execute' && req.method === 'POST') {
        if (!options.toolExecutor) {
          sendJson(501, { error: { code: 'not_implemented', message: 'tool executor not configured' } });
          return;
        }
        const raw = await readBody(req);
        let body: { tool?: unknown; params?: unknown };
        try {
          body = JSON.parse(raw) as { tool?: unknown; params?: unknown };
        } catch {
          sendJson(400, { error: { code: 'bad_request', message: 'invalid json body' } });
          return;
        }
        if (typeof body.tool !== 'string' || body.tool.length === 0) {
          sendJson(400, { error: { code: 'bad_request', message: 'missing tool' } });
          return;
        }
        const result = await options.toolExecutor(body.tool, body.params ?? {});
        sendJson(200, result);
        return;
      }

      // 调试端点：让网页执行 JS
      if (pathname === '/v1/debug/eval' && req.method === 'POST') {
        if (!options.debugEval) {
          sendJson(501, { error: { code: 'not_implemented', message: 'debugEval not configured' } });
          return;
        }
        const raw = await readBody(req);
        let body: { code?: unknown };
        try { body = JSON.parse(raw) as { code?: unknown }; } catch { sendJson(400, { error: { code: 'bad_request' } }); return; }
        if (typeof body.code !== 'string') { sendJson(400, { error: { code: 'missing code' } }); return; }
        const result = await options.debugEval(body.code);
        sendJson(200, result);
        return;
      }

      // v0.9：外部 agent 控制链——发消息到页面并等待最终回答。
      if (pathname === '/v1/agent/send' && req.method === 'POST') {
        if (!options.agentSender) {
          sendJson(501, { error: { code: 'not_implemented', message: 'agent sender not configured' } });
          return;
        }
        const raw = await readBody(req);
        let body: { message?: unknown };
        try {
          body = JSON.parse(raw) as { message?: unknown };
        } catch {
          sendJson(400, { error: { code: 'bad_request', message: 'invalid json body' } });
          return;
        }
        if (typeof body.message !== 'string' || body.message.length === 0) {
          sendJson(400, { error: { code: 'bad_request', message: 'missing message' } });
          return;
        }
        try {
          const answer = await options.agentSender(body.message);
          sendJson(200, { ok: true, answer });
        } catch (e) {
          sendJson(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // v0.12：自动化调度 API
      if (pathname === '/v1/automation/tasks' && req.method === 'GET') {
        if (!options.automationManager) {
          sendJson(501, { error: { code: 'not_implemented', message: 'automation not configured' } });
          return;
        }
        sendJson(200, { object: 'list', data: options.automationManager.list() });
        return;
      }

      if (pathname === '/v1/automation/tasks' && req.method === 'POST') {
        if (!options.automationManager) {
          sendJson(501, { error: { code: 'not_implemented', message: 'automation not configured' } });
          return;
        }
        const raw = await readBody(req);
        try {
          const input = JSON.parse(raw);
          const task = options.automationManager.create(input);
          sendJson(200, { ok: true, task });
        } catch (e) {
          sendJson(400, { error: { code: 'bad_request', message: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }

      if (pathname.startsWith('/v1/automation/tasks/') && req.method === 'GET') {
        if (!options.automationManager) {
          sendJson(501, { error: { code: 'not_implemented', message: 'automation not configured' } });
          return;
        }
        const id = pathname.slice('/v1/automation/tasks/'.length);
        const task = options.automationManager.get(id);
        if (!task) {
          sendJson(404, { error: { code: 'not_found', message: 'task not found' } });
          return;
        }
        sendJson(200, { ok: true, task });
        return;
      }

      if (pathname.startsWith('/v1/automation/tasks/') && req.method === 'PATCH') {
        if (!options.automationManager) {
          sendJson(501, { error: { code: 'not_implemented', message: 'automation not configured' } });
          return;
        }
        const id = pathname.slice('/v1/automation/tasks/'.length);
        const raw = await readBody(req);
        try {
          const patch = JSON.parse(raw);
          const task = options.automationManager.update(id, patch);
          if (!task) {
            sendJson(404, { error: { code: 'not_found', message: 'task not found' } });
            return;
          }
          sendJson(200, { ok: true, task });
        } catch (e) {
          sendJson(400, { error: { code: 'bad_request', message: e instanceof Error ? e.message : String(e) } });
        }
        return;
      }

      if (pathname.startsWith('/v1/automation/tasks/') && req.method === 'DELETE') {
        if (!options.automationManager) {
          sendJson(501, { error: { code: 'not_implemented', message: 'automation not configured' } });
          return;
        }
        const id = pathname.slice('/v1/automation/tasks/'.length);
        const ok = options.automationManager.remove(id);
        sendJson(200, { ok });
        return;
      }

      if (pathname.startsWith('/v1/automation/tasks/') && pathname.endsWith('/run') && req.method === 'POST') {
        if (!options.automationManager) {
          sendJson(501, { error: { code: 'not_implemented', message: 'automation not configured' } });
          return;
        }
        const id = pathname.slice('/v1/automation/tasks/'.length, -'/run'.length);
        try {
          const log = await options.automationManager.runNow(id);
          if (!log) {
            sendJson(404, { error: { code: 'not_found', message: 'task not found' } });
            return;
          }
          sendJson(200, { ok: true, log });
        } catch (e) {
          sendJson(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      if (pathname === '/v1/automation/logs' && req.method === 'GET') {
        if (!options.automationManager) {
          sendJson(501, { error: { code: 'not_implemented', message: 'automation not configured' } });
          return;
        }
        const taskId = url.searchParams.get('taskId') ?? undefined;
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? 50 : Math.max(1, Math.min(500, Number(rawLimit) || 50));
        sendJson(200, { object: 'list', data: options.automationManager.logs(taskId, limit) });
        return;
      }

      if (isUnimplementedPath(pathname)) {
        sendJson(501, { error: { code: 'not_implemented', message: `${pathname} not implemented` } });
        return;
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        // 5.2 限流：按调用方凭据独立令牌桶，超限返回 429 + Retry-After
        const tokenKey = req.headers['authorization'] ?? 'anonymous';
        const rate = limiter.take(tokenKey);
        if (!rate.ok) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
          sendJson(429, {
            error: { code: 'rate_limited', message: `too many requests, retry in ${rate.retryAfterMs}ms` },
          });
          return;
        }
        // 5.2 并发上限：默认串行（maxConcurrent=1），避免高频触发上游风控
        if (active >= maxConcurrent) {
          res.setHeader('Retry-After', '1');
          sendJson(429, {
            error: { code: 'concurrency_limited', message: `at most ${maxConcurrent} concurrent request(s)` },
          });
          return;
        }

        const raw = await readBody(req);
        const request = JSON.parse(raw) as ChatCompletionRequest;
        const enqueuedAt = Date.now();
        queued += 1;
        active += 1;
        const entry = pushRecent({ startedAt: Date.now(), waitMs: 0 });
        entry.waitMs = Date.now() - enqueuedAt;

        // 计数归零必须收敛到这一处：原先内层 finally 与外层 catch 都可能递减，
        // 异常路径下会把 active 扣成负数（监控失真且永久占用并发额度）。
        let released = false;
        const release = (ok: boolean): void => {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
          queued = Math.max(0, queued - 1);
          finishRecent(entry, ok);
        };

        if (request.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          let ok = true;
          try {
            for await (const c of options.backend.chatCompletion(request)) {
              res.write(formatSSE(c));
            }
            res.write(formatSSE(emptyDelta(request.model)));
            res.write(SSE_DONE);
          } catch (err) {
            ok = false;
            res.write(formatSSE(errorChunk(String(err))));
          } finally {
            res.end();
            release(ok);
          }
          return;
        }

        const collected: ChatCompletionChunk[] = [];
        let ok = true;
        try {
          for await (const c of options.backend.chatCompletion(request)) collected.push(c);
        } catch (err) {
          ok = false;
          release(ok);
          sendJson(500, { error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } });
          return;
        }
        release(ok);
        const response: ChatCompletionResponse = chunksToResponse(collected, request);
        sendJson(200, response);
        return;
      }

      sendJson(404, { error: { code: 'not_found', message: `${req.method} ${pathname}` } });
    } catch (err) {
      // 计数由各端点自己的 finally/release 负责，这里不再递减（避免重复扣减）
      sendJson(500, { error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } });
    }
  });

  let resolvedUrl = `http://${options.config.host}:${options.config.port}`;

  return {
    get url() {
      return resolvedUrl;
    },
    get rawServer() {
      return server;
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.config.port, options.config.host, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            resolvedUrl = `http://${options.config.host}:${addr.port}`;
          }
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const READ_BODY_TIMEOUT_MS = 30_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('read body timeout'));
    }, READ_BODY_TIMEOUT_MS);

    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function errorChunk(message: string): ChatCompletionChunk {
  return {
    id: 'error',
    object: 'chat.completion.chunk',
    model: 'unknown',
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { content: `[error] ${message}` }, finish_reason: 'stop' }],
  };
}
