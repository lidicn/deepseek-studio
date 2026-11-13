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
import { fetchImageAsDataUrl } from './image-proxy';
import { randomBytes } from 'node:crypto';

/** QD-R7-01（F12）：单行 JSONL 的上限。超长只丢取证细节，不影响落盘本身。 */
const TRACE_LINE_MAX_CHARS = 16_000;

/** R2-01：consent nonce —— 16 字节随机，base64url（无填充）。每次 consent 一个。 */
function randomConsentNonce(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * R2-01：常数时间字符串比较（避免 nonce 校验的时序侧信道）。
 * 长度不同直接 false（长度本身不是秘密）。
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}


/**
 * PNA 白名单：公网页（chat.deepseek.com）需要连本机 ws 通道，Chromium 在「实际握手
 * 响应(101)」上也要求 Access-Control-Allow-Private-Network: true（仅 OPTIONS 预检放行不够，
 * 否则连接被静默断开 → 页端 host-client 永远连不上 → 所有工具调用 no-host）。
 */
const PNA_LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * C1 墨鉴 R3-10：要求**已完成 hello 握手**的入站消息类型。
 *
 * 原实现只有 `result` / `consent-decision` 两个分支校验 ready，
 * `kv-*` / `tool-call` / `runtime-envelope` 这些**要求宿主执行动作**的消息没校验 →
 * 连上来但从不发 hello 的本机进程可以直接读写用户 KV 或投递工具调用。
 *
 * `hello` / `log` / `trace` / `integrity-alert` / `assistant-reply` / `stream-delta` /
 * `debug-eval-result` 不在列：它们要么是握手本身，要么是纯上报（不要求宿主执行动作）。
 */
const REQUIRES_READY: ReadonlySet<PageToHostMessage['type']> = new Set([
  'kv-get',
  'kv-set',
  'kv-remove',
  'tool-call',
  'runtime-envelope',
]);

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
  /**
   * TD-02：bootstrap grant 校验器。提供后，upgrade 优先按 grant（?token= 里承载的是
   * grant 串）验签 + 一次性消费 + audience 绑定；不再要求明文 config.token。
   *
   * `?token=` 键名沿用（页端最小改动）：值可能是旧明文 token（兼容期）或新 grant 串。
   *
   * 缺省不提供 → 走旧 verifyWsQueryToken（向后兼容 UI 尚未改造的过渡期）。
   */
  grantVerifier?: (presented: string | null, botId: string) => Promise<{ ok: boolean; reason?: string }>;
  dispatchTimeoutMs?: number;
  consentTimeoutMs?: number;
  /**
   * C1 墨鉴 R3-8：页端发来的 tool-call（宿主执行）的超时上限。
   *
   * 2026-11-14（真机卡）：缺省值**不再是 60s 常量**，而是
   * `max(60s, consentTimeoutMs + TOOL_CALL_TIMEOUT_MARGIN_MS)` —— 工具调用总超时必须
   * **严格大于**审批等待预算，否则审批挂满时两者同时到点，`tool-call-timeout` 会抢走
   * 真正的失败原因（`consent-denied`）。显式传入的值原样使用（测试可压到毫秒级）。
   */
  toolCallTimeoutMs?: number;
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
  /**
   * M1-C：页端上报「本轮流是否见到完成哨兵」。
   *
   * 宿主据此判 `'interrupted'`（模型吐到一半断了）——**没有这条，`interrupted` 是死代码**。
   * `round` 是页端自己的本轮序号；宿主按 botId 存**最近一条**，
   * WebEngine 在轮询结束那一刻读一次（见 `WebEngineOptions.readFinishSentinel`）。
   */
  onFinishSentinel?: (info: { round: number; sawFinishSentinel: boolean; botId?: string }) => void;
  /** v1.0：宿主推送记忆列表更新时的回调。 */
  onMemoriesUpdate?: (memories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }>) => void;
  onToolResult?: (info: { callId: string; tool: string; ok: boolean; error?: string; botId?: string; details?: Record<string, unknown> }) => void;
  /** 可信页 hello 登记完成（该页可执行能力）。 */
  onConnect?: (info: { id: string; botId?: string }) => void;
  /**
   * 页端连接断开（ws close / error）观察钩子。观察者，不影响 hub 自身的 pending 失败逻辑。
   * T5：宿主据此把本侧 pendingRuns 中未完成 runId 统一标 failed / page-disconnected 并清空。
   */
  onDisconnect?: (info: { id: string; botId?: string; kind: 'close' | 'error' }) => void;
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
  /**
   * M1-C：读某个 bot 最近一条「完成哨兵」结论。
   *
   * WebEngine 在轮询结束那一刻调一次 → 判 `'interrupted'`。
   * 返回 `undefined` 表示「页端没上报过 / 不知道」——**绝不能当 `false`**。
   *
   * @param botId 目标 bot（缺省 main）
   * @param sinceMs 只接受 `at >= sinceMs` 的结论（避免读到**上一轮**的陈旧哨兵）
   */
  readFinishSentinel(botId?: string, sinceMs?: number): boolean | undefined;
  dispose(): void;
}

/** v0.24：缺省 botId（向后兼容：旧注入脚本 hello 不上报 botId → 归为 main）。 */
const MAIN_BOT_ID = 'main';

/**
 * 工具调用总超时相对审批预算的**最小余量**（2026-11-14 真机卡）。
 *
 * 现场（pid 33892 系，基线 `227bdba`）：`python.exec` 审批挂满 60s，page-runtime 的
 * tool-call 超时也是 60s ⇒ 两个计时器并列到点，`tool-call-timeout` 抢先回执。
 * 宿主审计里记的是 `consent-denied`（真实原因），模型/用户拿到的却是「超时未返回」——
 * 这句话暗示"重试可能有用"，而真相是「审批窗口没人点，重试还会再烧一次等待」。
 * 所以：**总超时必须严格大于审批预算**，让审批超时先落地、真实 reason 先回执。
 */
export const TOOL_CALL_TIMEOUT_MARGIN_MS = 30_000;

/**
 * 工具失败的**模型可行动文案**（2026-11-14 卡，判据 2）。
 *
 * 只改写"审批类"和"总超时"这三种 reason，其余原样透传（不吞错误码）。
 * 文案里保留 `（code）`，因为下游/日志仍要能 grep 到原始码，模型也仍能引用它。
 *
 * `consent-denied` 的措辞同时覆盖「用户点了拒绝」与「审批等待超时」：两者在宿主侧目前
 * 收敛为同一个 reason（`consent-queue` 超时也判 deny），写成"用户拒绝或审批等待超时"
 * 才不会在一半场景里说假话。要拆成 `consent-timeout` 得先改 `consent-timeout.test.ts`
 * 的既有期望（改口径），已报 PM 等裁定。
 */
export function describeToolFailure(
  reason: string | undefined,
  tool: string,
  toolTimeoutMs: number,
): string | undefined {
  switch (reason) {
    case 'consent-denied':
      return (
        `工具 ${tool} 需要用户审批，但本次未获批准（用户拒绝或审批等待超时）（consent-denied）。`
        + '请等待用户在审批窗口选择「允许」或「拒绝」；不要重复调用同一工具——重复调用只会再等一次审批。'
      );
    case 'consent-unavailable':
      return (
        `工具 ${tool} 需要用户审批，但当前没有可用的审批界面，已按 fail-closed 拒绝（consent-unavailable）。`
        + '请提示用户先打开 Studio 窗口并让页面就绪，再重试本操作。'
      );
    case 'tool-call-timeout':
      return (
        `工具 ${tool} 执行超过 ${Math.max(1, Math.round(toolTimeoutMs / 1000))} 秒仍未返回，宿主已放弃本次调用`
        + `（tool-call-timeout）。这不是审批问题：请先确认参数与目标可达，再决定是否重试。`
      );
    default:
      return reason;
  }
}

export function createPageRuntimeHub(options: PageRuntimeHubOptions): PageRuntimeHub {
  const path = options.path ?? '/studio';
  const dispatchTimeoutMs = options.dispatchTimeoutMs ?? 30_000;
  const consentTimeoutMs = options.consentTimeoutMs ?? 60_000;
  // C1 墨鉴 R3-8：tool-call 执行超时上限。
  // 2026-11-14：缺省值改为"严格大于审批预算"，见 TOOL_CALL_TIMEOUT_MARGIN_MS 的现场说明。
  // 显式传入的值原样使用（既有测试把超时压到毫秒级来测这条分支）。
  const toolCallTimeoutMs =
    options.toolCallTimeoutMs ?? Math.max(60_000, consentTimeoutMs + TOOL_CALL_TIMEOUT_MARGIN_MS);
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
  options.server.on('upgrade', async (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== path) return;
    // P0-2 修复：WS 连接必须校验 query token，零鉴权时任意本地进程可连工具通道。
    // QD-R2-12：接轮换环（TokenSource 函数形式）；candidates 为空 = fail-closed 拒绝。
    const url = new URL(req.url ?? '/', 'http://localhost');
    // TD-02：优先按 bootstrap grant 校验（?token= 里承载 grant 串）。
    // - grantVerifier 存在 → 验签 + 一次性消费 + aud 绑定（aud 从 ?aud= 读，UI 连接时带；
    //   缺省空串 → 跳过 aud 校验，过渡期兼容，UI 未改造时不阻断连接）；
    // - grantVerifier 缺省 → 走旧 verifyWsQueryToken（向后兼容）。
    if (options.grantVerifier) {
      const presented = url.searchParams.get('token');
      const aud = url.searchParams.get('aud') ?? '';
      let verdict: { ok: boolean; reason?: string };
      try {
        verdict = await options.grantVerifier(presented, aud);
      } catch (e) {
        verdict = { ok: false, reason: `verifier-threw: ${(e as Error).message}` };
      }
      if (!verdict.ok) {
        options.onError?.(`ws upgrade rejected: invalid bootstrap grant (${verdict.reason ?? 'unknown'}) (fail-closed)`);
        socket.destroy();
        return;
      }
      options.onError?.(`ws upgrade accepted by bootstrap grant${aud ? ` (aud=${aud})` : ' (aud unchecked)'}`);
    } else if (!verifyWsQueryToken(url.searchParams.get('token'), options.token)) {
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
  const pendingConsent = new Map<string, { ownerId: string; nonce: string; consumed: boolean; resolve: (d: ConsentDecision) => void; timer: ReturnType<typeof setTimeout> }>();
  // C1 墨鉴 R3-8：页端发来的 tool-call（反向投递的工具调用）在宿主侧是**在途请求**，
  // 原实现没有登记、没有超时、也不受 failAllPending 管辖 →
  //   ① 执行永不返回时，页端的 pending 永久悬挂；
  //   ② 页端断开时，宿主这边还在跑，结果发给一个已死的 socket（孤儿）。
  // 现在登记到 pendingToolCalls：加超时、并在 failAllPending（断连）时结算。
  const pendingToolCalls = new Map<string, { ownerId: string; timer: ReturnType<typeof setTimeout> }>();
  // M1-C：每个 bot 最近一条「完成哨兵」结论（页端上报）。
  // WebEngine 在轮询结束那一刻读一次 → 判 `'interrupted'`。
  // 没有这张表，`interrupted` 终态永远不会被触发（死代码）。
  const finishSentinels = new Map<string, { round: number; sawFinishSentinel: boolean; at: number }>();

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
    // C1 墨鉴 R3-8：页端发来的 tool-call 也在途，断连时必须一并结算（否则是孤儿）。
    for (const [id, p] of pendingToolCalls) {
      if (ownerId !== undefined && p.ownerId !== ownerId) continue;
      clearTimeout(p.timer);
      pendingToolCalls.delete(id);
    }
  }

  function safeSend(ws: WebSocket, msg: HostToPageMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    } catch (err) {      options.onError?.(`page-runtime send failed: ${msg.type}`, err);
    }
  }

  function pickClient(botId?: string): { id: string; ws: WebSocket } | null {    // v0.24：调用方给了 botId 才按 botId 路由到对应窗口的页（每窗口一个独立登录态）。
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
        // C1 墨鉴 R3-10：入站消息的**统一握手门**（前置检查，不进 if/else 链）。
        //
        // 原实现只有 `result` 与 `consent-decision` 两个分支校验 `!rec.ready || rec.untrusted`，
        // 而 `kv-get`/`kv-set`/`kv-remove`/`tool-call`/`runtime-envelope` 等**要求宿主执行动作**
        // 的消息**没有校验** → 一个连上来但从不发 hello 的本机进程，
        // 可以直接读写用户 KV 或投递工具调用（与 R2-02「ready 才算可信页」的语义矛盾）。
        //
        // 为什么是前置检查而不是 else if 分支：else if 链**只走一个分支**，
        // 放在链里会把 kv-*/tool-call 的正常处理**整个吞掉**（工具调用永远收不到回执 → 超时）。
        // 现在：在链之前拦，拦下后直接 return（不回落到任何分支）。
      } else if (REQUIRES_READY.has(msg.type) && (!rec.ready || rec.untrusted)) {
        // 未完成 hello 握手（!ready）或已被判定篡改（untrusted）→ 拒绝执行。
        // 对「需要回执」的消息回一个失败，让对端不必悬挂等一个永远不会来的结果。
        if (msg.type === 'kv-get' || msg.type === 'kv-set' || msg.type === 'kv-remove') {
          safeSend(ws, { type: 'kv-result', requestId: msg.requestId, ok: false, error: 'page-not-ready' });
        } else if (msg.type === 'tool-call') {
          safeSend(ws, { type: 'tool-call-result', callId: msg.callId, ok: false, error: 'page-not-ready' });
        }
        return;
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
      } else if (msg.type === 'finish-sentinel') {
        // M1-C：页端上报「本轮流是否见到完成哨兵」。
        // 这是 `interrupted` 终态的**唯一数据来源**——没有它，宿主无法区分
        // 「模型答完了」与「模型吐到一半断了」。
        // 按 botId 存最近一条（宿主侧读的时候取最新那条即可）。
        finishSentinels.set(rec.botId ?? 'main', {
          round: msg.round,
          sawFinishSentinel: msg.sawFinishSentinel,
          at: Date.now(),
        });
        options.onFinishSentinel?.({
          round: msg.round,
          sawFinishSentinel: msg.sawFinishSentinel,
          botId: rec.botId,
        });
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
        } else if (command === 'image_fetch') {
          // 可视化卡片专用：页端 <img> 直接加载防盗链图源会 418/反爬 HTML，
          // 由宿主带 Referer 取回并转 data: URL。SSRF/大小/类型校验都在 image-proxy 内。
          const url = (payload ?? {}) as { url?: unknown };
          const fetched = await fetchImageAsDataUrl(url.url);
          safeSend(ws, { type: 'runtime-envelope-result', requestId, response: fetched });
        } else {
          safeSend(ws, { type: 'runtime-envelope-result', requestId, response: { ok: false, error: `unknown-command: ${command}` } });
        }
      } else if (msg.type === 'consent-decision') {
        // QD-R2-03：同 result 分支——未握手/不可信连接的同意决定一律忽略；
        // 且必须是宿主发给本连接的那条 consent-required 的回执。
        if (!rec.ready || rec.untrusted) return;
        const p = pendingConsent.get(msg.callId);
        if (p && p.ownerId === id) {
          // R2-01：回执必须带回与本次 consent 绑定的 nonce（常数时间相等）+ 一次性消费。
          // 缺 nonce / nonce 不符 / 已 consumed → 忽略该回执（保持 pending，最终超时 deny）。
          // 这是「页面伪造决议被拒」的核心：伪造方即便知道 callId，也拿不出已消费的 nonce。
          if (p.consumed) return;
          if (typeof msg.nonce !== 'string' || !timingSafeEqualStr(msg.nonce, p.nonce)) return;
          p.consumed = true;
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
        // C1 墨鉴 R3-8：登记在途 tool-call —— 加超时、并在页端断开时被 failAllPending 结算。
        // 原实现没有登记也没有超时：执行永不返回时页端 pending 永久悬挂；
        // 页端断开时宿主这边还在跑，结果发给一个已死的 socket（孤儿）。
        const toolTimer = setTimeout(() => {
          if (!pendingToolCalls.delete(msg.callId)) return;
          options.onToolResult?.({ callId: msg.callId, tool: mapped.id, ok: false, error: 'tool-call-timeout', botId: callBotId });
          // 模型可见文本走 describeToolFailure（可行动 + 保留原始码）；onToolResult 留原始码给遥测/审计。
          safeSend(ws, {
            type: 'tool-call-result',
            callId: msg.callId,
            ok: false,
            error: describeToolFailure('tool-call-timeout', mapped.id, toolCallTimeoutMs),
          });
        }, toolCallTimeoutMs);
        pendingToolCalls.set(msg.callId, { ownerId: id, timer: toolTimer });
        const settleToolCall = (): boolean => {
          const p = pendingToolCalls.get(msg.callId);
          if (!p) return false;
          clearTimeout(p.timer);
          pendingToolCalls.delete(msg.callId);
          return true;
        };
        void exec(mapped.id, mapped.params, callBotId, msg.conversationId)
          .then((r) => {
            if (!settleToolCall()) return; // 已超时/已断连 → 不再回执（避免重复回执）
            options.onToolResult?.({ callId: msg.callId, tool: mapped.id, ok: r.ok, error: r.reason, botId: callBotId, ...(r.details !== undefined ? { details: r.details as Record<string, unknown> } : {}) });
            safeSend(ws, {
              type: 'tool-call-result',
              callId: msg.callId,
              ok: r.ok,
              data: r.data,
              // 模型可见文本：审批类/总超时给人话（保留原始码），其余原样透传。
              error: describeToolFailure(r.reason, mapped.id, toolCallTimeoutMs),
              // v1.2：透传 Pi Agent 风格新格式字段
              ...(r.content !== undefined ? { content: r.content } : {}),
              ...(r.details !== undefined ? { details: r.details } : {}),
              ...(r.isError !== undefined ? { isError: r.isError } : {}),
              ...(r.terminate !== undefined ? { terminate: r.terminate } : {}),
            });
          })
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            if (!settleToolCall()) return;
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
    // P2：断开路径必须留一行日志——`page-disconnected` 只是 failAllPending 的 reason 字符串，
    // 有在途 pending 才会被写出来；页端正常断开时运行时**什么都不会打**，
    // 出问题时无法取证（20261031 Verify 复验时 `logs/` 里 0 命中，只能判「证据缺失」）。
    // 记 `kind`（close/error）、`botId`、剩余可信页数、以及本次清理的在途请求数。
    /**
     * D3（账号误判链修复）：连接离开后重算账号锁。
     *
     * 原实现 `untrusted` 只粘不放 —— `clients.delete(id)` 之后没有任何一处把它改回 false。
     * 单窗口重连时（旧 socket 未断 → 新连接 hello 被判重复 → 旧 socket 随后关闭），
     * 新连接永远 untrusted → 所有宿主调用 page-not-ready
     * （真机误判现场：mcp.list 拿不到任何工具，模型只能手写裸 XML）。
     *
     * 重算规则（按 accountFingerprint 分组，**每组最多保留一条 trusted**）：
     * - 组内已有 trusted → 不解封任何 untrusted：同账号真并发两窗仍然 fail-closed，铁律不拆；
     * - 组内没有 trusted → 解封**最早创建**的那条 untrusted（Map 保持插入序），其余保持封禁。
     *
     * 为什么不是「逐个 untrusted 独立判」：组内若有两條 untrusted，逐条判会双双满足
     * 「没有其他 trusted」而同时解封 → 同指纹两条 trusted 并存，正好破了铁律。
     */
    function reevaluateAccountLocks(): void {
      const byFingerprint = new Map<
        string,
        Array<{ id: string; rec: { ws: WebSocket; untrusted: boolean; ready: boolean } }>
      >();
      for (const [cid, c] of clients.entries()) {
        if (!c.accountFingerprint) continue;
        const list = byFingerprint.get(c.accountFingerprint) ?? [];
        list.push({ id: cid, rec: c });
        byFingerprint.set(c.accountFingerprint, list);
      }
      for (const [fp, group] of byFingerprint) {
        // 组内仍有可信页 → 保持现状（重复方继续 fail-closed）。
        if (group.some((g) => !g.rec.untrusted && g.rec.ready)) continue;
        // 组内已无任何 trusted：只解封最早创建的那条（插入序），避免一次解封多条。
        const candidate = group.find((g) => g.rec.untrusted && g.rec.ready);
        if (!candidate) continue;
        candidate.rec.untrusted = false;
        safeSend(candidate.rec.ws, { type: 'account-duplicate-cleared' });
        console.log(
          `[page-runtime] account lock cleared id=${candidate.id.slice(0, 8)} fp=${fp.slice(0, 8)} ` +
            `(no trusted peer left)`,
        );
      }
    }

    const logPageGone = (kind: 'close' | 'error'): void => {
      // 注意：必须**在 failAllPending 之前**取计数，之后 pending 已被清空恒为 0。
      const pendingFailed = pendingDispatch.size + pendingConsent.size;
      failAllPending('page-disconnected', id);
      const trustedLeft = [...clients.values()].filter((c) => !c.untrusted).length;
      console.log(
        `[page-runtime] page closed id=${id.slice(0, 8)} kind=${kind} botId=${rec.botId ?? 'main'} ` +
          `trustedPages=${trustedLeft} pendingFailed=${pendingFailed}`,
      );
    };
    ws.on('close', () => {
      clients.delete(id);
      logPageGone('close');
      // D3：占位者离开后重算账号锁（重复方可能因此恢复可用）。
      reevaluateAccountLocks();
      options.onDisconnect?.({ id, botId: rec.botId, kind: 'close' });
    });
    ws.on('error', () => {
      clients.delete(id);
      logPageGone('error');
      // D3：同上（error 路径同样会让连接消失）。
      reevaluateAccountLocks();
      options.onDisconnect?.({ id, botId: rec.botId, kind: 'error' });
    });
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
    /**
     * M1-C：读某个 bot 最近一条完成哨兵结论。
     *
     * `sinceMs` 是**本轮开始时刻**——用它挡住「上一轮的陈旧哨兵」。
     * 不挡的话：上一轮正常完成（哨兵=true）会被本轮读到 → 本轮即使真被截断也判成 complete
     * （漏判）；反过来更糟——上一轮被截断（false）会让本轮正常完成被判成 interrupted（误判）。
     */
    readFinishSentinel(botId?: string, sinceMs?: number): boolean | undefined {
      const rec = finishSentinels.get(botId ?? MAIN_BOT_ID);
      if (!rec) return undefined;
      if (sinceMs !== undefined && rec.at < sinceMs) return undefined;
      return rec.sawFinishSentinel;
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
          // C1 墨鉴 R3-6：超时必须**通知页端**，否则对端 pending 永久悬挂
          // （页端还在等 result，用户看到界面卡住却等不到任何反馈）。
          // 回执形态与页端→宿主的 result 对称：ok=false + error。
          safeSend(picked.ws, { type: 'tool-call-result', callId, ok: false, error: 'page-timeout' });
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
        // R2-01：每次 consent 生成一次性 nonce，随 consent-required 下发；回执必须带回同一 nonce。
        // 页面可读到 nonce，但回执还须 ownerId 绑定 + consumed 一次性（配合 UI 的 isTrusted 点击证明）。
        const nonce = randomConsentNonce();
        const timer = setTimeout(() => {
          pendingConsent.delete(callId);
          // C1 墨鉴 R3-6/R3-7：同意超时必须**作废页端那个弹窗**。
          // 否则弹窗一直挂在屏幕上，用户还能点「同意」——但宿主已判超时拒绝，
          // 用户点了完全没反应（PM 验收点名的「还能点但点了无效」）。
          safeSend(picked.ws, { type: 'consent-abort', callId, reason: 'consent-timeout' });
          resolve('deny');
        }, consentTimeoutMs);
        pendingConsent.set(callId, { ownerId: picked.id, nonce, consumed: false, resolve, timer });
        safeSend(picked.ws, { type: 'consent-required', callId, tool, params, meta, botId, nonce });
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
