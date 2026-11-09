/**
 * 本地 HTTP API server（node:http）
 *
 * 端点：
 *   POST /v1/chat/completions   OpenAI 兼容；stream=true 走 SSE（reasoning 仅在 reasoning_content）
 *   GET  /v1/models             模型列表（需鉴权）
 *   GET  /v1/queue/status       队列状态（需鉴权）
 *   POST /v1/debug/eval         调试 JS 执行（需鉴权，且仅 STUDIO_DEBUG=1 开启）
 * 其余 /v1/* 未实现 → 501。
 *
 * 免鉴权端点（显式清单，fail-closed：未列出的一律 401）：
 *   GET  /healthz               健康检查（无敏感信息，供进程探活）
 *   GET  /agent | /agent.js | /agent.css  M1 面板静态资源（HTML 内嵌真实令牌，
 *                               威胁模型与 v0.5 一致：本地进程本就能读 config.json）
 * 鉴权缺失/错误 → 401。
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
  /**
   * 可选调用上下文。conversationId 决定同意闸门能否提供「本次对话始终允许」；
   * 缺失时闸门照旧逐次询问（不得因为缺字段而跳过审批）。
   */
  ctx?: { botId?: string; conversationId?: string },
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
import type { OfficialBackend } from './official-backend';

/**
 * MCP 服务器配置（**明文**形状）。
 *
 * 与宿主侧的 `McpServerConfig` 同形，但这里用**可选字段**表达
 * 「用户没填这一项」——编辑弹窗回填时，空值要如实表达空，不能凭空造。
 */
export interface McpServerConfigDto {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly transport?: 'stdio' | 'http' | 'sse';
  readonly url?: string;
  readonly headers?: Record<string, string>;
}

/** 一台 MCP 服务器（列表项，**明文**）。 */
export interface McpServerDto {
  readonly id: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
}

/**
 * MCP 配置读写面（宿主注入实现，API 层只做路由与鉴权）。
 *
 * 全部方法**不抛异常**：失败用 `{ ok:false, error }` 表达。
 */
export interface McpServersApi {
  /** 列全部服务器（明文）。 */
  list(): Promise<{ ok: boolean; servers?: McpServerDto[]; error?: string }>;
  /** 新增一台（id + config）。 */
  create(id: string, config: McpServerConfigDto): Promise<{ ok: boolean; error?: string }>;
  /** 改一台。 */
  update(id: string, config: McpServerConfigDto): Promise<{ ok: boolean; error?: string }>;
  /** 删一台。 */
  remove(id: string): Promise<{ ok: boolean; error?: string }>;
  /** 连通性测试；config 缺省时用已存配置。 */
  test(id: string, config?: McpServerConfigDto): Promise<{ ok: boolean; tools?: unknown[]; error?: string }>;
}

import { chunksToResponse, emptyDelta, formatSSE, isUnimplementedPath, SSE_DONE } from './compat';
import { DEEPSEEK_ORIGIN } from '../host/tool-definitions';
import {
  decideAgentAccess,
  agentAccessDeniedBody,
  clientHostOf,
} from './agent-lan-access';
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
  /**
   * 限流桶的**键数上限**（TD-12）：桶表只增不删会让长跑进程的内存无限增长。
   * 超过上限时回收最久未用的桶（LRU）。默认 10000。
   */
  maxKeys?: number;
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
  /**
   * C1 P1 安全批（(B) 方案）：MCP 服务器配置的**读写面**（工作台专用）。
   *
   * ── 为什么挂在 /v1/* 的统一 Bearer 校验之后 ──
   * ① 端点**必须**在 Bearer 闸之后（`server.ts` 的统一鉴权段），
   *    **绝不**能挂在 `/agent` 那段免鉴权路由旁边 —— 挂了整套 (B) 方案当场作废。
   * ② Bearer 是 `config.token`（与页面侧 `__studioHostToken` **同一份**），
   *    DeepSeek 页面**拿不到**它（页面上只有 WS 用的那份注入脚本变量，
   *    且模型上下文里不会有它）→ 模型够不到这条面。
   * ③ 再叠一道**回环 Origin 校验**（见下）→ 即便 token 泄漏，
   *    公网页面（chat.deepseek.com）的 Origin 也不是回环 → 拒。
   *
   * 形状与 UI 的工作台编辑器对齐（PM 定的契约）：
   *   GET    /v1/mcp/servers          → { servers:[{id,transport,command,args,env,headers,url,cwd}] }（**明文**）
   *   POST   /v1/mcp/servers          → body { id, config }
   *   PUT    /v1/mcp/servers/:id      → body { id, config }
   *   DELETE /v1/mcp/servers/:id
   *   POST   /v1/mcp/servers/:id/test → body 可选 { config }，缺省用已存配置
   */
  mcpServers?: McpServersApi;
  /** 限流与并发（默认串行 + 60/分钟）。 */
  rateLimit?: RateLimitOptions;
  /**
   * M1 智能体面板静态资源（磁盘路径）。提供后开放：
   *   GET /agent    面板 HTML（服务端把 __STUDIO_TOKEN__ 占位符替换为真实 API 令牌）
   *   GET /agent.js 面板脚本
   * 两个路由**免鉴权**：HTML 里已内嵌令牌，威胁模型与 v0.5 一致（本地进程本就能读 config.json）。
   */
  /**
   * M1 智能体面板静态资源（磁盘路径）。提供后开放：
   *   GET /agent    面板 HTML（服务端把 __STUDIO_TOKEN__ 占位符替换为真实 API 令牌）
   *   GET /agent.js 面板脚本
   * P2 追加：/agent.css、/agent.webmanifest、/agent-sw.js、/agent-icon-{192,512}.png
   */
  agentPage?: {
    htmlPath: string;
    jsPath: string;
    cssPath: string;
    /** PWA manifest（P2）。 */
    manifestPath?: string;
    /** Service Worker 脚本（P2）。 */
    swPath?: string;
    /** PWA 图标 192（P2）。 */
    icon192Path?: string;
    /** PWA 图标 512（P2）。 */
    icon512Path?: string;
  };
  /**
   * P2：/agent 的局域网访问闸门。不提供时默认只放行 loopback（与历史行为一致）。
   * 提供 lanEnabled=true 后，非 loopback 请求必须带正确配对码，否则 403 且不返回内嵌令牌的 HTML。
   */
  agentLanAccess?: {
    lanEnabled: boolean;
    pairingCode: string;
  };
  /**
   * C 卡（MCP 独立原生窗口，2026-11-06）：`/mcp-settings` 页面**壳**（磁盘路径）。
   *
   * 提供后开放：`GET /mcp-settings`（HTML）、`/mcp-settings.js`、`/mcp-settings.css`。
   *
   * ⚠️ 与 `agentPage` 的本质区别：**这一页不内嵌任何令牌**（token 由 Tauri init script
   * 注入该窗，见 `src-tauri/src/main.rs` 的 `mcp_settings_init_script`）。
   *
   * ⚠️ 路由位置（PM 2026-11-06 裁定，撤回原卡第 5 条「页面壳也在 Bearer 闸内」）：
   * 这是**物理限制**不是取舍 —— 顶层导航不带 `Authorization`，而 Tauri 2.12.2 没有
   * 给导航请求加头的钩子（`on_web_resource_request` 只改响应
   * `tauri-2.12.2/src/webview/webview_window.rs:235`；`on_navigation` 只返回 bool）
   * ⇒ 硬塞进 Bearer 闸，这个窗永远只看到 401。
   *
   * 所以「**壳里没有秘密**」是这条链唯一的安全边界，由两道收口 + 一条机器判据守着：
   *   ① 只服务回环客户端（`decideAgentAccess({lanEnabled:false})`，比 /agent 的配对码闸更紧）；
   *   ② 有 Origin 时必须是回环 Origin；
   *   ③ 机器判据：`tests/desktop/mcp-settings-window.test.ts` 扫壳 HTML/JS 产物与
   *      `/mcp-settings` 响应体，断言不含真实 token 值、不含 `config.token`、
   *      不含「把字面量赋给 `__STUDIO_TOKEN__`」的嵌入形态（附装置自检）。
   * **秘密面** `/v1/mcp/servers*` 仍在统一 Bearer 闸 + 回环 Origin 闸之内，原样未动。
   */
  mcpSettingsPage?: {
    htmlPath: string;
    jsPath: string;
    cssPath?: string;
  };
  /**
   * K2（2026-11-09）：`/consent` 页面**壳**（K1 独立审批窗里渲染的那一页）。
   *
   * 与 `mcpSettingsPage` **同型同闸**（回环客户端 + 回环 Origin + 零秘密、逐字节返回、
   * 不做模板替换），差别只有路径段：`/consent`、`/consent.js`、`/consent.css`。
   *
   * 缺省 ⇒ 该路由整体不可用（fail-closed，落到统一 Bearer 闸返回 401）。
   */
  consentWindowPage?: {
    htmlPath: string;
    jsPath: string;
    cssPath?: string;
  };
  /**
   * K2：宿主侧审批队列（由 `desktop-host` 注入）。
   *
   * 提供后开放两条端点，**都在 `/v1/*` 的统一 Bearer 闸之后**（与 MCP 数据面同闸）：
   *   - `GET  /v1/consent/pending` → `{ ok:true, pending: <view|null> }`
   *   - `POST /v1/consent/reply`   → `{ ok:true, decision }` / `{ ok:false, code }`
   *
   * ⚠️ **无请求时必须回 `200 + pending:null`，不许 204/404/500**：
   * K1 的轮询按"200 才算问到结论"判（`consent_window.rs` 的 `poll_pending`：非 200 ⇒
   * `None` ⇒ 指数退避到 5s）。回 204 会让轮询长期停在 5 秒档，空闲后的第一次审批
   * 要慢好几秒才弹窗——而且**不会让任何测试变红**（看起来一切正常）。
   */
  consentQueue?: {
    pending(): ReadonlyArray<PendingConsentEntryShape>;
    reply(input: { callId: unknown; decision: unknown; nonce: unknown }): ConsentReplyResult;
  };
}

/**
 * 待审批条目的形状（与 `src/host/consent-queue.ts` 的 `PendingConsentEntry` 结构对齐）。
 *
 * `view` 用 `unknown` 而不是 `Record<string, unknown>`：后者要求索引签名，
 * 而队列侧给的是一个**具体接口**（`PendingConsentView`）。server 对 view 只做
 * `{ ...view, nonce }` 序列化，不读字段，所以这里的类型只需要"可展开"。
 */
export interface PendingConsentEntryShape {
  readonly view: unknown;
  readonly nonce: string;
}

/** `/v1/consent/reply` 的处理结果（`server.ts` 与宿主队列共用同一份形状）。 */
export type ConsentReplyResult =
  | { readonly ok: true; readonly decision: string }
  | { readonly ok: false; readonly code: string };

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

/** 浏览器页面与请求 Host 完全同源（用于显式开启的局域网 PWA）。 */
function isSameHostOrigin(origin: string | undefined, requestHost: string | undefined): boolean {
  if (!origin || !requestHost) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host === requestHost;
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

/**
 * MCP 配置读写端的路由处理（工作台专用）。
 *
 * 契约（PM 定，UI 的工作台编辑器按此实现）：
 *   GET    /v1/mcp/servers          → { servers:[{id,transport,command,args,env,headers,url,cwd}] }（**明文**）
 *   POST   /v1/mcp/servers          → body { id, config }      新增
 *   PUT    /v1/mcp/servers/:id      → body { id, config }      改
 *   DELETE /v1/mcp/servers/:id                                删
 *   POST   /v1/mcp/servers/:id/test → body 可选 { config }，缺省用已存配置
 *
 * 鉴权：调用方**已经**过了统一 Bearer 闸与回环 Origin 闸（本函数只做路由）。
 */
async function handleMcpServersApi(
  api: McpServersApi,
  pathname: string,
  req: http.IncomingMessage,
  sendJson: (status: number, body: unknown) => void,
): Promise<void> {
  const method = req.method ?? 'GET';
  const rest = pathname.slice('/v1/mcp/servers'.length); // '' | '/:id' | '/:id/test'
  const segments = rest.split('/').filter(Boolean);

  // GET /v1/mcp/servers（列表）与 POST /v1/mcp/servers（新增）
  if (segments.length === 0) {
    if (method === 'GET') {
      const r = await api.list();
      if (!r.ok) {
        sendJson(500, { error: { code: 'mcp_list_failed', message: r.error ?? 'failed to list mcp servers' } });
        return;
      }
      sendJson(200, { servers: r.servers ?? [] });
      return;
    }
    if (method === 'POST') {
      const body = await parseConfigBody(req);
      if (!body.ok) {
        sendJson(400, { error: { code: 'bad_request', message: body.error } });
        return;
      }
      const r = await api.create(body.id, body.config);
      if (!r.ok) {
        sendJson(400, { error: { code: 'mcp_save_failed', message: r.error ?? 'failed to save mcp server' } });
        return;
      }
      sendJson(200, { ok: true, id: body.id });
      return;
    }
    sendJson(405, { error: { code: 'method_not_allowed', message: `${method} ${pathname}` } });
    return;
  }

  const id = decodeURIComponent(segments[0] ?? '');

  // POST /v1/mcp/servers/:id/test
  if (segments.length === 2 && segments[1] === 'test') {
    if (method !== 'POST') {
      sendJson(405, { error: { code: 'method_not_allowed', message: `${method} ${pathname}` } });
      return;
    }
    // body 可选：有 config 用它（用户「改了再测」），没有就用已存配置。
    let config: McpServerConfigDto | undefined;
    try {
      const raw = await readBody(req);
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as { config?: McpServerConfigDto };
        if (parsed.config && typeof parsed.config === 'object') config = parsed.config;
      }
    } catch {
      // body 解析失败 → 按「缺省用已存配置」处理（用户没改配置就不该测失败）
      config = undefined;
    }
    const r = await api.test(id, config);
    if (!r.ok) {
      sendJson(400, { error: { code: 'mcp_test_failed', message: r.error ?? 'mcp test failed' } });
      return;
    }
    sendJson(200, { ok: true, tools: r.tools ?? [] });
    return;
  }

  if (segments.length !== 1) {
    sendJson(404, { error: { code: 'not_found', message: `${method} ${pathname}` } });
    return;
  }

  // PUT /v1/mcp/servers/:id（改）
  if (method === 'PUT') {
    const body = await parseConfigBody(req);
    if (!body.ok) {
      sendJson(400, { error: { code: 'bad_request', message: body.error } });
      return;
    }
    const r = await api.update(id, body.config);
    if (!r.ok) {
      sendJson(400, { error: { code: 'mcp_save_failed', message: r.error ?? 'failed to save mcp server' } });
      return;
    }
    sendJson(200, { ok: true, id });
    return;
  }

  // DELETE /v1/mcp/servers/:id（删）
  if (method === 'DELETE') {
    const r = await api.remove(id);
    if (!r.ok) {
      sendJson(400, { error: { code: 'mcp_remove_failed', message: r.error ?? 'failed to remove mcp server' } });
      return;
    }
    sendJson(200, { ok: true, id });
    return;
  }

  sendJson(405, { error: { code: 'method_not_allowed', message: `${method} ${pathname}` } });
}

/** 解析 `{ id, config }` 请求体。 */
async function parseConfigBody(
  req: http.IncomingMessage,
): Promise<{ ok: true; id: string; config: McpServerConfigDto } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return { ok: false, error: 'failed to read body' };
  }
  let parsed: { id?: unknown; config?: unknown };
  try {
    parsed = JSON.parse(raw) as { id?: unknown; config?: unknown };
  } catch {
    return { ok: false, error: 'invalid json body' };
  }
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (!id) return { ok: false, error: 'missing id' };
  if (!parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
    return { ok: false, error: 'missing config' };
  }
  return { ok: true, id, config: parsed.config as McpServerConfigDto };
}

/** 令牌桶：每令牌（按 Bearer 值）独立限流。 */
/** 限流桶键数上限的默认值（TD-12）。 */
const RATE_LIMIT_MAX_KEYS = 10_000;

export function createRateLimiter(opts: RateLimitOptions = {}) {
  const capacity = opts.capacity ?? 60;
  const refillPerMinute = opts.refillPerMinute ?? 60;
  const maxKeys = Math.max(1, opts.maxKeys ?? RATE_LIMIT_MAX_KEYS);
  const buckets = new Map<string, { tokens: number; last: number }>();

  /**
   * 回收最久未用的桶，直到桶数回到上限内（TD-12）。
   * Map 的插入顺序即 LRU 顺序（每次取令牌都 delete+set 移到队尾）。
   */
  const evictOldest = (): void => {
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  };

  return {
    /** 取一个令牌；不足时返回需要等待的毫秒数。 */
    take(key: string): { ok: boolean; retryAfterMs: number } {
      const now = Date.now();
      const b = buckets.get(key) ?? { tokens: capacity, last: now };
      const refill = ((now - b.last) / 60_000) * refillPerMinute;
      const tokens = Math.min(capacity, b.tokens + refill);
      if (tokens < 1) {
        buckets.delete(key);
        buckets.set(key, { tokens, last: now });
        evictOldest();
        const need = (1 - tokens) / refillPerMinute;
        return { ok: false, retryAfterMs: Math.max(50, Math.ceil(need * 60_000)) };
      }
      buckets.delete(key);
      buckets.set(key, { tokens: tokens - 1, last: now });
      evictOldest();
      return { ok: true, retryAfterMs: 0 };
    },
    /** test-only：当前桶数（TD-12 的「size 有界」断言用）。 */
    size(): number {
      return buckets.size;
    },
  };
}

/** 最近执行记录，用于 /v1/queue/status 的可观测性（v0.5 5.3）。 */
const RECENT_LIMIT = 20;

/**
 * 统一的 limit 解析（TD-13 / =BUG-025）。
 *
 * 口径：`null` / 空串 / 纯空白 / 非有限数 → 缺省 `fallback`；其余取整并 clamp 到 [min, max]。
 *
 * 为什么必须统一：旧实现两处口径不同 ——
 *   audit：`Number('')` = 0 → 被 clamp 成 **1**（空串本意是"要缺省 50"）；
 *   automation：`Number('0') || 50` → **50**（而 0 按 [min,max] 应当是 1）。
 * 同一套参数在两个端点上含义不同 → 口径必须收到一个 helper 里。
 */
export function parseLimit(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function createApiServer(options: ApiServerOptions): ApiServer {
  const auth = options.authenticator ?? createBearerAuthenticator(options.config.token);
  const limiter = createRateLimiter(options.rateLimit ?? {});
  const maxConcurrent = options.rateLimit?.maxConcurrent ?? 1; // 默认串行

  let active = 0;
  let queued = 0;
  // R1-06：本实现超限即 429、不排队，queued/depth/avgWaitMs 恒为 0；
  // 单独如实累计被并发上限拒绝的请求数，避免监控把「限流拒绝」误读成「跑得慢」。
  let rejectedByConcurrency = 0;
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
      const lanPairedOrigin = options.agentLanAccess?.lanEnabled === true
        && isSameHostOrigin(origin, req.headers.host);
      if (origin && (origin === DEEPSEEK_ORIGIN || isLocalOrigin(origin) || lanPairedOrigin)) {
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
        (
          pathname === '/agent' ||
          pathname === '/agent.js' ||
          pathname === '/agent.css' ||
          // P2：PWA 附属资源。都不含令牌，但为一致起见同样过闸门——
          // 未开启局域网时非回环一律拿不到，避免把图标/manifest 当探测探针。
          pathname === '/agent.webmanifest' ||
          pathname === '/agent-sw.js' ||
          pathname === '/agent-icon-192.png' ||
          pathname === '/agent-icon-512.png'
        )
      ) {
        // P2：/agent 内嵌真实令牌。服务一旦绑到非回环地址，同局域网任何人都能
        // 拿到令牌控制 agent。因此非 loopback 请求必须过配对码闸门（fail-closed）。
        if (options.agentLanAccess) {
          const clientHost = clientHostOf(req.socket?.remoteAddress);
          const providedCode = url.searchParams.get('pair') ?? undefined;
          const decision = decideAgentAccess(options.agentLanAccess, clientHost, providedCode);
          if (!decision.allowed) {
            sendJson(403, agentAccessDeniedBody(decision));
            return;
          }
        }
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
          } else if (pathname === '/agent.webmanifest' && options.agentPage.manifestPath) {
            // PWA manifest：可被缓存（不含令牌）。
            const manifest = readFileSync(options.agentPage.manifestPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
            res.end(manifest);
          } else if (pathname === '/agent-sw.js' && options.agentPage.swPath) {
            // Service Worker 脚本：必须能被同源 GET 到，且 scope 覆盖 /agent。
            const sw = readFileSync(options.agentPage.swPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(sw);
          } else if (pathname === '/agent-icon-192.png' && options.agentPage.icon192Path) {
            const icon = readFileSync(options.agentPage.icon192Path);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
            res.end(icon);
          } else if (pathname === '/agent-icon-512.png' && options.agentPage.icon512Path) {
            const icon = readFileSync(options.agentPage.icon512Path);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
            res.end(icon);
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

      // —— C 卡（MCP 独立原生窗口）：`/mcp-settings` 页面壳 ——
      //
      // 先读「为什么它不挂在 Bearer 闸之后」。这不是图省事，是物理限制（三条都实读过）：
      //   ① 它是**顶层导航**：浏览器 / WebView2 导航不会带 `Authorization` 头；
      //   ② Tauri 2.12.2 **没有**「给导航请求加请求头」的钩子 ——
      //      `on_web_resource_request` 的签名是 `(Request<Vec<u8>>, &mut Response<..>)`，
      //      只能改**响应**（tauri-2.12.2/src/webview/webview_window.rs:235）；
      //      `on_navigation` 只返回 bool（放行/拒绝），改不了头；
      //   ③ 所以把页面壳放进 Bearer 闸 = 这个窗打开就只会看到一页 401。
      //   ⇒ 用**两道更紧的收口**替代，并用「页面本身零秘密」把风险面消掉：
      //   ① **只服务回环客户端**（走 `decideAgentAccess({lanEnabled:false})`，
      //      即「回环放行、其余一律拒」——比 `/agent` 的配对码闸更紧：开了局域网也进不来）；
      //   ② 有 Origin 时必须是**回环 Origin**（挡「本机某个网页 fetch 这一页再读它」）。
      //   秘密面在 `/v1/mcp/servers*`（下面的统一 Bearer 闸 + 回环 Origin 闸之内），
      //   本页 HTML/JS/CSS **不含令牌、不含配置**：拿不到 token 就什么都读不到。
      if (
        options.mcpSettingsPage &&
        req.method === 'GET' &&
        (pathname === '/mcp-settings' ||
          pathname === '/mcp-settings.js' ||
          pathname === '/mcp-settings.css')
      ) {
        const loopbackOnly = decideAgentAccess(
          { lanEnabled: false, pairingCode: '' },
          clientHostOf(req.socket?.remoteAddress),
          undefined,
        );
        if (!loopbackOnly.allowed) {
          sendJson(403, {
            error: { code: 'loopback_only', message: 'mcp settings page is loopback-only' },
          });
          return;
        }
        const pageOrigin = req.headers.origin;
        if (pageOrigin !== undefined && !isLocalOrigin(pageOrigin)) {
          sendJson(403, {
            error: { code: 'origin_not_allowed', message: 'mcp settings page is loopback-origin-only' },
          });
          return;
        }
        try {
          if (pathname === '/mcp-settings') {
            const html = readFileSync(options.mcpSettingsPage.htmlPath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(html);
          } else if (pathname === '/mcp-settings.css') {
            if (!options.mcpSettingsPage.cssPath) {
              sendJson(404, { error: { code: 'not_found', message: 'no mcp settings stylesheet' } });
              return;
            }
            const css = readFileSync(options.mcpSettingsPage.cssPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
            res.end(css);
          } else {
            const js = readFileSync(options.mcpSettingsPage.jsPath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(js);
          }
        } catch {
          sendJson(500, {
            error: { code: 'mcp_settings_page_missing', message: 'mcp settings page assets not built' },
          });
        }
        return;
      }

      // —— K2（2026-11-09）：`/consent` 页面壳（K1 独立审批窗内渲染那一页）——
      //
      // 与上面 `/mcp-settings` **同型同闸、逐条同理由**（顶层导航不带 Authorization、
      // Tauri 无加头钩子 ⇒ 硬塞进 Bearer 闸就永远 401）。所以这里只是把同一套
      // 「回环客户端 + 回环 Origin + 零秘密 + 逐字节返回」复制一份到 `/consent` 段。
      //
      // ⚠️ 与 MCP 壳的唯一差别：这一页**会**用注入的 token 去读 `/v1/consent/pending`
      // 与写 `/v1/consent/reply`——但 token 由 Tauri init script 注入（不在磁盘 HTML 里），
      // 所以本路由返回的字节里仍然零秘密。
      if (
        options.consentWindowPage &&
        req.method === 'GET' &&
        (pathname === '/consent' || pathname === '/consent.js' || pathname === '/consent.css')
      ) {
        const loopbackOnly = decideAgentAccess(
          { lanEnabled: false, pairingCode: '' },
          clientHostOf(req.socket?.remoteAddress),
          undefined,
        );
        if (!loopbackOnly.allowed) {
          sendJson(403, {
            error: { code: 'loopback_only', message: 'consent window page is loopback-only' },
          });
          return;
        }
        const pageOrigin = req.headers.origin;
        if (pageOrigin !== undefined && !isLocalOrigin(pageOrigin)) {
          sendJson(403, {
            error: { code: 'origin_not_allowed', message: 'consent window page is loopback-origin-only' },
          });
          return;
        }
        try {
          if (pathname === '/consent') {
            const html = readFileSync(options.consentWindowPage.htmlPath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(html);
          } else if (pathname === '/consent.css') {
            if (!options.consentWindowPage.cssPath) {
              sendJson(404, { error: { code: 'not_found', message: 'no consent window stylesheet' } });
              return;
            }
            const css = readFileSync(options.consentWindowPage.cssPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
            res.end(css);
          } else {
            const js = readFileSync(options.consentWindowPage.jsPath, 'utf8');
            res.writeHead(200, {
              'Content-Type': 'text/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(js);
          }
        } catch {
          sendJson(500, {
            error: { code: 'consent_window_page_missing', message: 'consent window page assets not built' },
          });
        }
        return;
      }

      // R1-01：/v1/debug/eval 不再豁免鉴权——「本机回环」不等于「可信」，
      // 本机任意进程都能访问回环。所有 /v1 端点统一走 Bearer 校验（fail-closed）。
      if (!auth.authenticate(req.headers['authorization'])) {
        sendJson(401, { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } });
        return;
      }

      // —— K2：宿主侧审批的两条端点（Rust 轮询 / 窗口回执）——
      //
      // 已过统一 Bearer 闸。**契约第 0 条（PM 2026-11-09 定死，两端成对）**：
      //   - 无请求 ⇒ `sendJson(200, { ok:true, pending:null })`，形照本文件既有 200 惯例；
      //   - **禁止**在非 OPTIONS 分支出现 `res.writeHead(204)`——204 在本文件只属于 CORS 预检。
      // K1 侧按「非 200 ⇒ 没问到结论 ⇒ 指数退避到 5s」判（`consent_window.rs`），
      // 回 204 会让空闲后的第一次审批慢半拍，而且不会有任何测试变红。
      if (pathname === '/v1/consent/pending' && req.method === 'GET') {
        if (!options.consentQueue) {
          sendJson(503, { error: { code: 'consent_unavailable', message: 'consent queue not wired' } });
          return;
        }
        const list = options.consentQueue.pending();
        const first = list[0];
        sendJson(200, {
          ok: true,
          // `view` 在类型上是 `unknown`（队列给的是具体接口）；展开前先断言成对象。
          // 这里只做序列化，不读字段，所以不需要更细的类型。
          pending: first
            ? { ...(first.view as Record<string, unknown>), nonce: first.nonce }
            : null,
        });
        return;
      }

      if (pathname === '/v1/consent/reply' && req.method === 'POST') {
        if (!options.consentQueue) {
          sendJson(503, { error: { code: 'consent_unavailable', message: 'consent queue not wired' } });
          return;
        }
        // 再叠一道回环 Origin（与 /v1/mcp/servers* 同口径）：即便 token 泄漏，
        // 公网页面的 Origin 也不是回环 ⇒ 拒。
        if (!isLocalOrigin(req.headers.origin)) {
          sendJson(403, {
            error: { code: 'origin_not_allowed', message: 'consent reply requires a loopback origin' },
          });
          return;
        }
        let body: unknown;
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(400, { error: { code: 'bad_json', message: 'malformed body' } });
          return;
        }
        const b = (body ?? {}) as Record<string, unknown>;
        const outcome = options.consentQueue.reply({
          callId: b.callId,
          decision: b.decision,
          nonce: b.nonce,
        });
        if (outcome.ok) {
          sendJson(200, { ok: true, decision: outcome.decision });
        } else {
          // 校验失败一律 4xx + 机器码；**请求保持挂起**，最终由超时兜底为 deny。
          const status = outcome.code === 'unknown-call' ? 404 : outcome.code === 'bad-nonce' ? 403 : 400;
          sendJson(status, { ok: false, error: { code: outcome.code } });
        }
        return;
      }

      if (pathname === '/v1/models' && req.method === 'GET') {
        const models = await options.backend.models();
        sendJson(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
        return;
      }

      // —— C1 P1 安全批（(B) 方案）：MCP 配置读写面（工作台专用）——
      //
      // 已过统一 Bearer 闸。再叠一道**回环 Origin**：
      // 工作台页的 Origin 是 http://127.0.0.1:8760（回环）；
      // DeepSeek 页面（chat.deepseek.com）**不是**回环 → 即便它拿到了 token 也连不上。
      // 这道闸堵的是「token 泄漏 + 公网页」组合。
      if (pathname === '/v1/mcp/servers' || pathname.startsWith('/v1/mcp/servers/')) {
        if (!options.mcpServers) {
          sendJson(501, { error: { code: 'not_implemented', message: 'mcp servers api not configured' } });
          return;
        }
        // 无 Origin（curl / 本机脚本）→ 放行（token 已校验）；
        // 有 Origin → 必须是回环，否则拒。
        const reqOrigin = req.headers.origin;
        if (reqOrigin !== undefined && !isLocalOrigin(reqOrigin)) {
          sendJson(403, { error: { code: 'origin_not_allowed', message: 'mcp config endpoints are loopback-only' } });
          return;
        }
        await handleMcpServersApi(options.mcpServers, pathname, req, sendJson);
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
          rejectedByConcurrency,
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
        const limit = parseLimit(url.searchParams.get('limit'), 50, 1, 500);
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
        let body: { tool?: unknown; params?: unknown; botId?: unknown; conversationId?: unknown };
        try {
          body = JSON.parse(raw) as {
            tool?: unknown;
            params?: unknown;
            botId?: unknown;
            conversationId?: unknown;
          };
        } catch {
          sendJson(400, { error: { code: 'bad_request', message: 'invalid json body' } });
          return;
        }
        if (typeof body.tool !== 'string' || body.tool.length === 0) {
          sendJson(400, { error: { code: 'bad_request', message: 'missing tool' } });
          return;
        }
        // botId / conversationId 是可选的「身份线索」：给了，同意闸门才能提供
        // 「本次对话始终允许」；没给，仍然逐次询问（不能靠缺字段绕过审批）。
        if (body.botId !== undefined && typeof body.botId !== 'string') {
          sendJson(400, { error: { code: 'bad_request', message: 'invalid botId' } });
          return;
        }
        if (body.conversationId !== undefined && typeof body.conversationId !== 'string') {
          sendJson(400, { error: { code: 'bad_request', message: 'invalid conversationId' } });
          return;
        }
        // TD-10（=BUG-023）：params 形态校验。
        // 口径（最小收口，逐工具 schema 另立卡）：
        //   ① params 必须是 plain object —— null / 数组 / 字符串 / 数字一律 400；
        //   ② params 序列化体积上限 1MB（独立于 body 的 10MB 上限）→ 400。
        // 校验前**不**进 toolExecutor（不能把畸形参数递给执行器）。
        if (body.params !== undefined) {
          const p = body.params;
          const isPlainObject = typeof p === 'object' && p !== null && !Array.isArray(p);
          if (!isPlainObject) {
            sendJson(400, {
              error: { code: 'bad_request', message: 'invalid params: expected a plain object' },
            });
            return;
          }
          let paramsBytes: number;
          try {
            paramsBytes = Buffer.byteLength(JSON.stringify(p), 'utf8');
          } catch {
            // 序列化不了（循环引用等）→ 按超限处理。
            paramsBytes = MAX_EXECUTE_PARAMS_BYTES + 1;
          }
          if (paramsBytes > MAX_EXECUTE_PARAMS_BYTES) {
            sendJson(400, {
              error: {
                code: 'bad_request',
                message: `params too large (max ${MAX_EXECUTE_PARAMS_BYTES} bytes)`,
              },
            });
            return;
          }
        }
        const ctx: { botId?: string; conversationId?: string } = {};
        if (typeof body.botId === 'string' && body.botId !== '') ctx.botId = body.botId;
        if (typeof body.conversationId === 'string' && body.conversationId !== '') {
          ctx.conversationId = body.conversationId;
        }
        const result = await options.toolExecutor(body.tool, body.params ?? {}, ctx);
        sendJson(200, result);
        return;
      }

      // 调试端点：让网页执行 JS。R1-01：除统一 Bearer 鉴权外，还须显式 STUDIO_DEBUG=1 开启，
      // 默认关闭，避免成为常驻的任意 JS 执行面。
      if (pathname === '/v1/debug/eval' && req.method === 'POST') {
        const debugEnabled = process.env.STUDIO_DEBUG === '1' || process.env.STUDIO_DEBUG === 'true';
        if (!options.debugEval || !debugEnabled) {
          sendJson(501, { error: { code: 'not_implemented', message: 'debugEval disabled (configure debugEval and set STUDIO_DEBUG=1)' } });
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
        const limit = parseLimit(url.searchParams.get('limit'), 50, 1, 500);
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
        // 5.2 并发上限：默认串行（maxConcurrent=1），避免高频触发上游风控。
        // fail-closed 不排队：超限直接 429，并如实累计拒绝数（R1-06）。
        if (active >= maxConcurrent) {
          rejectedByConcurrency += 1;
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
          // R1-04：客户端中途断开（关页面/断网）必须中止上游生成，否则 for-await 不中断、
          // 白耗配额并占死 maxConcurrent=1 的唯一并发位，后续请求全部 429。
          const ac = new AbortController();
          // 客户端中途断开（关页面/断网/主动 destroy）在不同 Node 版本落在不同事件上，
          // 全部挂上：req.close/aborted、res.close/aborted、底层 socket close。
          // 客户端中途断开（关页面/断网/主动 destroy）在不同 Node 版本落在不同事件上，
          // req.close/aborted、res.close/aborted、底层 socket close 都挂上，任一触发即中止上游。
          const onClose = (): void => ac.abort();
          req.on('close', onClose);
          req.on('aborted', onClose);
          res.on('close', onClose);
          res.on('aborted', onClose);
          req.socket?.on('close', onClose);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          // 所有写入前判 writableEnded/destroyed：断开后再 write 会抛 ERR_STREAM_DESTROYED，
          // catch 内二次 write 会冒泡成对已结束响应 sendJson（write after end）。
          const safeWrite = (chunk: string): void => {
            if (!res.writableEnded && !res.destroyed) res.write(chunk);
          };
          let ok = true;
          try {
            for await (const c of options.backend.chatCompletion(request, ac.signal)) {
              safeWrite(formatSSE(c));
            }
            safeWrite(formatSSE(emptyDelta(request.model)));
            safeWrite(SSE_DONE);
          } catch (err) {
            ok = false;
            if (!ac.signal.aborted) safeWrite(formatSSE(errorChunk(String(err))));
          } finally {
            req.removeListener('close', onClose);
            req.removeListener('aborted', onClose);
            res.removeListener('close', onClose);
            res.removeListener('aborted', onClose);
            req.socket?.removeListener('close', onClose);
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
      //
      // BUG-024：body 超限/超时分支已经 req.destroy() 把连接断了，
      // 这里再补发 500 会和 destroy 抢同一个 socket —— 客户端反而能收到一个"正常"响应，
      // 挂起问题原样保留（而且响应还是错的语义）。连接已断 → 不再补发。
      if (!req.destroyed && !res.destroyed && !res.writableEnded) {
        sendJson(500, { error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } });
      }
    }
  });

  // F-1（2026-11-09）：**未就绪时不给出任何"看起来合法"的 URL**。
  //
  // 原实现把初值写成 `http://${host}:${config.port}`：`port=0`（测试/随机端口）时
  // 它是一个**语法合法、实际不可用**的地址，调用方 `fetch` 只会拿到 `bad port`，
  // 而不是一句"服务还没就绪"。这与本文件 `L1312-1318` 自己立的原则相反——
  // 那一段把**端口面**做成了 fail-visible（EADDRINUSE 明确报错、不静默换端口），
  // 却在**URL 面**留了个 fail-silent：拿不到地址也照样 `resolve()` 并交出一个坏 URL。
  //
  // 现在：`null` ＝ 未就绪；读 `url` 直接抛，错误信息点名原因。
  let resolvedUrl: string | null = null;

  return {
    get url() {
      if (resolvedUrl === null) {
        throw new Error(
          `本地 HTTP API 地址尚未就绪（host=${options.config.host} port=${options.config.port}）：` +
            'start() 尚未完成，或 listen 回调里 server.address() 未取到端口。' +
            '本进程不会交出一个"看起来合法、实际不可用"的地址（如 :0），请 await start() 后再读 url。',
        );
      }
      return resolvedUrl;
    },
    get rawServer() {
      return server;
    },
    start() {
      return new Promise((resolve, reject) => {
        // W9：EADDRINUSE 明确报错，不做静默换端口。
        // 静默换端口会让 main.rs / 页端按 config.json 的旧 wsUrl 连到不存在的地址，
        // 静默失败比明确失败更糟，因此这里只结构化报错并 reject，退出码由 main.ts 决定。
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            const detailed = new Error(
              `端口 ${options.config.port}（host=${options.config.host}）已被占用，无法绑定。` +
                '本进程不自动换端口（避免聊天室按旧 wsUrl 连到不存在的地址）。' +
                '请关闭占用该端口的进程，或在配置文件中修改 port 后重启。',
            ) as Error & {
              code: string;
              eaddrHost: string;
              eaddrPort: number;
            };
            detailed.code = 'EADDRINUSE';
            detailed.eaddrHost = options.config.host;
            detailed.eaddrPort = options.config.port;
            reject(detailed);
            return;
          }
          reject(err);
        };
        server.once('error', onError);
        server.listen(options.config.port, options.config.host, () => {
          server.off('error', onError);
          const addr = server.address();
          // F-1：**取不到地址必须报错，不许 `resolve()` 之后把 `:0` 交给调用方。**
          // `address()` 在 listen 成功后返回对象；返回 `null`/字符串意味着绑定态未就绪
          // （例如被测试桩替换、或运行时异常态）——那一刻端口未知，而"未知"绝不能
          // 变成一个可用的 URL。调用方 `await start()` 会拿到明确错误，而不是稍后 `bad port`。
          if (!addr || typeof addr !== 'object') {
            reject(
              new Error(
                `本地 HTTP API 绑定后未能取到端口（host=${options.config.host} port=${options.config.port}）：` +
                  `listen 回调里 server.address() 返回 ${addr === null ? 'null' : typeof addr}。` +
                  '本进程不交出不存在的地址（与 EADDRINUSE 同一条 fail-visible 原则）。',
              ),
            );
            return;
          }
          resolvedUrl = `http://${options.config.host}:${addr.port}`;
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
/** /v1/tools/execute 的 params 序列化体积上限（TD-10）：1MB。 */
const MAX_EXECUTE_PARAMS_BYTES = 1024 * 1024;
const READ_BODY_TIMEOUT_MS = 30_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // BUG-024：超时同样要断连接（否则客户端继续写、连接悬挂）。
      req.destroy();
      reject(new Error('read body timeout'));
    }, READ_BODY_TIMEOUT_MS);

    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        clearTimeout(timer);
        // BUG-024：超限时必须 destroy 连接 —— 原来只是 reject，
        // 服务端继续收、客户端继续写，连接一直悬挂（客户端要写完 10MB+ 才断）。
        req.destroy();
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
