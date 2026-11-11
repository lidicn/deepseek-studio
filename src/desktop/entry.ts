/**
 * 注入入口（initialization_script）
 *
 * 在 document_start 按顺序装配：
 *   1. installDirectBridge()     —— content↔注入脚本 同域直连桥（消除 postMessage 伪造面）
 *   2. bootstrapInjection()      —— 按白名单启动能力模块，接管资源管理
 *   3. createHostClient()        —— 连接常驻宿主 ws 通道，承接工具派发与同意闸门
 * 并把装配结果挂到 window.__deepseekStudio，供宿主/调试读取。
 *
 * v0.4：能力集默认含 echo + chat-read/insert/send；宿主客户端仅在浏览器环境自动连接
 * （node 测试环境无 document，不连接，避免挂起）。
 */

import { installDirectBridge, type InstalledBridge } from '../inject/bridge-install';
import { bootstrapInjection } from '../inject/loader';
import type { ContentCapabilityController, ReplaceContentDocumentLifecycle } from '../inject/types';
import { createEchoCapability } from '../capabilities/echo';
import { createChatReadCapability } from '../capabilities/chat-read';
import { createChatInsertCapability } from '../capabilities/chat-insert';
import { createChatSendCapability } from '../capabilities/chat-send';
import { createHostClient, type HostClient } from './host-client';
import {
  acquireGrant,
  GRANT_FALLBACK_BARE_URL_CAUSE,
  GRANT_RATE_LIMITED_RETRY_MS,
  GRANT_REPLY_SHAPE_VIOLATION_CAUSE,
  type GrantError,
} from './grant-acquire';
import { installMainWorldInterceptor, setInterceptorTraceSink, configureMemorySelect } from '../inject/main-world-interceptor';
import { installTraceReportHandle } from '../inject/main-world-interceptor';
import {
  initSkillPopup,
  setSkillPopupRefreshHandler,
  setSkillPopupSkills,
  type SkillPopupItem,
} from '../inject/skill-popup';
import { globalEvents, globalState } from '../ui/studio-ui-core';
import { createChatRoom, type ChatRoomRuntimeConfig } from '../ui/studio-chat-room';
import { installStudioSettingsEntry } from '../ui/studio-settings-entry';
import { createStudioChatUI, type StudioChatUIHandle } from '../ui/studio-chat-ui';
import { createStudioExecutionStore } from '../ui/studio-execution-store';
import { normalizeSessionKeyFromPathname } from '../shared/studio-execution';
import { createNavigationObserver } from '../inject/navigation';
import { freezeStudioObject, startIntegrityProbe } from './integrity';
import type { ExecutableCapability } from '../capabilities/types';
import { checkUpdate, isUpdateSkipped, showUpdateCard, type TauriInternals } from '../ui/update-card';

const DEFAULT_HOST_URL = 'ws://127.0.0.1:8760/studio';

/**
 * TD-02：由 bootstrap grant 构造宿主 WS URL。
 *
 * - 有 grant：`?token=<grant>&aud=<aud>`——`?token=` 键名沿用（host 按值类型走 verifyGrant），
 *   `aud` 与 Rust 注入侧逐字对齐（主窗 `main`，bot 窗 `bot:<id>`，见 main.rs:load_host_grant_script）；
 * - 无 grant：裸 URL 回退——**仅 dev** 允许（生产无 grant 即拒，设计稿 §6 fail-closed）。
 *
 * 导出纯函数以便单测锁定 aud 对齐（别让页端/宿主两处 aud 口径漂移）。
 */
/** WS `?aud=` 与 Rust 签发口径的**唯一**页端来源（main 窗 `main`、bot 窗 `bot:<id>`，
 *  与 main.rs:issue_bootstrap_grant_rs 的 audience 逐字一致）。 */
export function hostAudience(botId: string): string {
  return botId === 'main' ? 'main' : `bot:${botId}`;
}

export function resolveHostUrl(
  bootstrapGrant: string | undefined,
  botId: string,
  fallback: string = DEFAULT_HOST_URL,
): string {
  const aud = hostAudience(botId);
  return bootstrapGrant
    ? `${fallback}?token=${encodeURIComponent(bootstrapGrant)}&aud=${encodeURIComponent(aud)}`
    : fallback;
}

/**
 * 裁定三十二 fail-visible：取券状态横幅（仅主窗非登录页挂载）。
 * 退避期「正在等待宿主就绪…」/ 失败「宿主凭据不可用」——**静默裸连判红**（台账 §七 负控）。
 */
const GRANT_BANNER_CSS =
  'position:fixed;right:12px;bottom:12px;z-index:2147483646;max-width:340px;padding:8px 12px;' +
  'font:12px/1.5 system-ui,-apple-system,sans-serif;color:#5b4300;background:#fff8e1;' +
  'border:1px solid #f0c36d;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);';

/**
 * 取券状态横幅（裁定三十二 fail-visible + 裁定五十七 缺陷③ 页面侧腿）。
 *
 * 抽成独立工厂以便单测（jsdom 下直接断言「横幅真的挂到 document.body」）：
 *   - 退避期「正在等待宿主就绪…」；失败「宿主凭据不可用，agent 能力离线（原因：…）」；
 *   - **静默裸连判红**（台账 §七 负控）——调用方（`surfaceGrantFailure`）保证失败必挂横幅。
 * 仅主窗非登录页 `enabled`（`installStudio` 传入），其余形态不挂、不影响装配。
 * `data-studio-grant-banner` 属性 = 页端可 grep 的 DOM 标记（CDP/Verify 可直接查）。
 */
export interface GrantBanner {
  setBanner(message: string | null): void;
  /** 当前横幅元素（null = 未挂 / 已移除）。供测试与取证。 */
  el(): HTMLElement | null;
}

export function createGrantBanner(opts: {
  enabled: boolean;
  getMount: () => HTMLElement | DocumentFragment | null;
}): GrantBanner {
  const ref: { el: HTMLElement | null } = { el: null };
  return {
    setBanner(message: string | null): void {
      if (!opts.enabled) return;
      let el = ref.el;
      if (!message) {
        el?.remove();
        ref.el = null;
        return;
      }
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = GRANT_BANNER_CSS;
        el.setAttribute('data-studio-grant-banner', '1');
        opts.getMount()?.appendChild(el);
        ref.el = el;
      }
      if (el.textContent !== message) el.textContent = message;
    },
    el: () => ref.el,
  };
}

/** 页端可 grep 痕迹（裁定五十七 缺陷③）：宿主侧结构上拿不到 ACL/IPC 层拒绝，改在页端留痕。
 * 裁定五十七 0.14.9 判别仪（PM 裁）：`stage` 把「只能真机暴露」的缺陷变成 CDP 直读一次四选一——
 *   无痕（undefined）= 注入脚本没跑；'init' = 跑了但 connect() 没被调（**另一缺陷，不归 ACL**）；
 *   'resolver-invoked' + failed:true + cause = ACL/IPC 拒绝；'resolver-invoked' + failed:false = 通。 */
type GrantStage = 'init' | 'resolver-invoked';
type GrantStatus =
  | { stage: GrantStage; aud: string; ts: number }
  | { stage: 'resolver-invoked'; failed: false; aud: string; ts: number }
  | { stage: 'resolver-invoked'; failed: true; aud: string; lastError: GrantError | null; cause: string | null; ts: number };

function setGrantStatus(status: GrantStatus): void {
  (globalThis as { __studioGrantStatus?: unknown }).__studioGrantStatus = status;
}

/**
 * 取券失败 → fail-visible（横幅 + 页端可 grep 痕迹）。裁定五十七 缺陷③ 页面侧那条腿 +
 * 裁定五十八 回落裸连 cause 契约：
 *  - 横幅必须带**真实原因**（`cause`），不许只写「不可用」。`cause` 两种形态（CDP 直读三选一）：
 *    ① 闭包抛错/形状违例 = IPC/ACL 原文（如 `Command … not allowed by ACL`）⇒ 缺陷① 未修；
 *    ② 回落裸连 = 稳定字面量 `GRANT_FALLBACK_BARE_URL_CAUSE`（与 Core 侧 `absent` 成对）⇒ ACL 已修、取券失败致裸连；
 *  - 页端留 `window.__studioGrantStatus`（CDP/Verify 直读）+ `console.error`（页端控制台可 grep）；
 *  - `host-down` / 不可重试枚举 = **停止不重试**（语义不变），但**停止必须可见**。
 */
export function surfaceGrantFailure(
  result: { grant: string | null; attempts: number; lastError?: GrantError; cause?: string; retryAfterMs?: number },
  aud: string,
  setBanner: (message: string | null) => void,
): void {
  const lastError = result.lastError ?? 'unknown';
  // 2026-11-11 设计变更（PM 裁定）：rate-limited 从「终局」改成「冷却」——
  // 文案必须与**真实行为**一致（当次不做毫秒重试、由调用方在 ≥30s 后单次重试），
  // 不许再写「已停止」（那正是「页面通道永久断」的误导来源）。
  const stopNote =
    result.lastError === 'rate-limited'
      ? `宿主限流（冷却中），${GRANT_RATE_LIMITED_RETRY_MS / 1000} 秒后自动重试一次`
      : result.lastError === 'no-config'
        ? '重试预算耗尽，已停止'
        : '已停止（不可重试）';
  // 裁定五十八：cause 有**三形态**，横幅文案逐形互异（否则 0.14.9 现场分不清）：
  //   - ① 回落裸连（`cause === grant-fallback-bare-url`，与宿主 `absent` 成对）→「非 ACL、没拿到券所以裸连」；
  //   - ② 形状违例（`cause === grant-reply-shape-violation`）→「宿主/页端版本不配对」；
  //   - ③ 闭包抛错（`cause` = IPC/ACL 原文，如 `not allowed by ACL`）→ 缺陷① 未修的可读信号。
  const causeNote = result.cause
    ? result.cause === GRANT_FALLBACK_BARE_URL_CAUSE
      ? `；回落裸连（无券裸 URL、宿主判 absent 拒绝、非 ACL）：${result.cause}`
      : result.cause === GRANT_REPLY_SHAPE_VIOLATION_CAUSE
        ? `；取券闭包返回形状违例（宿主/页端版本不配对，先核宿主版本）：${result.cause}`
        : `；取券闭包抛错（IPC/ACL 层拒绝原文）：${result.cause}`
    : '';
  const message = `宿主凭据不可用，agent 能力离线（原因：${lastError}${causeNote}）。${stopNote}。`;
  setBanner(message);
  // 失败必发生在 resolver 阶段（本函数只由 urlResolver 链调用）：stage 钉 'resolver-invoked'（判别仪第 3 选）。
  setGrantStatus({ stage: 'resolver-invoked', failed: true, aud, lastError: result.lastError ?? null, cause: result.cause ?? null, ts: Date.now() });
  console.error(`[studio-grant] ${message}`);
}

/**
 * W2（20261023 用户定调的窗口设计）：主窗口 = 主 bot。
 * bot 窗口**不在启动时建**，只在主 bot 真正进入聊天室时按成员按需拉起。
 *
 * 为什么挂在 show() 上：ChatRoomHandle 只有 show/hide/toggle 三个入口，
 * show 就是「主 bot 开始用聊天室」这一刻。只拉一次（首个 show 之后不再重复），
 * 非 Tauri 环境（浏览器/测试桩）静默跳过，不影响既有装配。
 */
function wireChatRoomBotWindows(chatRoom: { show: () => void }, members: readonly string[]): void {
  const internals = (globalThis as {
    __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => unknown };
  }).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    console.warn('[StudioUI] bot windows skipped: not running under Tauri');
    return;
  }
  const originalShow = chatRoom.show.bind(chatRoom);
  let opened = false;
  const openMembers = (): void => {
    if (opened) return;
    opened = true;
    for (const botId of members) {
      try {
        void internals.invoke?.('open_bot_window', { botId });
      } catch (e) {
        console.warn(`[StudioUI] open_bot_window failed for ${botId}`, e);
      }
    }
  };
  chatRoom.show = () => {
    originalShow();
    openMembers();
  };
  (globalThis as { __studioOpenRoomBots?: () => void }).__studioOpenRoomBots = openMembers;
}

export interface InstallStudioOptions {
  capabilities?: readonly ContentCapabilityController[];
  originWhitelist?: string[];
  sessionId?: string;
  lifecycleFactory?: ReplaceContentDocumentLifecycle;
  reportError?: (message: string, error?: unknown) => void;
  /** 宿主 ws 地址（默认 ws://127.0.0.1:8756/studio）。 */
  hostUrl?: string;
  /** v0.24：本页所属 botId。缺省读 window.__studioBotId（Tauri 注入），再缺省 undefined → main。 */
  botId?: string;
  /**
   * 是否把 window.__deepseekStudio 钉死为不可写不可配置（默认 false）。
   * 默认关闭：同 world 脚本绕得开，而钉死会破坏合法的重新装配与测试清理。
   */
  freezeStudio?: boolean;
  /** 完整性探测周期（毫秒），默认 5000。 */
  integrityIntervalMs?: number;
}

export interface InstalledStudio {
  readonly bridge: InstalledBridge;
  readonly origin: string;
  readonly sessionId: string;
  readonly host?: HostClient;
}

function defaultCapabilities(): ContentCapabilityController[] {
  return [
    createEchoCapability(),
    createChatReadCapability(),
    createChatInsertCapability(),
    createChatSendCapability(),
  ];
}

function dedupeById(caps: ContentCapabilityController[]): ContentCapabilityController[] {
  const seen = new Set<string>();
  const out: ContentCapabilityController[] = [];
  for (const c of caps) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

export function installStudio(options: InstallStudioOptions = {}): InstalledStudio {
  const origin =
    (globalThis as { location?: { origin?: string } }).location?.origin ?? 'https://chat.deepseek.com';
  const sessionId = options.sessionId ?? crypto.randomUUID();

  // v0.24：读 Tauri 注入的 __studioBotId（隐藏窗口各自不同）；缺省 undefined → main。
  const botId = options.botId ?? (globalThis as { __studioBotId?: string }).__studioBotId ?? 'main';

  // v0.7：先建 host client（不 connect），再装直连桥。
  // 注：桌面版 host-client 走 WebSocket（sendEnvelope → ws），不经 chrome.runtime。
  // 不装 chromeShims——DeepSeek 反爬会检测 window.chrome 判定扩展环境拒登（见 v0.29 修复）。
  const capabilities = dedupeById([...defaultCapabilities(), ...(options.capabilities ?? [])]);
  const executable = capabilities as unknown as ExecutableCapability[];
  // TD-02 + P0 卡 (A) 页端半（2026-11-06 裁定四十一）：每次连接/重连前**现取**宿主 URL
  // （Rust 注入闭包 `__studioRequestGrant` 现签 60s/一次性/绑 aud 的 grant；不试旧券、不缓存）。
  // 静态 `__studioGrant`（旧构建/dev 注入）只作为 fallbackUrl 保留；闭包缺失（dev 形态）时
  // acquireGrant 立即回落（零等待、零提示），行为与改前逐位一致。
  // 回落路径必须 fail-visible（裁定三十二）：取券耗尽/不可重试 → 主窗可见横幅，静默裸连判红。
  const bootstrapGrant = (globalThis as { __studioGrant?: string }).__studioGrant;
  const fallbackUrl = options.hostUrl ?? resolveHostUrl(bootstrapGrant, botId);
  const aud = hostAudience(botId);
  const locationPathname = typeof location !== 'undefined' ? location.pathname : '';
  const isLoginPage = locationPathname.includes('/login') || locationPathname.includes('/signin');
  const bannerEnabled =
    typeof globalThis.document !== 'undefined' && botId === 'main' && !isLoginPage;
  const setGrantBanner = createGrantBanner({
    enabled: bannerEnabled,
    getMount: () => (typeof document !== 'undefined' ? (document.body ?? document.documentElement) : null),
  }).setBanner;
  // 判别仪（第 1/2 选）：取券 bootstrap 一开始就把痕迹钉 'init'——
  // CDP 之后若仍停在 'init'（resolver 从未被调）= connect() 没被调 = 另一缺陷，不归给 ACL。
  setGrantStatus({ stage: 'init', aud, ts: Date.now() });
  // 2026-11-11 设计变更（PM 裁定）：`rate-limited` 从「终局」改成「冷却」——
  // 页端拿到 `retryAfterMs`（30s）后**单次**重连；**整页生命周期内只重试一次**（不是循环重试：
  // 宿主限流若一直不放行，循环只会把页面变成限流放大器）。第二次仍被限流就停在可见失败态，
  // 由用户手动重连/刷新（那条路本来就通：`onclose → scheduleReconnect` 每轮都现取新券）。
  let rateLimitedRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let rateLimitedRetried = false;
  const scheduleRateLimitedRetry = (retryAfterMs: number): void => {
    if (rateLimitedRetried || rateLimitedRetryTimer !== null) return;
    rateLimitedRetryTimer = setTimeout(() => {
      rateLimitedRetryTimer = null;
      rateLimitedRetried = true;
      // `connect()` 只开新一轮「取券 → 开 WS」（host-client 内部 `roundActive` 守卫挡重叠轮）；
      // 冷却已过 30s，这一轮拿到的就是新券。
      try {
        host.connect();
      } catch (error) {
        options.reportError?.('rate-limited retry failed', error);
      }
    }, retryAfterMs);
  };

  const host = createHostClient({
    url: fallbackUrl,
    urlResolver: (): Promise<string> => {
      // 判别仪（第 3 选前置）：resolver 入口（connect/重连真调到）钉 'resolver-invoked'。
      setGrantStatus({ stage: 'resolver-invoked', aud, ts: Date.now() });
      return acquireGrant({
        aud,
        onState: (state) => {
          // 裁定三十六：退避期间必须可见（「正在等待宿主就绪…」），不许静默等 15s
          if (state === 'start') setGrantBanner('正在等待宿主就绪…（获取连接凭据）');
        },
      }).then((r) => {
        if (r.grant) {
          setGrantBanner(null);
          // 成功（判别仪第 4 选）：刷新页端标记为成功态（stage 钉 resolver-invoked），避免残留旧失败痕迹误导取证。
          setGrantStatus({ stage: 'resolver-invoked', failed: false, aud, ts: Date.now() });
          // 冷却重试已排上但这一轮先通了 → 撤掉（否则 30s 后会平白多开一轮）。
          if (rateLimitedRetryTimer !== null) {
            clearTimeout(rateLimitedRetryTimer);
            rateLimitedRetryTimer = null;
          }
          return resolveHostUrl(r.grant, botId, fallbackUrl);
        }
        if (r.attempts > 0) {
          // attempts>0 = 真进过按需取券且回落：横幅带**真实原因**（cause，如 ACL 拒绝原文）
          // + 页端可 grep 痕迹（window.__studioGrantStatus + console.error）——裁定五十七 缺陷③ 页面侧腿。
          surfaceGrantFailure(r, aud, setGrantBanner);
          // 2026-11-11 设计变更：限流是冷却不是终局 → 排一次 30s 后的重连（单次，见上）。
          if (r.retryAfterMs !== undefined) scheduleRateLimitedRetry(r.retryAfterMs);
        }
        // dev 形态（attempts===0）：不提示——裸连在 dev 是合法形态（设计稿 §6 fail-closed 只约束生产）。
        return fallbackUrl;
      });
    },
    capabilities: executable,
    reportError: options.reportError,
    botId,
  });

  const bridge = installDirectBridge({ origin, sessionId, reportError: options.reportError });

  bootstrapInjection({
    capabilities,
    originWhitelist: options.originWhitelist,
    lifecycleFactory: options.lifecycleFactory,
    strictInstallOrder: false,
  });

  if (typeof globalThis.document !== 'undefined') host.connect();

  // v0.6：挂载薄 MAIN-world 拦截器（解析模型工具调用 → 经宿主真实执行 → 结果回注）。
  // 即便宿主未连接，拦截器也照常安装（tool-call 会在无连接时由 host-client fail-closed 处理），
  // 避免「没连上宿主就不拦截」导致页面直接把原始 XML 工具标签暴露给用户。
  //
  // v0.27：bot 窗口（botId !== 'main'）是纯 DeepSeek 操作窗口——只保留桥接+拦截器，
  // 跳过 chat overlay 与 sidebar UI，避免遮挡 DeepSeek 登录框/输入框。
  const isBotWindow = botId !== 'main';
  let chatUI: StudioChatUIHandle | undefined;
  if (typeof globalThis.document !== 'undefined') {
    // W1：主窗口暴露 Tauri 工作台/聚焦入口。调用时求值（document_start 时
    // __TAURI_INTERNALS__ 可能尚未就绪）；非 Tauri 环境只 warn，不抛异常、不影响既有装配。
    if (!isBotWindow) {
      const g = globalThis as {
        __studioOpenWorkbench?: () => void;
        __studioOpenMcpSettings?: () => void;
        __studioFocusMain?: () => void;
      };
      g.__studioOpenWorkbench = () => {
        try {
          const internals = (globalThis as {
            __TAURI_INTERNALS__?: { invoke?: (cmd: string) => unknown };
          }).__TAURI_INTERNALS__;
          internals?.invoke?.('open_workbench');
        } catch {
          console.warn('[StudioUI] open_workbench unavailable (not running under Tauri)');
        }
      };
      // 卡 C 页端半（2026-11-06）：接 Core Rust 注入的 `__studioOpenMcpSettings` 闭包
      // （调 Tauri 命令 `studio_open_mcp_settings`，开 `/mcp-settings` 独立 webview 窗）。
      // 「缺失才补」：**仅当** Rust 侧未注入该闭包时（旧构建 / dev / 注入未就位）才顶上兜底闭包，
      // 绝不覆盖 Rust 注入版（防双定义打架——谁后写谁覆盖，会让 Core 的注入失效）。
      // 兜底闭包：先 invoke 新命令；reject（旧构建命令不存在）→ 回落**既有** `open_workbench`。
      // invoke 返回 Promise，两处都必须 `.catch`，否则 unhandled rejection（第 9 次闸红同族）。
      if (typeof g.__studioOpenMcpSettings !== 'function') {
        g.__studioOpenMcpSettings = () => {
          const internals = (globalThis as {
            __TAURI_INTERNALS__?: { invoke?: (cmd: string) => Promise<unknown> | unknown };
          }).__TAURI_INTERNALS__;
          // fire-and-forget：吞掉 reject，不产生 unhandled rejection。
          const fireForget = (cmd: string): void => {
            try {
              const p = internals?.invoke?.(cmd);
              const m = p as { catch?: (onRejected?: (e: unknown) => void) => unknown } | undefined;
              if (m && typeof m.catch === 'function') m.catch(() => { /* 已吞 */ });
            } catch {
              console.warn(`[StudioUI] ${cmd} unavailable (not running under Tauri)`);
            }
          };
          try {
            const p = internals?.invoke?.('studio_open_mcp_settings');
            const m = p as { catch?: (onRejected?: (e: unknown) => void) => unknown } | undefined;
            if (m && typeof m.catch === 'function') {
              // 新命令的 Promise：reject（旧构建 / 命令未实现）→ 回落既有工作台入口（明文仍只在工作台可见）。
              m.catch(() => { fireForget('open_workbench'); });
            }
          } catch {
            fireForget('open_workbench');
          }
        };
      }
      g.__studioFocusMain = () => {
        try {
          const internals = (globalThis as {
            __TAURI_INTERNALS__?: { invoke?: (cmd: string) => unknown };
          }).__TAURI_INTERNALS__;
          internals?.invoke?.('focus_main_window');
        } catch {
          console.warn('[StudioUI] focus_main_window unavailable (not running under Tauri)');
        }
      };
      // TD-updater（UI 接线）：页端在启动 +60s 后触发 updater_check。
      // 与 Rust 侧 spawn_startup_check 共用**进程内一次性缓存**（updater.rs）：
      //   - 首次调用才真正打 GitHub API；之后（含本处 60s 那次）全部走缓存，零额外 API；
      //   - null = 无更新 / 检查失败 / 网络错误（fail-safe）→ 不弹任何提示；
      //   - check 进行中的窗口期可能读到 null → 5s 间隔再试至多 5 次（全缓存命中），仍 null 就静默收工。
      // 「下次再说」过同版本（localStorage studio.update.skipVersion）→ 不弹。
      const scheduleUpdateCheck = (): void => {
        const g2 = globalThis as { __studioUpdateCheckScheduled?: boolean };
        if (g2.__studioUpdateCheckScheduled) return;
        g2.__studioUpdateCheckScheduled = true;
        const attempt = (n: number): void => {
          try {
            const internals = (globalThis as {
              __TAURI_INTERNALS__?: TauriInternals;
            }).__TAURI_INTERNALS__;
            if (!internals?.invoke) return; // 非 Tauri 环境：静默跳过
            void checkUpdate(internals).then((info) => {
              if (!info) {
                if (n < 5) setTimeout(() => attempt(n + 1), 5_000);
                return; // fail-safe：把网络错误当更新提示弹给用户的禁令
              }
              if (isUpdateSkipped(info.version)) return;
              if (!document.body) return;
              showUpdateCard(info, internals);
            });
          } catch (e) {
            console.warn('[StudioUI] update check failed (fail-safe, no prompt)', e);
          }
        };
        setTimeout(() => attempt(0), 60_000);
      };
      scheduleUpdateCheck();
    }
    if (!isBotWindow && !isLoginPage) {
      // Studio 常驻主视图：覆盖 DeepSeek 内容区，但动态避让原生侧栏和 composer。
      // 登录页与 bot 操作窗口不挂载；无法创建 DOM 的测试桩环境也跳过。
      if (typeof document.createElement === 'function') {
        try {
          const executionStore = createStudioExecutionStore({
            kv: {
              kvGet: (key) => host.kvGet(key),
              kvSet: (key, value) => host.kvSet(key, value),
              kvRemove: (key) => host.kvRemove(key),
            },
            onConnected: (callback) => host.onConnected(callback),
            isConnected: () => host.connected,
            reportError: (message, error) => options.reportError?.(message, error),
          });
          const initialSessionKey = normalizeSessionKeyFromPathname(location.pathname);
          chatUI = createStudioChatUI({ persistence: executionStore, initialSessionKey });
          const append = (): void => {
            const parent = document.body ?? document.documentElement;
            if (parent && !chatUI?.container.isConnected) parent.appendChild(chatUI!.container);
          };
          if (document.body) append();
          else document.addEventListener('DOMContentLoaded', append, { once: true });

          void chatUI.activateSession(initialSessionKey);
          executionStore.onConnected(() => {
            void chatUI?.activateSession(chatUI.sessionKey);
          });
          const navigation = createNavigationObserver({
            reinjectOnRouteChange: false,
            onRouteChange: (pathname) => {
              void chatUI?.activateSession(normalizeSessionKeyFromPathname(pathname));
            },
          });
          navigation.start();
        } catch (e) {
          options.reportError?.('failed to mount studio chat UI', e);
        }
      }

      // C4：Focus 模式待 C5 托盘菜单项触发，本期不自动挂载

      // T4：聊天室最小挂载（仅 chat-room；不恢复 sidebar/input-bar/settings/project/skills/mcp/right-sidebar）。
      // 无 window.__studioChatConfig（config.json 无 chatRooms）→ warn 不挂载，向后兼容。
      try {
        const chatCfg = (globalThis as { __studioChatConfig?: ChatRoomRuntimeConfig }).__studioChatConfig;
        if (chatCfg && chatCfg.token && chatCfg.roomId) {
          const chatRoom = createChatRoom(chatCfg);
          // W2：进入聊天室才拉起成员 bot 窗口（启动时一个都不建）。
          wireChatRoomBotWindows(chatRoom, chatCfg.members);
          document.body.appendChild(chatRoom.container);
          console.log('[StudioUI] chat room installed:', chatCfg.roomName);
        } else {
          console.warn('[StudioUI] chat room skipped: no __studioChatConfig (config.json missing chatRooms?)');
        }
      } catch (e) {
        options.reportError?.('failed to mount chat room', e);
      }
      // F4：Studio 设置入口。先接宿主桥（面板调后端工具的唯一前提），
      // 再在 DeepSeek 账号菜单的「系统设置」旁追加「Studio 设置」兄弟项。
      // 官方弹窗保持原样，不冒充；定位失败只 warn，不影响页面功能。
      try {
        installStudioSettingsEntry({
          sendToolCall: (req) => host.sendToolCall(req),
          log: (text) => host.log(`[settings-ui] ${text}`),
        });
      } catch (e) {
        options.reportError?.('failed to mount studio settings entry', e);
      }

      // 移植 A（dpp skill-popup）：在 DeepSeek 对话框输入 `/` 弹出技能提示浮层。
      // 先装监听（空清单 → 打 `/` 也会给"无可用技能"反馈，不至于静默无反应），
      // 再异步向宿主要 skill.list；宿主 WS 可能尚未连上，按秒级重试，连上后热更新。
      try {
        initSkillPopup([]);
        // 启动后新增/删除技能时，`/` 提示需要重新扫描，否则只能重启 Studio 才看得到。
        let skillListLoading: Promise<boolean> | null = null;
        const loadSkillList = async (): Promise<boolean> => {
          // 去重：输入 `/` 的连续按键和启动重试可能并发触发同一个扫描。
          if (skillListLoading) return skillListLoading;
          skillListLoading = (async () => {
            try {
              const r = await host.sendToolCall({
                callId: `skill_list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                invocationName: 'skill.list',
                params: {},
              });
              const data = r.data as { skills?: unknown[] } | undefined;
              if (!r.ok || !data || !Array.isArray(data.skills)) return false;
              const items: SkillPopupItem[] = data.skills
                .filter((s): s is { name: string; description?: string } =>
                  !!s && typeof (s as { name?: unknown }).name === 'string')
                .map((s) => ({
                  name: s.name,
                  description: typeof s.description === 'string' ? s.description : '',
                }));
              setSkillPopupSkills(items);
              return true;
            } finally {
              skillListLoading = null;
            }
          })();
          return skillListLoading;
        };
        setSkillPopupRefreshHandler(() => {
          void loadSkillList();
        });
        void (async () => {
          for (let attempt = 0; attempt < 10; attempt++) {
            try {
              if (await loadSkillList()) return;
            } catch (e) {
              options.reportError?.('skill.list failed', e);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          options.reportError?.('skill.list failed after retries; skill popup stays empty');
        })();
        // 宿主连上时再拉一次（首次重试可能都撞在未连接窗口上）。
        const off = host.onConnected(() => {
          void loadSkillList();
        });
        globalThis.addEventListener?.('pagehide', off, { once: true });
      } catch (e) {
        options.reportError?.('failed to install skill popup', e);
      }
    }
    try {
      // QD-R7-01（F12）：先把取证落盘通道接上，再装拦截器——否则第一轮就丢。
      setInterceptorTraceSink((line) => host.trace(line));
      installMainWorldInterceptor({
        sender: (req) => host.sendToolCall(req),
        diag: (msg) => host.log(`[interceptor] ${msg}`),
        onAssistantReply: (text, loop) => host.assistantReply(text, loop),
        onStreamDelta: (text) => host.streamDelta(text),
        // R3-03：页端每轮收尾把 finish-sentinel 发给宿主（契约 {round, sawFinishSentinel}），
        // 宿主据此判停（web-engine：false + 有可见输出 ⇒ interrupted）。此前缺发送端 → 死代码。
        onFinishSentinel: (info) => host.finishSentinel(info.round, info.sawFinishSentinel),
        onMemoriesUpdate: (memories) => {
          (globalThis as { __studioMemories?: unknown }).__studioMemories = memories;
          // M10-5：设置面板的记忆页从 globalState 取数，广播到了要同步进去，
          // 否则面板永远显示「暂无保存的记忆」（此前的实况）。
          globalState.memories = memories;
          globalEvents.emit('ui:memories-updated');
        },
        chatUI,
      });
      // M10-8B（B1）：feature flag 默认关。开启时页端在首轮 fetch 前有界等待 memory.select。
      // C1-F1 修复：enabled 改为 getter 函数，运行期动态读取 globalThis.__studioMemorySelect；
      // 真机注入时 flag 可能为 null，之后页端设置后要能生效。
      configureMemorySelect({
        enabled: () => Boolean((globalThis as { __studioMemorySelect?: boolean }).__studioMemorySelect),
        invoke: (taskText) => host.sendToolCall({ callId: `msel_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, invocationName: 'memory.select', params: { taskText } }) as Promise<{ ok: boolean; data?: { memories?: unknown } }>,
      });
    } catch (err) {
      options.reportError?.('failed to install main-world interceptor', err);
    }
    // 断流取证出口：不挂就会被 esbuild tree-shake，整套 trace 采集白写。
    try {
      installTraceReportHandle();
    } catch (err) {
      options.reportError?.('failed to install trace report handle', err);
    }
  }

  const target = (globalThis as { window?: unknown }).window ?? globalThis;
  (target as { __deepseekStudio?: unknown }).__deepseekStudio = {
    origin,
    sessionId,
    bridge,
    authority: 'resident-host',
    host,
  };

  // 5.4 完整性防护：周期自检是主体，冻结为可选增强。
  // 冻结默认关闭——同 world 脚本若想改总有办法，而钉死 configurable:false 会
  // 反过来破坏合法的重新装配与测试清理，代价大于收益。真正的边界是宿主的降级。
  if (options.freezeStudio === true) freezeStudioObject();
  if (typeof globalThis.document !== 'undefined') {
    startIntegrityProbe({
      intervalMs: options.integrityIntervalMs,
      onViolation: (alert) => {
        options.reportError?.(`integrity violation: ${alert.reason}${alert.detail ? ` (${alert.detail})` : ''}`);
        host.reportIntegrity(alert);
      },
    });
  }

  // C4：installStudioUI 调用点已删除，保留至 C7 收口
  return { bridge, origin, sessionId, host };
}

// 自动装配：注入脚本被 Tauri（initialization_script）加载即视为应启动。
// 仅在真实浏览器环境（存在 WebSocket 且尚未装配）下触发，避免测试（jsdom 无 WebSocket）
// 或重复装配时副作用。Tauri WebView 满足此条件，故产品态会自动 installStudio()。
if (
  typeof globalThis.document !== 'undefined' &&
  typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined' &&
  !(globalThis as { window?: { __deepseekStudio?: unknown } }).window?.__deepseekStudio
) {
  try {
    installStudio();
  } catch (err) {
    console.error('[installStudio] auto-init failed', err);
  }
}
