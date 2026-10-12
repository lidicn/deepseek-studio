/**
 * 页端宿主客户端（v0.4，注入页侧）
 *
 * 在注入页面内连接常驻宿主的 ws 通道（默认 ws://127.0.0.1:8760/studio）：
 *   - hello 后登记 origin；
 *   - 收到 dispatch → 按 tool 路由到对应能力（ExecutableCapability）执行 → 回传 result；
 *   - 收到 consent-required → 渲染同意模态 → 决策回传 consent-decision。
 * 断线指数退避重连（上界默认 10s）。所有执行包 try/catch，失败转 result.ok=false + error 码。
 */

import type { ExecutableCapability, ExecuteResult } from '../capabilities/types';
import type { ConsentDecision, HostToPageMessage, PageToHostMessage } from '../host/protocol';
import { showConsent } from '../ui/consent';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  readonly readyState: number;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface HostClientOptions {
  url: string;
  capabilities: ReadonlyArray<ExecutableCapability>;
  /** 页面 origin（默认 location.origin 或 https://chat.deepseek.com）。 */
  origin?: string;
  reportError?: (message: string, error?: unknown) => void;
  /** ws 工厂（测试注入；默认全局 WebSocket）。 */
  wsFactory?: WebSocketFactory;
  /** 断线重连退避上界（毫秒），默认 10000。 */
  maxBackoffMs?: number;
  /** v0.6：tool-call 等待宿主结果的超时（毫秒），默认 30000。 */
  toolCallTimeoutMs?: number;
  /** v1.0：宿主推送记忆列表更新时的回调。 */
  onMemoriesUpdate?: (memories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }>) => void;
}

/** 页端 → 宿主 的工具调用投递请求（与拦截器 ToolCallRequest 同构）。 */
export interface ToolCallRequest {
  callId: string;
  invocationName: string;
  params: Record<string, unknown>;
}

export interface HostClient {
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  /** v0.5：上报页面完整性违规（自检发现注入对象被篡改）。宿主收到后会降级该页。 */
  reportIntegrity(alert: { reason: string; detail?: string }): void;
  /** v0.6：把一次工具调用发给宿主并等回结果（按 callId 关联 tool-call-result）。 */
  sendToolCall(req: ToolCallRequest): Promise<ExecuteResult>;
  /** 调试：发日志到宿主 stdout。 */
  log(text: string): void;
  /** v0.9：auto-continue 收到模型最终回复时推送给宿主。 */
  assistantReply(text: string, loop: number): void;
  /** v1.0：宿主推送记忆列表更新时的回调。 */
  onMemoriesUpdate?: (memories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }>) => void;
  /** v0.7：KV 读写（宿主侧落盘 backend）。 */
  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown): Promise<void>;
  kvRemove(key: string): Promise<void>;
  /** v0.7：发 runtime envelope（chrome.runtime.sendMessage 桥接）。 */
  sendEnvelope(envelope: { command: string; requestId: string; payload: unknown }): Promise<unknown>;
}

const OPEN = 1;

export function createHostClient(options: HostClientOptions): HostClient {
  const capabilities = new Map(options.capabilities.map((c) => [c.id, c]));
  const origin = options.origin ?? globalThis.location?.origin ?? 'https://chat.deepseek.com';
  const maxBackoff = options.maxBackoffMs ?? 10_000;
  const toolCallTimeoutMs = options.toolCallTimeoutMs ?? 30_000;
  let ws: WebSocketLike | null = null;
  let stopped = false;
  let backoff = 500;
  const pendingToolCalls = new Map<string, { resolve: (r: ExecuteResult) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingKv = new Map<string, { resolve: (v: unknown, error?: string) => void }>();
  const pendingEnvelope = new Map<string, { resolve: (v: unknown) => void }>();

  /**
   * R3-C1 修复：连接断开时立即结算所有待决请求。
   * 修复前 kvGet/kvSet/sendEnvelope 既无超时、onclose 也不遍历结算，
   * 一旦断线这些 Promise 永不 settle（调用方永久挂起、pending 永不清理）。
   * sendToolCall 虽有 30s 超时，也应在断线时立即失败而不是干等。
   */
  function failAllPending(reason: string): void {
    for (const [id, p] of pendingToolCalls) {
      clearTimeout(p.timer);
      pendingToolCalls.delete(id);
      p.resolve({ ok: false, error: reason });
    }
    for (const [id, p] of pendingKv) {
      pendingKv.delete(id);
      p.resolve(undefined, reason);
    }
    for (const [id, p] of pendingEnvelope) {
      pendingEnvelope.delete(id);
      p.resolve({ ok: false, error: reason });
    }
  }

  function send(msg: PageToHostMessage): void {
    if (ws && ws.readyState === OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        options.reportError?.('host-client send failed', e);
      }
    }
  }

  function handle(msg: HostToPageMessage): void {
    if (msg.type === 'dispatch') {
      const cap = capabilities.get(msg.tool);
      if (!cap) {
        send({ type: 'result', callId: msg.callId, ok: false, error: 'unknown-tool' });
        return;
      }
      void cap
        .execute((msg.params ?? {}) as Record<string, unknown>)
        .then((r: ExecuteResult) => send({ type: 'result', callId: msg.callId, ok: r.ok, data: r.data, error: r.error }))
        .catch((e: unknown) =>
          send({ type: 'result', callId: msg.callId, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
    } else if (msg.type === 'consent-required') {
      showConsent({ tool: msg.tool, params: msg.params, meta: msg.meta }, (decision: ConsentDecision) => {
        send({ type: 'consent-decision', callId: msg.callId, decision });
      });
    } else if (msg.type === 'tool-call-result') {
      const p = pendingToolCalls.get(msg.callId);
      if (p) {
        clearTimeout(p.timer);
        pendingToolCalls.delete(msg.callId);
        // v1.2：透传 Pi Agent 风格新格式字段（content/details/isError/terminate）
        p.resolve({
          ok: msg.ok,
          data: msg.data,
          error: msg.error,
          ...(msg.content !== undefined ? { content: msg.content } : {}),
          ...(msg.details !== undefined ? { details: msg.details } : {}),
          ...(msg.isError !== undefined ? { isError: msg.isError } : {}),
          ...(msg.terminate !== undefined ? { terminate: msg.terminate } : {}),
        } as ExecuteResult);
      }
    } else if (msg.type === 'kv-result') {
      const p = pendingKv.get(msg.requestId);
      if (p) {
        pendingKv.delete(msg.requestId);
        if (msg.ok) p.resolve(msg.value);
        else p.resolve(undefined, msg.error);
      }
    } else if (msg.type === 'runtime-envelope-result') {
      const p = pendingEnvelope.get(msg.requestId);
      if (p) {
        pendingEnvelope.delete(msg.requestId);
        p.resolve(msg.response);
      }
    } else if (msg.type === 'memories-update') {
      options.onMemoriesUpdate?.(msg.memories);
    }
  }

  function onMessage(raw: unknown): void {
    let msg: HostToPageMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as HostToPageMessage;
    } catch {
      return;
    }
    handle(msg);
  }

  function connectWs(): void {
    if (stopped) return;
    const make: WebSocketFactory =
      options.wsFactory ?? ((url: string) => new (globalThis.WebSocket as new (u: string) => WebSocketLike)(url));
    const socket = make(options.url);
    ws = socket;
    socket.onopen = () => {
      backoff = 500;
      send({ type: 'hello', origin, sessionId: crypto.randomUUID() });
    };
    socket.onmessage = (ev: { data: unknown }) => onMessage(ev.data);
    socket.onclose = () => {
      ws = null;
      failAllPending('disconnected');
      if (!stopped) scheduleReconnect();
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
  }

  function scheduleReconnect(): void {
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    setTimeout(connectWs, delay);
  }

  return {
    get connected() {
      return ws !== null && ws.readyState === OPEN;
    },
    reportIntegrity(alert) {
      // 不上报就无法让宿主降级，因此即便未连接也尝试发送（send 内部已判状态）
      send({ type: 'integrity-alert', reason: alert.reason, detail: alert.detail });
    },
    sendToolCall(req) {
      return new Promise<ExecuteResult>((resolve) => {
        if (!ws || ws.readyState !== OPEN) {
          resolve({ ok: false, error: 'no-host' });
          return;
        }
        const timer = setTimeout(() => {
          pendingToolCalls.delete(req.callId);
          resolve({ ok: false, error: 'host-timeout' });
        }, toolCallTimeoutMs);
        pendingToolCalls.set(req.callId, { resolve, timer });
        send({ type: 'tool-call', callId: req.callId, invocationName: req.invocationName, params: req.params });
      });
    },
    connect() {
      stopped = false;
      connectWs();
    },
    log(text: string) {
      send({ type: 'log', text });
    },
    assistantReply(text: string, loop: number) {
      send({ type: 'assistant-reply', text, loop });
    },
    kvGet(key) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== OPEN) { resolve(undefined); return; }
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingKv.delete(requestId);
          reject(new Error('kv-get timeout'));
        }, 30000);
        pendingKv.set(requestId, { resolve: (v, err) => { clearTimeout(timer); err ? reject(new Error(err)) : resolve(v); } });
        send({ type: 'kv-get', requestId, key });
      });
    },
    kvSet(key, value) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== OPEN) { resolve(); return; }
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingKv.delete(requestId);
          reject(new Error('kv-set timeout'));
        }, 30000);
        pendingKv.set(requestId, { resolve: (_v, err) => { clearTimeout(timer); err ? reject(new Error(err)) : resolve(); } });
        send({ type: 'kv-set', requestId, key, value });
      });
    },
    kvRemove(key) {
      return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== OPEN) { resolve(); return; }
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingKv.delete(requestId);
          reject(new Error('kv-remove timeout'));
        }, 30000);
        pendingKv.set(requestId, { resolve: (_v, err) => { clearTimeout(timer); err ? reject(new Error(err)) : resolve(); } });
        send({ type: 'kv-remove', requestId, key });
      });
    },
    sendEnvelope(envelope) {
      return new Promise((resolve) => {
        if (!ws || ws.readyState !== OPEN) { resolve({ ok: false, error: 'no-host' }); return; }
        const timer = setTimeout(() => {
          pendingEnvelope.delete(envelope.requestId);
          resolve({ ok: false, error: 'envelope timeout' });
        }, 30000);
        pendingEnvelope.set(envelope.requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
        send({ type: 'runtime-envelope', envelope });
      });
    },
    disconnect() {
      stopped = true;
      for (const p of pendingToolCalls.values()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'disconnected' });
      }
      pendingToolCalls.clear();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },
  };
}
