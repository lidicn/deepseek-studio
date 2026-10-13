/**
 * 注入入口（initialization_script）
 *
 * 在 document_start 按顺序装配：
 *   1. installChromeShims()      —— 挂 window.chrome.runtime / chrome.storage
 *   2. installDirectBridge()     —— content↔注入脚本 同域直连桥（消除 postMessage 伪造面）
 *   3. bootstrapInjection()      —— 按白名单启动能力模块，接管资源管理
 *   4. createHostClient()        —— 连接常驻宿主 ws 通道，承接工具派发与同意闸门
 * 并把装配结果挂到 window.__deepseekStudio，供宿主/调试读取。
 *
 * v0.4：能力集默认含 echo + chat-read/insert/send；宿主客户端仅在浏览器环境自动连接
 * （node 测试环境无 document，不连接，避免挂起）。
 */

import { installChromeShims, type StorageKvBackend, type StorageKvWriteBatch, type Transport } from '../bridge';
import { installDirectBridge, type InstalledBridge } from '../inject/bridge-install';
import { bootstrapInjection } from '../inject/loader';
import type { ContentCapabilityController, ReplaceContentDocumentLifecycle } from '../inject/types';
import { createEchoCapability } from '../capabilities/echo';
import { createChatReadCapability } from '../capabilities/chat-read';
import { createChatInsertCapability } from '../capabilities/chat-insert';
import { createChatSendCapability } from '../capabilities/chat-send';
import { createHostClient, type HostClient } from './host-client';
import { installMainWorldInterceptor } from '../inject/main-world-interceptor';
import { freezeStudioObject, startIntegrityProbe } from './integrity';
import type { ExecutableCapability } from '../capabilities/types';
import { createStudioChatUI } from '../ui/studio-chat-ui';

const DEFAULT_HOST_URL = 'ws://127.0.0.1:8760/studio';

export interface InstallStudioOptions {
  capabilities?: readonly ContentCapabilityController[];
  originWhitelist?: string[];
  sessionId?: string;
  lifecycleFactory?: ReplaceContentDocumentLifecycle;
  reportError?: (message: string, error?: unknown) => void;
  /** 宿主 ws 地址（默认 ws://127.0.0.1:8756/studio）。 */
  hostUrl?: string;
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

  // v0.7：先建 host client（不 connect），用它建 remote KV backend，再装 chrome shim。
  // 顺序不能反：installChromeShims 会把 window.chrome.storage 指向这个 backend。
  const capabilities = dedupeById([...defaultCapabilities(), ...(options.capabilities ?? [])]);
  const executable = capabilities as unknown as ExecutableCapability[];
  const host = createHostClient({
    url: options.hostUrl ?? DEFAULT_HOST_URL,
    capabilities: executable,
    reportError: options.reportError,
  });

  const remoteKv: StorageKvBackend = {
    async readAll(): Promise<Record<string, unknown>> {
      // v0.7：页端不预加载全量（宿主 KV 是 append-only 写路径，读回由调用方显式 kvGet）。
      return {};
    },
    async writeBatch(batch: StorageKvWriteBatch): Promise<void> {
      for (const [k, v] of Object.entries(batch.set)) await host.kvSet(k, v);
      for (const k of batch.remove) await host.kvRemove(k);
    },
  };
  // v0.7：chrome.runtime.sendMessage 经 host-client → 宿主 runtime-envelope 路由。
  const runtimeTransport: Transport = {
    post: (envelope) => host.sendEnvelope(envelope),
  };
  installChromeShims({ localBackend: remoteKv, transport: runtimeTransport });

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
  if (typeof globalThis.document !== 'undefined') {
    // v0.19：创建自建聊天 UI overlay，在拦截器之前挂载到 DOM。
    // SSE 文本由拦截器推送到此 UI，不再写入 DeepSeek DOM。
    // 注意：initialization_script 在 document_start 执行，此时 document.body 尚不存在，
    // 必须延迟到 DOMContentLoaded 再 append，否则 body=null 会静默失败导致 UI 不显示。
    let chatUI;
    try {
      chatUI = createStudioChatUI();
      const mount = () => document.body.appendChild(chatUI!.container);
      if (document.body) {
        mount();
      } else {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
      }
    } catch (err) {
      options.reportError?.('failed to create studio chat UI', err);
    }
    try {
      installMainWorldInterceptor({
        sender: (req) => host.sendToolCall(req),
        diag: (msg) => host.log(`[interceptor] ${msg}`),
        onAssistantReply: (text, loop) => host.assistantReply(text, loop),
        onMemoriesUpdate: (memories) => {
          (globalThis as { __studioMemories?: unknown }).__studioMemories = memories;
        },
        chatUI,
      });
    } catch (err) {
      options.reportError?.('failed to install main-world interceptor', err);
    }
    // v0.19：不再启动 startToolCardObserver——工具标签不再写入 DeepSeek DOM，
    // 由 chat UI 直接渲染。tool-card-ui 的 createToolCard 已挂载到 chat UI 消息元素。
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
