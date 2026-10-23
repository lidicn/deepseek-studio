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
import { installMainWorldInterceptor, setInterceptorTraceSink } from '../inject/main-world-interceptor';
import { installTraceReportHandle } from '../inject/main-world-interceptor';
import { globalEvents, globalState } from '../ui/studio-ui-core';
import { createChatRoom, type ChatRoomRuntimeConfig } from '../ui/studio-chat-room';
import { installStudioSettingsEntry } from '../ui/studio-settings-entry';
import { createStudioChatUI, type StudioChatUIHandle } from '../ui/studio-chat-ui';
import { createStudioExecutionStore } from '../ui/studio-execution-store';
import { normalizeSessionKeyFromPathname } from '../shared/studio-execution';
import { createNavigationObserver } from '../inject/navigation';
import { freezeStudioObject, startIntegrityProbe } from './integrity';
import type { ExecutableCapability } from '../capabilities/types';

const DEFAULT_HOST_URL = 'ws://127.0.0.1:8760/studio';

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
  // QD-R2-01 / H-2b：注入页连 /studio 必须带 host token。
  // Rust 侧把 config.json 的 token 注入 window.__studioHostToken（main.rs:load_host_token_script）。
  // 读不到时保持旧 URL（开发/测试环境允许无 token 起宿主）；生产有 token 就必须拼上 query。
  const hostToken = (globalThis as { __studioHostToken?: string }).__studioHostToken;
  const hostUrl = options.hostUrl ?? (hostToken
    ? `${DEFAULT_HOST_URL}?token=${encodeURIComponent(hostToken)}`
    : DEFAULT_HOST_URL);
  const host = createHostClient({
    url: hostUrl,
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
    }
    const isLoginPage = location.pathname.includes('/login') || location.pathname.includes('/signin');
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
    }
    try {
      // QD-R7-01（F12）：先把取证落盘通道接上，再装拦截器——否则第一轮就丢。
      setInterceptorTraceSink((line) => host.trace(line));
      installMainWorldInterceptor({
        sender: (req) => host.sendToolCall(req),
        diag: (msg) => host.log(`[interceptor] ${msg}`),
        onAssistantReply: (text, loop) => host.assistantReply(text, loop),
        onStreamDelta: (text) => host.streamDelta(text),
        onMemoriesUpdate: (memories) => {
          (globalThis as { __studioMemories?: unknown }).__studioMemories = memories;
          // M10-5：设置面板的记忆页从 globalState 取数，广播到了要同步进去，
          // 否则面板永远显示「暂无保存的记忆」（此前的实况）。
          globalState.memories = memories;
          globalEvents.emit('ui:memories-updated');
        },
        chatUI,
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
