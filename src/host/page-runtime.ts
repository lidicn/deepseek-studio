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
import { appendFileSync, mkdirSync } from 'node:fs';
// 必须换名导入：本文件内部已有 `const path = options.path ?? '/studio'`（WS 挂载路径），
// 直接 import * as path 会被它遮蔽。
import * as nodePath from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ExecuteResult } from '../capabilities/types';
import type { ToolExecutionResult } from './desktop-host';
import type { ConsentDecision, ConsentMeta, HostToPageMessage, PageToHostMessage } from './protocol';
import { mapUpstreamToolInvocation } from '../shared/tool-contract';
import { DEEPSEEK_ORIGIN } from './tool-definitions';
import { verifyWsQueryToken, type WSQueryTokenSource } from './host-token';

/** QD-R7-01（F12）：单行 JSONL 的上限。超长只丢取证细节，不影响落盘本身。 */
const TRACE_LINE_MAX_CHARS = 16_000;

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
  /** v0.24：注入脚本自报的 botId（hello 时登记；旧脚本不上报 → undefined）。 */
  readonly botId: string | undefined;
  /**
   * v0.31：注入脚本 hello 上报的账号身份指纹（localStorage.userToken 的 SHA-256）。
   * 不外泄原始 token。宿主据此做同账号双窗口去重；两窗口同指纹 → 第二个 fail-closed。
   * 旧脚本/未登录 → undefined（不参与去重，向后兼容）。
   */
  readonly accountFingerprint: string | undefined;
  send(msg: HostToPageMessage): void;
}

export interface PageRuntimeHubOptions {
  server: Server;
  path?: string;
  /**
   * P0-2 修复：WS 连接必须校验 query token，零鉴权时任意本地进程可连工具通道。
   * QD-R2-12：支持每请求求值的 TokenSource（轮换环），不再是构造期冻结字面量；
   * 空 token / 取到空集合 → fail-closed（拒绝所有连接），不再等于「不校验」。
   */
  token?: WSQueryTokenSource;
  dispatchTimeoutMs?: number;
  consentTimeoutMs?: number;
  onError?: (message: string, error?: unknown) => void;
  /**
   * v0.6：页端 tool-call 的真实执行器。收到页端 tool-call 后，宿主先把上游
   * invocationName 映射为 Studio 工具 id，再调用此执行器（实际即 desktop-host
   * 的 invokeTool，内部走完整授权链 + 同意闸门 + 宿主侧能力执行）。
   * 缺省不提供时，tool-call 一律回 { ok:false, error:'no-executor' }（fail-closed）。
   */
  /**
   * v0.24：botId 可选，标识发起该工具调用的 bot——宿主据此路由到对应 bot 的
   * executor / 工具白名单（v0.25）与授权身份；缺省='main'。
   */
  executor?: (
    tool: string,
    params: unknown,
    botId?: string,
    conversationId?: string,
  ) => Promise<ToolExecutionResult>;
  /** 调试：页端 debug-eval-result 回调。 */
  onDebugEvalResult?: (requestId: string, ok: boolean, result: string) => void;
  /**
   * M1：页端发起工具调用的观察钩子（AgentLoop 据此统计每步工具调用次数，
   * 面板据此展示工具卡片）。观察者，不影响执行链路。
   * v0.24：info 带 botId，宿主据此累加对应 bot 的独立 counter。
   */
  onToolCall?: (info: { callId: string; invocationName: string; tool: string; params: unknown; botId?: string }) => void;
  /** v0.9：页端 auto-continue 收到模型最终回复时的回调。v0.24：带 botId 定位写入哪个 bot 的缓冲。 */
  onAssistantReply?: (text: string, loop: number, botId?: string) => void;
  /** M9：流式 delta 回调。 */
  onStreamDelta?: (text: string, botId?: string) => void;
  /** v1.0：宿主推送记忆列表更新时的回调。 */
  onMemoriesUpdate?: (memories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }>) => void;
  onToolResult?: (info: { callId: string; tool: string; ok: boolean; error?: string; botId?: string; details?: Record<string, unknown> }) => void;
  /** 可信页 hello 登记完成（该页可执行能力）。 */
  onConnect?: (info: { id: string; botId?: string }) => void;
  /**
   * 页端连接断开（ws close / error）观察钩子。观察者，不影响 hub 自身的 pending 失败逻辑。
   * T5：宿主据此把本侧 pendingRuns 中未完成 runId 统一标 failed / page-disconnected 并清空。
   */
  onDisconnect?: (info: { id: string; botId?: string }) => void;
  /**
   * v0.31 账号身份锁：hello 上报的 accountFingerprint 与已登记页重复（同账号双窗口）。
   * 防封号铁律「1 槽位 : 1 账号 : 1 窗口」的违例告警。命中后该连接已被标记 untrusted
   * + 推 account-duplicate-block（fail-closed），本回调仅用于告警/落事件。
   */
  onDuplicateAccount?: (info: {
    duplicateId: string;
    duplicateBotId: string | undefined;
    existingId: string;
    existingBotId: string | undefined;
    fingerprint: string;
  }) => void;
  /** v0.7：页端 storage shim 的 KV 后端（宿主侧落盘）。缺省时 kv-* 消息回 no-kv-store。 */
  kvStore?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

export interface PageRuntimeHub {
  readonly connectedPages: ReadonlyArray<PageClient>;
  /** 仅包含未被判定为篡改的页（派发与征求同意都应以此为准）。 */
  readonly trustedPages: ReadonlyArray<PageClient>;
  /** 推一个工具调用到页端并等结果；无页/超时 → { ok:false, error }。
   *  v0.24：botId 可选，按 botId 选页（多窗口按登录态路由）；缺省=main。 */
  dispatch(tool: string, params: unknown, callId: string, botId?: string): Promise<ExecuteResult>;
  /** 向页端请求用户同意；无页/超时 → 'deny'（fail-closed）。meta 为可选的呈现信息。
   *  v0.24：botId 可选，向发起 bot 的窗口征求同意；缺省=main。 */
  requestConsent(callId: string, tool: string, params: unknown, meta?: ConsentMeta, botId?: string): Promise<ConsentDecision>;
  /** v1.0：向所有已连接页端广播记忆列表更新。 */
  broadcastMemories(memories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }>): void;
  /** 调试：向所有页端广播 debug-eval 请求。 */
  broadcastDebugEval(requestId: string, code: string): void;
  dispose(): void;
}

/** v0.24：缺省 botId（向后兼容：旧注入脚本 hello 不上报 botId → 归为 main）。 */
const MAIN_BOT_ID = 'main';

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
    // P0-2 修复：WS 连接必须校验 query token，零鉴权时任意本地进程可连工具通道。
    // QD-R2-12：接轮换环（TokenSource 函数形式）；candidates 为空 = fail-closed 拒绝。
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!verifyWsQueryToken(url.searchParams.get('token'), options.token)) {
      options.onError?.('ws upgrade rejected: invalid or missing token (fail-closed)');
      socket.destroy();
      return;
    }
    // R2-03：upgrade 阶段即校验 Origin。原实现只判路径，任意公网网页都能连上本机
    // 工具通道（浏览器同源策略不阻止 ws 建连）。带 Origin 但不在白名单 → 直接销毁。
    // 无 Origin 的非浏览器客户端（测试/本机脚本）放行，由 R2-02 的 hello-ready 闸门兜底。
    const origin = req.headers.origin;
    if (origin !== undefined && !isPnaAllowedOrigin(origin)) {
      options.onError?.(`ws upgrade rejected: origin not allowed (${origin})`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const clients = new Map<string, { id: string; ws: WebSocket; origin: string | null; untrusted: boolean; ready: boolean; botId: string | undefined; accountFingerprint: string | undefined; reqOrigin: string | null }>();
  // QD-R2-03：pending 表必须记录「这条等待是发给哪个连接的」。
  // 否则任何已连上的连接（哪怕没握手、没 token、是恶意页）猜中 callId 就能替可信页
  // 伪造 result / consent-decision，把宿主正在等的工具结果/同意决定直接 resolve 掉。
  // ownerId 绑死连接后，跨连接的回执一律忽略。
  const pendingDispatch = new Map<string, { ownerId: string; resolve: (r: ExecuteResult) => void; timer: ReturnType<typeof setTimeout> }>();
  const pendingConsent = new Map<string, { ownerId: string; resolve: (d: ConsentDecision) => void; timer: ReturnType<typeof setTimeout> }>();

  /**
   * C4 修复：页端断开时立即结算所有待决请求，不干等 30s/60s 超时。
   * 修复前 ws.on('close') 只做 clients.delete(id)，pendingDispatch/pendingConsent
   * 中的 Promise 只能等 dispatchTimeoutMs/consentTimeoutMs 才结算。
   */
  function failAllPending(reason: string, ownerId?: string): void {
    for (const [id, p] of pendingDispatch) {
      if (ownerId !== undefined && p.ownerId !== ownerId) continue;
      clearTimeout(p.timer);
      pendingDispatch.delete(id);
      p.resolve({ ok: false, error: reason });
    }
    for (const [id, p] of pendingConsent) {
      if (ownerId !== undefined && p.ownerId !== ownerId) continue;
      clearTimeout(p.timer);
      pendingConsent.delete(id);
      p.resolve('deny');
    }
  }

  function safeSend(ws: WebSocket, msg: HostToPageMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    } catch (err) {
      options.onError?.(`page-runtime send failed: ${msg.type}`, err);
    }
  }

  function pickClient(botId?: string): { id: string; ws: WebSocket } | null {
    // v0.24：调用方给了 botId 才按 botId 路由到对应窗口的页（每窗口一个独立登录态）。
    // 兼容规则：调用方不传 botId → 完全沿用改造前的「任一可信页」行为，不做 botId 过滤。
    // 这样单窗口 / 旧脚本 / 遗留调用路径行为不变；而多 bot 引擎各自带 botId 调用即精确寻址。
    // 关键：被自检判定为篡改的页必须被跳过，否则工具就派发给了敌意页面。
    // R2-02：未完成 hello 握手（ready=false）的连接也必须跳过——原实现只查 untrusted，
    // 已连接但从不发 hello 的本机进程会成为合法 dispatch 目标，截获含文件路径/shell 命令的参数。
    for (const c of clients.values()) {
      if (c.untrusted || !c.ready) continue;
      if (botId !== undefined && (c.botId ?? MAIN_BOT_ID) !== botId) continue;
      return c;
    }
    return null;
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const id = crypto.randomUUID();
    // R2-02：ready 仅在 hello 成功后置 true；reqOrigin 用于校验自报 origin 与握手 Origin 一致。
    const rec: { id: string; ws: WebSocket; origin: string | null; untrusted: boolean; ready: boolean; botId: string | undefined; accountFingerprint: string | undefined; reqOrigin: string | null } = {
      id,
      ws,
      origin: null,
      untrusted: false,
      ready: false,
      botId: undefined,
      accountFingerprint: undefined,
      reqOrigin: (req.headers.origin as string | undefined) ?? null,
    };
    clients.set(id, rec);
    ws.on('message', async (raw) => {
      let msg: PageToHostMessage;
      try {
        msg = JSON.parse(raw.toString()) as PageToHostMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        // R2-02：握手带了 Origin 时，hello 自报 origin 必须与之完全一致，防止自报伪造
        // （任意网页可在 hello 里谎报 origin=https://chat.deepseek.com 绕过后续校验）。
        if (rec.reqOrigin && msg.origin && msg.origin !== rec.reqOrigin) {
          rec.untrusted = true;
          options.onError?.(`hello origin mismatch: claimed=${msg.origin} handshake=${rec.reqOrigin}`);
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        rec.origin = msg.origin ?? null;
        // v0.24：登记自报 botId（旧脚本不上报 → undefined，pickClient 按 main 处理）。
        rec.botId = typeof msg.botId === 'string' && msg.botId.length > 0 ? msg.botId : undefined;
        // v0.31：登记账号身份指纹（旧脚本/未登录 → undefined，不参与去重）。
        rec.accountFingerprint = typeof msg.accountFingerprint === 'string' && msg.accountFingerprint.length > 0 ? msg.accountFingerprint : undefined;
        // R2-02：hello 登记完成 → 标记 ready，pickClient 只派发 ready 且未被判定篡改的连接。
        rec.ready = true;
        safeSend(ws, { type: 'hello-ack', sessionId: id });
        // v0.31 账号身份锁：同账号双窗口 = 必封。hello 登记指纹后立即查重——
        // 已有另一个 trusted 页报到相同指纹 → 本连接 fail-closed（标 untrusted + 推阻塞）。
        if (rec.accountFingerprint && !rec.untrusted) {
          let dup: { id: string; botId: string | undefined } | null = null;
          for (const [otherId, other] of clients.entries()) {
            if (otherId === id) continue;
            if (other.untrusted) continue;
            if (other.accountFingerprint && other.accountFingerprint === rec.accountFingerprint) {
              dup = { id: otherId, botId: other.botId };
              break;
            }
          }
          if (dup) {
            rec.untrusted = true;
            const reason = `账号已在另一窗口登录（bot=${dup.botId ?? 'main'}）。同账号多窗口会触发 DeepSeek 封号，请关闭本窗口或切换账号。`;
            safeSend(ws, { type: 'account-duplicate-block', reason, duplicateOf: dup.botId ?? 'main' });
            options.onDuplicateAccount?.({
              duplicateId: id,
              duplicateBotId: rec.botId,
              existingId: dup.id,
              existingBotId: dup.botId,
              fingerprint: rec.accountFingerprint,
            });
          }
        }
        if (!rec.untrusted) {
          options.onConnect?.({ id, botId: rec.botId });
        }
      } else if (msg.type === 'result') {
        // QD-R2-03 入站身份门：
        // ① 未握手（!ready）或已被判定篡改（untrusted）的连接发的任何 result 一律忽略。
        // ② callId 必须是「宿主发给本连接」那条等待的回执（ownerId 绑死连接），
        //    否则恶意连接猜中别人的 callId 也不能替可信页伪造工具结果。
        if (!rec.ready || rec.untrusted) return;
        const p = pendingDispatch.get(msg.callId);
        if (p && p.ownerId === id) {
          clearTimeout(p.timer);
          pendingDispatch.delete(msg.callId);
          p.resolve({ ok: msg.ok, data: msg.data, error: msg.error });
        }
      } else if (msg.type === 'integrity-alert') {
        // 页端自检发现注入对象被篡改 → 该页不再可信（fail-closed 降级）
        rec.untrusted = true;
        options.onError?.(`integrity violation: page=${id} reason=${msg.reason}${msg.detail ? ` detail=${msg.detail}` : ''}`);
      } else if (msg.type === 'log') {
        console.log(`[page ${id}] ${msg.text}`);
      } else if (msg.type === 'trace') {
        // QD-R7-01（F12）：断流取证落盘 —— 每轮一行 JSONL。
        // 此前取证只有三条路：页端内存环（刷新即丢）、localStorage 死键（三个函数零调用）、
        // console.log（桌面启动时 stdout 没人接）。结果就是「故障不落盘」，
        // 修的人拿不到一次真实样本，只能靠猜。这里把每轮的 turn.end 写进
        // logs/trace/trace-<日期>.jsonl，重启后仍在，可直接 diff。
        try {
          const dir = nodePath.resolve(process.cwd(), 'logs', 'trace');
          mkdirSync(dir, { recursive: true });
          const day = new Date().toISOString().slice(0, 10);
          // 单行化 + 截断：JSONL 一行必须是一行，且不能让超长载荷拖垮落盘。
          const line = (msg.line.length > TRACE_LINE_MAX_CHARS
            ? `${msg.line.slice(0, TRACE_LINE_MAX_CHARS)}...[truncated]`
            : msg.line
          ).replace(/[\r\n]+/g, ' ');
          appendFileSync(nodePath.join(dir, `trace-${day}.jsonl`), `${line}\n`, 'utf8');
        } catch {
          // 落盘失败不影响主链路（只影响事后取证）。
        }
      } else if (msg.type === 'assistant-reply') {
        // v0.24：以 hello 登记的 rec.botId 为准定位是哪个 bot 的 auto-continue 回复。
        options.onAssistantReply?.(msg.text, msg.loop, rec.botId);
      } else if (msg.type === 'stream-delta') {
        // M9：流式 delta 推给宿主（web-engine onDelta）
        options.onStreamDelta?.(msg.text, rec.botId);
      } else if (msg.type === 'kv-get') {
        const store = options.kvStore;
        if (!store) { safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: false, error: 'no-kv-store' }); return; }
        try {
          const value = await store.get(msg.key);
          safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: true, value });
        } catch (e) {
          safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: false, error: (e as Error).message });
        }
      } else if (msg.type === 'kv-set') {
        const store = options.kvStore;
        if (!store) { safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: false, error: 'no-kv-store' }); return; }
        try {
          await store.set(msg.key, msg.value);
          safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: true });
        } catch (e) {
          safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: false, error: (e as Error).message });
        }
      } else if (msg.type === 'kv-remove') {
        const store = options.kvStore;
        if (!store) { safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: false, error: 'no-kv-store' }); return; }
        try {
          await store.remove(msg.key);
          safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: true });
        } catch (e) {
          safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: false, error: (e as Error).message });
        }
      } else if (msg.type === 'runtime-envelope') {
        const { command, requestId, payload } = msg.envelope;
        // v0.7：第一批纯 KV 型 runtime 命令。ping/pong 健康检查；kv_* 走宿主落盘 backend。
        if (command === 'ping') {
          safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: true, pong: true } });
        } else if (command === 'kv_get') {
          const store = options.kvStore;
          if (!store) { safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: false, error: 'no-kv-store' } }); return; }
          const key = (payload as { key?: string })?.key ?? '';
          try {
            const value = await store.get(key);
            safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: true, value } });
          } catch (e) {
            safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: false, error: (e as Error).message } });
          }
        } else if (command === 'kv_set') {
          const store = options.kvStore;
          if (!store) { safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: false, error: 'no-kv-store' } }); return; }
          const { key, value } = (payload ?? {}) as { key?: string; value?: unknown };
          try {
            await store.set(key ?? '', value);
            safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: true } });
          } catch (e) {
            safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: false, error: (e as Error).message } });
          }
        } else {
          safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: false, error: `unknown-command: ${command}` } });
        }
      } else if (msg.type === 'consent-decision') {
        // QD-R2-03：同 result 分支——未握手/不可信连接的同意决定一律忽略；
        // 且必须是宿主发给本连接的那条 consent-required 的回执。
        if (!rec.ready || rec.untrusted) return;
        const p = pendingConsent.get(msg.callId);
        if (p && p.ownerId === id) {
          clearTimeout(p.timer);
          pendingConsent.delete(msg.callId);
          p.resolve(msg.decision);
        }
      } else if (msg.type === 'debug-eval-result') {
        options.onDebugEvalResult?.(msg.requestId, msg.ok, msg.result ?? '');
      } else if (msg.type === 'tool-call') {
        // v0.6：页端拦截到模型发起的工具调用，反向投递给宿主真实执行。
        // v1.8：整个分支包 try/catch。invocationName 来自 WebSocket 报文属外部可控
        // 输入，映射层（mapUpstreamToolInvocation）若因任何原因抛异常（原型链穿透、
        // 适配函数内部错误等），必须回执 tool-call-result 而非让异常逃逸成未处理
        // Promise rejection，否则页端 pending 请求永久悬挂，违反 fail-closed 契约。
        // 与同模块 safeSend / failAllPending 的防御标准一致。
        let mapped;
        try {
          mapped = mapUpstreamToolInvocation(msg.invocationName, msg.params);
        } catch (e) {
          safeSend(ws, { type: 'tool-call-result', callId: msg.callId, ok: false, error: `bad-invocation: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        if (!mapped) {
          safeSend(ws, { type: 'tool-call-result', callId: msg.callId, ok: false, error: 'unknown-tool' });
          return;
        }
        const exec = options.executor;
        if (!exec) {
          safeSend(ws, { type: 'tool-call-result', callId: msg.callId, ok: false, error: 'no-executor' });
          return;
        }
        // v0.24：调用方身份以 hello 登记的 rec.botId 为准（连接级身份），
        // 报文 msg.botId 仅作兜底。用于路由到对应 bot 的 executor / counter / 白名单。
        const callBotId = rec.botId ?? msg.botId;
        options.onToolCall?.({ callId: msg.callId, invocationName: msg.invocationName, tool: mapped.id, params: mapped.params, botId: callBotId });
        void exec(mapped.id, mapped.params, callBotId, msg.conversationId)
          .then((r) => {
            options.onToolResult?.({ callId: msg.callId, tool: mapped.id, ok: r.ok, error: r.reason, botId: callBotId, ...(r.details !== undefined ? { details: r.details as Record<string, unknown> } : {}) });
            safeSend(ws, {
              type: 'tool-call-result',
              callId: msg.callId,
              ok: r.ok,
              data: r.data,
              error: r.reason,
              // v1.2：透传 Pi Agent 风格新格式字段
              ...(r.content !== undefined ? { content: r.content } : {}),
              ...(r.details !== undefined ? { details: r.details } : {}),
              ...(r.isError !== undefined ? { isError: r.isError } : {}),
              ...(r.terminate !== undefined ? { terminate: r.terminate } : {}),
            });
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            options.onToolResult?.({ callId: msg.callId, tool: mapped.id, ok: false, error: message, botId: callBotId });
            safeSend(ws, {
              type: 'tool-call-result',
              callId: msg.callId,
              ok: false,
              error: message,
            });
          });
      }
    });
    ws.on('close', () => { clients.delete(id); failAllPending('page-disconnected', id); options.onDisconnect?.({ id, botId: rec.botId }); });
    ws.on('error', () => { clients.delete(id); failAllPending('page-disconnected', id); options.onDisconnect?.({ id, botId: rec.botId }); });
  });

  return {
    get connectedPages(): ReadonlyArray<PageClient> {
      return [...clients.entries()].map(([id, c]) => ({
        id,
        origin: c.origin,
        untrusted: c.untrusted,
        botId: c.botId,
        accountFingerprint: c.accountFingerprint,
        send: (m: HostToPageMessage) => safeSend(c.ws, m),
      }));
    },
    get trustedPages(): ReadonlyArray<PageClient> {
      return this.connectedPages.filter((p) => !p.untrusted);
    },
    dispatch(tool, params, callId, botId) {
      return new Promise<ExecuteResult>((resolve) => {
        const picked = pickClient(botId);
        if (!picked) {
          resolve({ ok: false, error: 'no-page-runtime' });
          return;
        }
        const timer = setTimeout(() => {
          pendingDispatch.delete(callId);
          resolve({ ok: false, error: 'page-timeout' });
        }, dispatchTimeoutMs);
        // QD-R2-03：记录这条等待属于哪个连接，回执时同连接才认。
        pendingDispatch.set(callId, { ownerId: picked.id, resolve, timer });
        // v0.24：透传 botId，页端可据此区分调用来源（并回执 tool-call 时带回）。
        safeSend(picked.ws, { type: 'dispatch', callId, tool, params, botId });
      });
    },
    requestConsent(callId, tool, params, meta, botId) {
      return new Promise<ConsentDecision>((resolve) => {
        const picked = pickClient(botId);
        if (!picked) {
          resolve('deny');
          return;
        }
        const timer = setTimeout(() => {
          pendingConsent.delete(callId);
          resolve('deny');
        }, consentTimeoutMs);
        pendingConsent.set(callId, { ownerId: picked.id, resolve, timer });
        safeSend(picked.ws, { type: 'consent-required', callId, tool, params, meta, botId });
      });
    },
    broadcastMemories(memories) {
      const msg: HostToPageMessage = { type: 'memories-update', memories };
      // R2-02：未完成 hello 的连接不收广播（避免向未握手连接泄露记忆内容/调试代码）。
      for (const c of clients.values()) {
        if (!c.untrusted && c.ready) safeSend(c.ws, msg);
      }
    },
    broadcastDebugEval(requestId, code) {
      for (const c of clients.values()) {
        if (!c.untrusted && c.ready) safeSend(c.ws, { type: 'debug-eval', requestId, code });
      }
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
      // 先 resolve 所有 pending Promise，避免调用方 await 悬挂
      for (const p of pendingDispatch.values()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'disposed' });
      }
      for (const p of pendingConsent.values()) {
        clearTimeout(p.timer);
        p.resolve('deny');
      }
      pendingDispatch.clear();
      pendingConsent.clear();
    },
  };
}
