/**
 * 本地控制 API（node:http，默认 127.0.0.1:8761）
 *
 *   GET  /healthz   {"ok":true}（免鉴权）
 *   GET  /status    {state, rounds, target, lastRound}（Bearer，fail-closed）
 *   POST /command   {"command":"continue|pause|stop|reset"}（Bearer）
 *   GET  /commands  命令队列观测（Bearer）
 *   其余 → 404 {error:{code,message}}；已知路径 + 错误方法 → 405 + Allow
 */

import http from 'node:http';
import type { Server } from 'node:http';
import { URL } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isCommandName,
  type CommandName,
  type CommandRecord,
  type EnqueueResult,
  type LoopStatus,
} from './audit-loop';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8761;
export const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
export const READ_BODY_TIMEOUT_MS = 30_000;

export interface Authenticator {
  authenticate(header: string | string[] | undefined): boolean;
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bearer 鉴权（恒定时间比较，fail-closed）。 */
export function createBearerAuthenticator(token: string): Authenticator {
  const expected = digest(`Bearer ${token}`);
  return {
    authenticate(header) {
      const raw = Array.isArray(header) ? header[0] : header;
      if (typeof raw !== 'string') return false;
      return safeEqual(digest(raw), expected);
    },
  };
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** CORS fail-closed：非本地 origin 一律不写 Allow-Origin（§1 5.5 同语义）。 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (!isLocalOrigin(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin as string);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

export interface ReadBodyLimits {
  maxBodyBytes: number;
  timeoutMs: number;
}

/** readBody：30s 超时 + 10MB 上限（§0 契约）；超限/超时用错误码区分，便于映射 413/408。 */
export function readBody(req: http.IncomingMessage, limits: ReadBodyLimits): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('read body timeout') as NodeJS.ErrnoException;
      err.code = 'BODY_TIMEOUT';
      reject(err);
    }, limits.timeoutMs);

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > limits.maxBodyBytes) {
        const err = new Error('request body too large') as NodeJS.ErrnoException;
        err.code = 'BODY_TOO_LARGE';
        fail(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => fail(err));
  });
}

export interface LoopView {
  status(): LoopStatus;
  enqueue(command: CommandName): EnqueueResult;
  pending(): readonly CommandRecord[];
  history(limit?: number): readonly CommandRecord[];
}

export interface TaobaoServerOptions {
  config: { host: string; port: number; token: string };
  loop: LoopView;
  authenticator?: Authenticator;
  /** true：来自回环 socket 且未带 token 的请求放行（仅供裸 curl 验收，默认 false = 严格）。 */
  allowLoopbackUnauthenticated?: boolean;
  limits?: { maxBodyBytes?: number; readBodyTimeoutMs?: number };
  /** /status 追加字段（project / sessionUrl / seenRounds）；缺省只返回基础 4 键。 */
  statusExtras?: () => Record<string, unknown>;
  /** audit-log.jsonl 路径，提供后开放 GET /v1/audit-log。 */
  auditLogPath?: string;
  /**
   * 浏览器动作原语（方案 A：有头可见窗口）。提供后开放：
   *   GET  /v1/screenshot  → { pngBase64 }
   *   POST /v1/send       { text } → 向元宝输入框发消息
   */
  browserControls?: {
    screenshot(): Promise<Buffer>;
    send(text: string): Promise<{ ok: boolean; reason?: string }>;
  };
}

export interface TaobaoServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  readonly rawServer: Server;
}

export function createApiServer(options: TaobaoServerOptions): TaobaoServer {
  const auth = options.authenticator ?? createBearerAuthenticator(options.config.token);
  const maxBodyBytes = options.limits?.maxBodyBytes ?? MAX_BODY_BYTES;
  const readBodyTimeoutMs = options.limits?.readBodyTimeoutMs ?? READ_BODY_TIMEOUT_MS;

  const authorized = (req: http.IncomingMessage): boolean => {
    if (auth.authenticate(req.headers['authorization'])) return true;
    return Boolean(options.allowLoopbackUnauthenticated) && isLoopbackAddress(req.socket.remoteAddress);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${options.config.host}:${options.config.port}`);
    const pathname = url.pathname;

    const sendJson = (status: number, body: unknown, extra?: Record<string, string>): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(extra ?? {}) });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, code: string, message: string, extra?: Record<string, string>): void =>
      sendJson(status, { error: { code, message } }, extra);

    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      if (!isLocalOrigin(req.headers.origin)) {
        fail(403, 'origin_not_allowed', 'only localhost origins are allowed');
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

      // 注入脚本（免鉴权，仅本地；脚本本身需要 token 参数）
      if (pathname === '/v1/inject.js') {
        if (req.method !== 'GET') {
          fail(405, 'method_not_allowed', 'GET only', { Allow: 'GET' });
          return;
        }
        try {
          const __dirname = path.dirname(fileURLToPath(import.meta.url));
          const hookPath = path.resolve(__dirname, '../../dist/yuanbao-hook.js');
          const code = fs.readFileSync(hookPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          res.end(code);
        } catch {
          fail(404, 'not_found', 'inject script not built; run npm run build:inject');
        }
        return;
      }

      if (!authorized(req)) {
        fail(401, 'unauthorized', 'missing or invalid bearer token');
        return;
      }

      if (pathname === '/status') {
        if (req.method !== 'GET') {
          fail(405, 'method_not_allowed', 'GET only', { Allow: 'GET' });
          return;
        }
        sendJson(200, { ...options.loop.status(), ...(options.statusExtras?.() ?? {}) });
        return;
      }

      if (pathname === '/command') {
        if (req.method !== 'POST') {
          fail(405, 'method_not_allowed', 'POST only', { Allow: 'POST' });
          return;
        }
        const raw = await readBody(req, { maxBodyBytes, timeoutMs: readBodyTimeoutMs });
        let body: { command?: unknown };
        try {
          body = JSON.parse(raw) as { command?: unknown };
        } catch {
          fail(400, 'bad_request', 'invalid json body');
          return;
        }
        if (!isCommandName(body?.command)) {
          fail(400, 'bad_request', 'command must be one of continue|pause|stop|reset');
          return;
        }
        const result = options.loop.enqueue(body.command);
        if (!result.ok) {
          fail(400, 'bad_request', result.reason ?? 'command rejected');
          return;
        }
        sendJson(200, {
          ok: true,
          command: result.command,
          queueDepth: result.queueDepth,
          status: options.loop.status(),
        });
        return;
      }

      if (pathname === '/commands') {
        if (req.method !== 'GET') {
          fail(405, 'method_not_allowed', 'GET only', { Allow: 'GET' });
          return;
        }
        sendJson(200, {
          ok: true,
          queueDepth: options.loop.pending().length,
          pending: options.loop.pending(),
          data: options.loop.history(50),
        });
        return;
      }

      if (pathname === '/v1/audit-log') {
        if (req.method !== 'GET') {
          fail(405, 'method_not_allowed', 'GET only', { Allow: 'GET' });
          return;
        }
        if (!options.auditLogPath) {
          fail(404, 'not_found', 'audit log path not configured');
          return;
        }
        try {
          const raw = fs.readFileSync(options.auditLogPath, 'utf8');
          const all = raw.split('\n').filter((l) => l.trim().length > 0);
          const n = Math.min(200, Math.max(1, Number(url.searchParams.get('lines') ?? 20)));
          sendJson(200, { ok: true, lines: all.slice(-n), total: all.length });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === 'ENOENT') {
            sendJson(200, { ok: true, lines: [], total: 0 });
            return;
          }
          throw err;
        }
        return;
      }

      if (pathname === '/v1/report') {
        if (req.method !== 'POST') {
          fail(405, 'method_not_allowed', 'POST only', { Allow: 'POST' });
          return;
        }
        const raw = await readBody(req, { maxBodyBytes, timeoutMs: readBodyTimeoutMs });
        let body: {
          project?: unknown; sessionUrl?: unknown; rounds?: unknown;
          state?: unknown; allDone?: unknown; timestamp?: unknown;
        };
        try {
          body = JSON.parse(raw);
        } catch {
          fail(400, 'bad_request', 'invalid json');
          return;
        }
        if (!Array.isArray(body.rounds) || typeof body.state !== 'string') {
          fail(400, 'bad_request', 'rounds[] and state required');
          return;
        }
        // 报告接收成功（实际状态更新由 main.ts 的回调处理，这里仅确认）
        sendJson(200, { ok: true, received: body.rounds.length, at: Date.now() });
        return;
      }

      if (pathname === '/v1/screenshot') {
        if (req.method !== 'GET') {
          fail(405, 'method_not_allowed', 'GET only', { Allow: 'GET' });
          return;
        }
        if (!options.browserControls) {
          fail(404, 'not_found', 'browser controls not available');
          return;
        }
        try {
          const buf = await options.browserControls.screenshot();
          sendJson(200, { ok: true, pngBase64: buf.toString('base64'), bytes: buf.length });
        } catch (err) {
          fail(500, 'screenshot_failed', err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (pathname === '/v1/send') {
        if (req.method !== 'POST') {
          fail(405, 'method_not_allowed', 'POST only', { Allow: 'POST' });
          return;
        }
        if (!options.browserControls) {
          fail(404, 'not_found', 'browser controls not available');
          return;
        }
        const raw = await readBody(req, { maxBodyBytes, timeoutMs: readBodyTimeoutMs });
        let body: { text?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          fail(400, 'bad_request', 'invalid json');
          return;
        }
        if (typeof body.text !== 'string' || !body.text.trim()) {
          fail(400, 'bad_request', 'text (non-empty string) required');
          return;
        }
        const result = await options.browserControls.send(body.text);
        sendJson(200, { ok: result.ok, reason: result.reason });
        return;
      }

      fail(404, 'not_found', `${req.method} ${pathname}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'BODY_TOO_LARGE') {
        fail(413, 'payload_too_large', 'request body too large');
        return;
      }
      if (code === 'BODY_TIMEOUT') {
        fail(408, 'request_timeout', 'read body timeout');
        return;
      }
      fail(500, 'internal', err instanceof Error ? err.message : String(err));
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
      return new Promise<void>((resolve, reject) => {
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
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
