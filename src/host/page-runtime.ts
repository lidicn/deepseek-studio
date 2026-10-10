/**
 * 页端运行时集线器（v0.4，宿主侧）
 *
 * 在常驻宿主的 HTTP server 上挂载一个 ws 通道（默认 /studio），承接注入页的连接：
 *   - 注入页 hello 后登记 origin；
 *   - 宿主 dispatch(tool, params, callId) → 选一个匹配的页 → 推 dispatch → 等 result；
 *   - 宿主 requestConsent(callId, tool, params) → 推 consent-required → 等 consent-decision。
 *
 * 全部 fail-closed：无可用页 → dispatch 返回 no-page-runtime、consent 返回 deny；
 * result / consent-decision 超时（默认 30s / 60s）同样按失败/拒绝处理。断线即移除客户端。
 */

import type { Server, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ExecuteResult } from '../capabilities/types';
import type { ToolExecutionResult } from './desktop-host';
import type { ConsentDecision, ConsentMeta, HostToPageMessage, PageToHostMessage } from './protocol';
import { mapUpstreamToolInvocation } from '../shared/tool-contract';
import { DEEPSEEK_ORIGIN } from './tool-definitions';

/**
 * PNA 白名单：公网页（chat.deepseek.com）需要连本机 ws 通道，Chromium 在「实际握手
 * 响应(101)」上也要求 Access-Control-Allow-Private-Network: true（仅 OPTIONS 预检放行不够，
 * 否则连接被静默断开 → 页端 host-client 永远连不上 → 所有工具调用 no-host）。
 */
const PNA_LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function isPnaAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return origin === DEEPSEEK_ORIGIN || PNA_LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export interface PageClient {
  readonly id: string;
  readonly origin: string | null;
  /** v0.5：该页是否被自检判定为不可信（注入对象遭篡改）。 */
  readonly untrusted: boolean;
  send(msg: HostToPageMessage): void;
}

export interface PageRuntimeHubOptions {
  server: Server;
  path?: string;
  dispatchTimeoutMs?: number;
  consentTimeoutMs?: number;
  onError?: (message: string, error?: unknown) => void;
  /**
   * v0.6：页端 tool-call 的真实执行器。收到页端 tool-call 后，宿主先把上游
   * invocationName 映射为 Studio 工具 id，再调用此执行器（实际即 desktop-host
   * 的 invokeTool，内部走完整授权链 + 同意闸门 + 宿主侧能力执行）。
   * 缺省不提供时，tool-call 一律回 { ok:false, error:'no-executor' }（fail-closed）。
   */
  executor?: (tool: string, params: unknown) => Promise<ToolExecutionResult>;
  /**
   * M1：页端发起工具调用的观察钩子（AgentLoop 据此统计每步工具调用次数，
   * 面板据此展示工具卡片）。观察者，不影响执行链路。
   */
  onToolCall?: (info: { callId: string; invocationName: string; tool: string; params: unknown }) => void;
  onToolResult?: (info: { callId: string; tool: string; ok: boolean; error?: string }) => void;
}

export interface PageRuntimeHub {
  readonly connectedPages: ReadonlyArray<PageClient>;
  /** 仅包含未被判定为篡改的页（派发与征求同意都应以此为准）。 */
  readonly trustedPages: ReadonlyArray<PageClient>;
  /** 推一个工具调用到页端并等结果；无页/超时 → { ok:false, error }。 */
  dispatch(tool: string, params: unknown, callId: string): Promise<ExecuteResult>;
  /** 向页端请求用户同意；无页/超时 → 'deny'（fail-closed）。meta 为可选的呈现信息。 */
  requestConsent(callId: string, tool: string, params: unknown, meta?: ConsentMeta): Promise<ConsentDecision>;
  dispose(): void;
}

export function createPageRuntimeHub(options: PageRuntimeHubOptions): PageRuntimeHub {
  const path = options.path ?? '/studio';
  const dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
  const consentTimeoutMs = options.consentTimeoutMs ?? 60_000;
  // 重要：不能用 { server, path } 让 ws 自己挂 upgrade 监听——同一 HTTP server 上的
  // 多个 WebSocketServer 会对「不匹配的路径」调用 abortHandshake(400) 毁掉别人的连接
  // （两个通道互踩：/studio 被 /agent-ws 的服务掐断，反之亦然）。
  // 正确姿势：noServer + 自带路径守卫的 upgrade 监听，不匹配就绝不触碰 socket。
  const wss = new WebSocketServer({ noServer: true });
  // PNA 补强：在实际握手响应(101)上补回 CORS + Allow-Private-Network 头，
  // 否则 chat.deepseek.com 这类公网页连本机 ws 会被 Chromium 静默断开（no-host）。
  wss.on('headers', (headers: string[], req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (isPnaAllowedOrigin(origin)) {
      headers.push(`Access-Control-Allow-Origin: ${origin as string}`);
      headers.push('Access-Control-Allow-Private-Network: true');
      headers.push('Vary: Origin');
    }
  });
  options.server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const clients = new Map<string, { ws: WebSocket; origin: string | null; untrusted: boolean }>();
  const pendingDispatch = new Map<string, { resolve: (r: ExecuteResult) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingConsent = new Map<string, { resolve: (d: ConsentDecision) => void; timer: ReturnType<typeof setTimeout> }>();

  function safeSend(ws: WebSocket, msg: HostToPageMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    } catch (err) {
      options.onError?.(`page-runtime send failed: ${msg.type}`, err);
    }
  }

  function pickClient(): { ws: WebSocket } | null {
    // 当前单页场景：返回任一「可信」的已连接客户端。多页扩展时可按 origin 选择。
    // 关键：被自检判定为篡改的页必须被跳过，否则工具就派发给了敌意页面。
    for (const c of clients.values()) {
      if (!c.untrusted) return c;
    }
    return null;
  }

  wss.on('connection', (ws: WebSocket) => {
    const id = crypto.randomUUID();
    const rec: { ws: WebSocket; origin: string | null; untrusted: boolean } = { ws, origin: null, untrusted: false };
    clients.set(id, rec);
    ws.on('message', (raw) => {
      let msg: PageToHostMessage;
      try {
        msg = JSON.parse(raw.toString()) as PageToHostMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        rec.origin = msg.origin ?? null;
        safeSend(ws, { type: 'hello-ack', sessionId: id });
      } else if (msg.type === 'result') {
        const p = pendingDispatch.get(msg.callId);
        if (p) {
          clearTimeout(p.timer);
          pendingDispatch.delete(msg.callId);
          p.resolve({ ok: msg.ok, data: msg.data, error: msg.error });
        }
      } else if (msg.type === 'integrity-alert') {
        // 页端自检发现注入对象被篡改 → 该页不再可信（fail-closed 降级）
        rec.untrusted = true;
        options.onError?.(`integrity violation: page=${id} reason=${msg.reason}${msg.detail ? ` detail=${msg.detail}` : ''}`);
      } else if (msg.type === 'consent-decision') {
        const p = pendingConsent.get(msg.callId);
        if (p) {
          clearTimeout(p.timer);
          pendingConsent.delete(msg.callId);
          p.resolve(msg.decision);
        }
      } else if (msg.type === 'tool-call') {
        // v0.6：页端拦截到模型发起的工具调用，反向投递给宿主真实执行。
        const mapped = mapUpstreamToolInvocation(msg.invocationName, msg.params);
        if (!mapped) {
          safeSend(ws, { type: 'tool-call-result', callId: msg.callId, ok: false, error: 'unknown-tool' });
          return;
        }
        const exec = options.executor;
        if (!exec) {
          safeSend(ws, { type: 'tool-call-result', callId: msg.callId, ok: false, error: 'no-executor' });
          return;
        }
        options.onToolCall?.({ callId: msg.callId, invocationName: msg.invocationName, tool: mapped.id, params: mapped.params });
        void exec(mapped.id, mapped.params)
          .then((r) => {
            options.onToolResult?.({ callId: msg.callId, tool: mapped.id, ok: r.ok, error: r.reason });
            safeSend(ws, { type: 'tool-call-result', callId: msg.callId, ok: r.ok, data: r.data, error: r.reason });
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            options.onToolResult?.({ callId: msg.callId, tool: mapped.id, ok: false, error: message });
            safeSend(ws, {
              type: 'tool-call-result',
              callId: msg.callId,
              ok: false,
              error: message,
            });
          });
      }
    });
    ws.on('close', () => clients.delete(id));
    ws.on('error', () => clients.delete(id));
  });

  return {
    get connectedPages(): ReadonlyArray<PageClient> {
      return [...clients.entries()].map(([id, c]) => ({
        id,
        origin: c.origin,
        untrusted: c.untrusted,
        send: (m: HostToPageMessage) => safeSend(c.ws, m),
      }));
    },
    get trustedPages(): ReadonlyArray<PageClient> {
      return this.connectedPages.filter((p) => !p.untrusted);
    },
    dispatch(tool, params, callId) {
      return new Promise<ExecuteResult>((resolve) => {
        const client = pickClient();
        if (!client) {
          resolve({ ok: false, error: 'no-page-runtime' });
          return;
        }
        const timer = setTimeout(() => {
          pendingDispatch.delete(callId);
          resolve({ ok: false, error: 'page-timeout' });
        }, dispatchTimeoutMs);
        pendingDispatch.set(callId, { resolve, timer });
        safeSend(client.ws, { type: 'dispatch', callId, tool, params });
      });
    },
    requestConsent(callId, tool, params, meta) {
      return new Promise<ConsentDecision>((resolve) => {
        const client = pickClient();
        if (!client) {
          resolve('deny');
          return;
        }
        const timer = setTimeout(() => {
          pendingConsent.delete(callId);
          resolve('deny');
        }, consentTimeoutMs);
        pendingConsent.set(callId, { resolve, timer });
        safeSend(client.ws, { type: 'consent-required', callId, tool, params, meta });
      });
    },
    dispose() {
      wss.close();
      for (const c of clients.values()) {
        try {
          c.ws.close();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      for (const p of pendingDispatch.values()) clearTimeout(p.timer);
      for (const p of pendingConsent.values()) clearTimeout(p.timer);
      pendingDispatch.clear();
      pendingConsent.clear();
    },
  };
}
