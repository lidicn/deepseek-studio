/**
 * 常驻桌面宿主（v0.2 Node 原型）
 *
 * 组合两件事：
 *   1. 本地 HTTP API（createApiServer，8760，fake backend）
 *   2. 工具执行授权方（createPlatformDesktop，签发一次性 grant）
 *
 * 暴露 executeTool：先 consume grant（校验 + 一次性消费）→ 再 rehydrate/执行能力。
 * 这是「授权先于执行」硬不变量的落点。v0.7 起由 Rust 主进程托管，本文件逻辑上等价。
 */

import { createApiServer, type ApiServer, type RateLimitOptions } from '../api/server';
import { createBearerAuthenticator } from '../api/auth';
import { createFakeOfficialBackend } from '../api/official-backend';
import { createPlatformDesktop, type PlatformDesktop } from './platform-desktop';
import { createSecretRing, type SecretRing, DEFAULT_SECRET_GRACE_MS } from './host-token';
import { createEchoCapability } from '../capabilities/echo';
import { createChatReadCapability } from '../capabilities/chat-read';
import { createChatInsertCapability } from '../capabilities/chat-insert';
import { createChatSendCapability } from '../capabilities/chat-send';
import {
  createToolRegistry,
  DEFAULT_EXECUTION,
  executionSide,
  needsConsent,
  type ExecutionSide,
  type ToolDefinition,
  type ToolRegistry,
} from './tool-registry';
import { DEFAULT_TOOL_DEFINITIONS, HOST_INTERNAL_ORIGIN } from './tool-definitions';
import { createPageRuntimeHub, type PageRuntimeHub } from './page-runtime';
import { AGENT_SENTINEL, type AgentLoopEvent } from './agent-loop';
import { createAgentChannel, type AgentChannel } from './agent-channel';
import { pickFolderViaDialog } from './folder-picker';
import { createWebEngine } from './engine/web-engine';
import { createApiEngine } from './engine/api-engine';
import { createBotRegistry, SessionAllowlist } from './bot/registry';
import type { BotInstance, ChatRoomEvent, PersonaRegistry, RoomConfig } from './bot/types';
import { createSlotRuntime, type SlotRuntime } from './bot/slot-runtime';
import {
  createChatRoomRuntime,
  type ChatRoomRuntime,
  createModelSummarizer,
} from './bot/chat-room-runtime';
import { FilePersonaRegistry } from './bot/persona-registry';
import { DefaultMentionParser } from './bot/mention-parser';
import { DefaultHandoffParser } from './bot/handoff-parser';
import { createAgentInstructionBuilder } from './bot/instructions';
import { SqliteChatMessageStore } from './bot/chat-room-store';
import { SqliteContextEngine, SnapshotStore } from './bot/context-engine';
import { SqliteRoomSummaryService } from './bot/room-summary';
import { SqliteRoomStateStore } from './bot/meeting-state';
import { createStrategyGenerator } from './bot/strategy-generator';
import { Scheduler } from './bot/scheduler';
import { FileSlotRegistry } from './bot/slot-registry';
import { FileReportStore } from './bot/report-store';
import { createOfflineRunExecutor } from './bot/offline-runner';
import { createAuditDispatcher } from './bot/audit-meeting';
import { createFileStorageKvBackend } from './file-storage-backend';
import { listFiles, grepFiles } from '../capabilities/search-files';
import { webFetch } from '../capabilities/web-fetch';
import { webSearch } from '../capabilities/web-search';
import { createMessageHistory } from './kernel/message-history';
import { createHostToolsAdapter } from './kernel/host-tools-adapter';
import { createTaskLoop } from './kernel/task-loop';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ConsentMeta } from './protocol';
import {
  DEFAULT_POLICY_MODE,
  evaluatePolicy,
  isFileTool,
  isProcessTool,
  POLICY_MODES,
  POLICY_MODE_LABELS,
  riskLabel,
  type PolicyMode,
} from './policy';
import { routeConsent } from './consent-router';
import { createWhitelistStore } from './consent-whitelist-store';
import { createShadowStore } from './shadow-store';
import {
  createMutableWorkspace,
  createWorkspace,
  defaultConfigPath,
  persistConfigPatch,
  resolveWorkspaceRoot,
  type MutableWorkspaceContext,
  type WorkspaceContext,
} from './workspace';
import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createShellCapability } from '../capabilities/shell';
import { createFileTools } from '../capabilities/file';
import { createFileEditCapability } from '../capabilities/edit-engine';
import { getMemoryStore } from './memory-store';
import { scanSkills, ensureSkillsDir, resolveSkillsDir } from './skill-store';
import { getMcpController, ensureMcpConfig, getMcpServer, removeMcpServer } from './mcp-controller';
import { createAutomationManager, type AutomationManager } from './automation';
import { execPythonInSandbox } from './sandbox-executor';
import {
  createAuditLog,
  DEFAULT_AUDIT_CAPACITY,
  summarizeParams,
  type AuditInput,
  type AuditLog,
  type AuditOutcome,
} from './audit';
import type { ExecutableCapability, ExecuteResult } from '../capabilities/types';
import type { ApiConfig } from '../api/types';
import type {
  ContentCapabilityController,
  ContentLifecycleStopReason,
  ContentResourceKind,
  ContentResourceScope,
} from '../inject/types';
import type { IssueGrantInput } from './grant-store';

export interface DesktopHostOptions {
  config: ApiConfig;
  secret: string;
  tokenTtlMs?: number;
  grantTtlMs?: number;
  /** 审计环形缓冲容量（默认 200）。 */
  auditCapacity?: number;
  /**
   * 宿主侧能力登记表（v0.5：shell / file）。这些能力在常驻宿主进程内执行，
   * 不参与页端 DOM 生命周期，因此单独一张表，与 ContentCapabilityController 分开。
   * 缺省时按 workspace 自动装配 shell.exec + file.*。
   */
  hostTools?: Readonly<Record<string, ExecutableCapability>>;
  /**
   * 工作区上下文。undefined → 自动从环境变量 / 用户配置解析；
   * 显式传 null 表示「明确不启用工作区」（文件类能力将不可用）。
   */
  workspace?: WorkspaceContext | null;
  /** 命令审批档位（默认 ask 询问审批）。 */
  policyMode?: PolicyMode;
  /** M7 D3：ApiEngine 配置（真实 API key，缺省走 WebEngine 网页拦截）。 */
  apiEngine?: { baseURL: string; apiKey: string; model: string };
  /** 限流与并发（透传给 API server，默认串行 + 60/分钟）。 */
  rateLimit?: RateLimitOptions;
  /**
   * M1 智能体面板静态资源（磁盘路径）。提供后开放 GET /agent 与 GET /agent.js，
   * 并挂载 /agent-ws 通道；缺省则面板路由整体不可用（fail-closed）。
   */
  agentPage?: {
    htmlPath: string;
    jsPath: string;
    cssPath: string;
    /** P2 PWA 附属资源路径（可选，缺省则对应路由不可用）。 */
    manifestPath?: string;
    swPath?: string;
    icon192Path?: string;
    icon512Path?: string;
  };
  /** P2：/agent 局域网访问闸门（透传给 API server）。缺省则只放行 loopback。 */
  agentLanAccess?: {
    lanEnabled: boolean;
    pairingCode: string;
  };
  /**
   * v0.25：SlotRuntime（人设工具白名单）。
   * hub 收到页端 tool-call 时，先取发起 bot 的 per-persona executor 执行——
   * 白名单拒绝走 tool-not-allowed-by-persona，命中后仍回到 invokeTool 走完整授权链。
   * 缺省（或该 bot 未加载人设）→ 直接 invokeTool，与 v0.24 行为完全一致。
   * v0.27：可选传完整 SlotRuntime（ChatRoomRuntime 需 loadPersona/loaded/renderPersonaBlock）；
   * 传窄接口（仅 executorFor）时聊天室不可用，但 hub 工具白名单仍工作。
   */
  slotRuntime?: SlotRuntime | {
    executorFor(botId: string | undefined): ((tool: string, params: unknown) => Promise<ToolExecutionResult>) | undefined;
  };
  /**
   * v0.27：聊天室配置。提供后装配 ChatRoomRuntime——面板带 roomId 的 send 走
   * @路由 + 多 bot 编排；不带 roomId 仍走原直发路径（向后兼容）。
   * 缺省（undefined / 空数组）→ 不装配聊天室，行为与 v0.26 完全一致。
   */
  chatRooms?: ReadonlyArray<RoomConfig>;
  /** v0.27：聊天室编排波数（默认 1：只跑路由目标，接力目标进 pendingHandoff）。 */
  chatRoomMaxDepth?: number;
  /** v0.27：人设注册表。缺省用 FilePersonaRegistry（~/.config/deepseek-studio/personas/）。 */
  personas?: PersonaRegistry;
}

export interface ToolExecutionResult {
  ok: boolean;
  reason?: string;
  /**
   * 能力返回的结构化数据（v0.5 起透传）。
   * 此前宿主丢弃了 ExecuteResult.data，导致 shell 的 stdout、file.read 的内容
   * 永远到不了调用方——能力「执行成功」却拿不到结果，等于不可用。
   */
  data?: unknown;
  /** stop 前的资源快照（证明能力确实被装载过）。 */
  snapshot?: { total: number; byKind: Record<string, number> };
  // ---- v1.2 新增：Pi Agent 风格统一结果格式（全可选，缺省即回退旧格式）----
  // 语义真相源见 src/shared/tool-result-format.ts 的 ToolResultExtras。
  /** 给模型看的内容（文本 + 图片等多模态）。 */
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
  /** 给 UI 看的元数据（exitCode / durationMs / path 等）。 */
  details?: Record<string, unknown>;
  /** 显式错误标记（等价于 !ok，但语义更清晰）。 */
  isError?: boolean;
  /** 提示跳过自动续跑（批次内全部为 true 时才生效）。 */
  terminate?: boolean;
}

export interface DesktopHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  readonly authority: PlatformDesktop;
  /** 签发一张一次性 tool grant（常驻宿主侧调用）。 */
  issueGrant(input: IssueGrantInput): Promise<string>;
  /** 持 grant 执行能力：先 consume（失败即拒绝），再 start/stop。 */
  executeTool(name: string, params: unknown, grantToken: string, botId?: string): Promise<ToolExecutionResult>;
  /** 便捷入口：已鉴权的 agent 经此发起工具调用（内部签发+消费一次性 grant，再走同意闸门与页端路由）。
   *  v0.24：botId 可选——多 bot 下路由到对应窗口的页与同意闸门；缺省='main'。 */
  invokeTool(tool: string, params: unknown, botId?: string): Promise<ToolExecutionResult>;
  /** 工具执行审计环（HTTP 端点 /v1/tools/audit 的数据源）。 */
  readonly audit: AuditLog;
  /** 当前生效的执行侧Resolver（测试与外部观察者用）。 */
  resolveSide(name: string): ExecutionSide;
  /**
   * 轮换 API 令牌（v0.5 5.1）。返回新令牌；旧令牌在宽限期内仍然可用。
   * 默认不自动轮换——自动轮换会在无人知情时打断外部客户端，必须由运维显式触发。
   */
  rotateApiToken(next?: string): string;
  /** 轮换宿主签发密钥；轮换期已签发的 grant 仍可被正常消费。 */
  rotateHostSecret(next?: string): string;
  /** 当前 API 令牌（供日志与引导页展示）。 */
  readonly currentApiToken: string;
  /** 当前审批档位（M1 面板状态栏数据源）。 */
  readonly policyMode: PolicyMode;
  /** 切换审批档位并持久化到用户配置（运行中立即生效）。 */
  setPolicyMode(mode: PolicyMode): void;
  /**
   * 热切换工作区（M1「打开文件夹」）并持久化。
   * 校验目标必须是已存在的目录；传 null 表示清除工作区（文件类能力转为不可用）。
   */
  setWorkspaceRoot(path: string | null): { ok: boolean; error?: string };
  /** 当前工作区根（未配置为 null）。 */
  readonly workspaceRoot: string | null;
  /** M1 智能体门面：面板经 channel 调用。 */
  readonly agent: AgentFacade;
  /** 订阅智能体事件（面板 WS 推送的数据源）；返回退订函数。 */
  onAgentEvent(cb: (event: AgentLoopEvent) => void): () => void;
  /** v0.28：订阅聊天室结构化事件（ChatRoomEvent → agent-channel broadcast / UI 渲染）；返回退订函数。 */
  onChatRoomEvent(cb: (event: ChatRoomEvent) => void): () => void;
  /** C3：订阅结构化工具运行事件（ToolRunEvent → Workbench UI）；返回退订函数。 */
  onToolRun(cb: (event: import('../shared/tool-run-event').ToolRunEvent) => void): () => void;
}

export interface AgentFacade {
  /** 处理一条用户消息（异步推进循环，事件经 onAgentEvent 推送）。 */
  sendMessage(text: string): Promise<void>;
  stop(): void;
  readonly running: boolean;
  /** 模型引擎健康探测（网页引擎：聊天页已连接且可读）。 */
  health(): Promise<{ ok: boolean; reason?: string }>;
  /** 原生目录选择对话框（Windows FolderBrowserDialog）；取消/失败返回 null。 */
  pickFolder(): Promise<string | null>;
}

/**
 * 宿主侧最小资源作用域：v0.2 原型里能力在宿主进程内直接 rehydrate，
 * 真实 DOM 作用域由 v0.4 的 replaceContentDocumentLifecycle 提供。
 */
function createHostResourceScope(): ContentResourceScope {
  const resources = new Set<() => void | Promise<void>>();
  const reg = (cb: () => void | Promise<void>) => {
    resources.add(cb);
    return async () => {
      resources.delete(cb);
      await cb();
    };
  };
  return {
    signal: new AbortController().signal,
    active: true,
    addCleanup: (_k, cb) => reg(cb),
    listen: () => reg(() => {}),
    observe: () => reg(() => {}),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (t) => clearInterval(t),
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    cancelAnimationFrame: (f) => clearTimeout(f as unknown as ReturnType<typeof setTimeout>),
    ownRoot: (r) => r,
    ownPort: (r) => r,
    snapshot: () => {
      const byKind: Record<ContentResourceKind, number> = {
        listener: 0,
        observer: 0,
        timeout: 0,
        interval: 0,
        'animation-frame': 0,
        'dom-root': 0,
        'message-port': 0,
        cleanup: 0,
      };
      byKind.listener = resources.size;
      return { total: resources.size, byKind };
    },
  };
}

/** QD-R2-08：用户点 allow-session 的默认 TTL（与密钥轮换宽限期同族，10min）。 */
const DEFAULT_SESSION_GRANT_TTL_MS = DEFAULT_SECRET_GRACE_MS;

export function createDesktopHost(options: DesktopHostOptions): DesktopHost {
  // C3：tool run 事件追踪（Workbench UI 投影）
  const pendingRuns = new Map<string, { tool: string; botId: string; startedAt: number }>();
  const toolRunListeners = new Set<(event: import('../shared/tool-run-event').ToolRunEvent) => void>();
  function emitToolRun(event: import('../shared/tool-run-event').ToolRunEvent): void {
    for (const cb of toolRunListeners) { try { cb(event); } catch { /* ignore */ } }
  }
  function onToolRun(cb: (event: import('../shared/tool-run-event').ToolRunEvent) => void): () => void {
    toolRunListeners.add(cb);
    return () => toolRunListeners.delete(cb);
  }

  // 密钥环：轮换期新密钥立即生效、旧密钥在宽限期内仍被接受，
  // 避免「轮换瞬间已签发的 grant 全部失效」把正在跑的 agent 链路打断。
  const hostSecretRing: SecretRing = createSecretRing(options.secret);
  const apiTokenRing: SecretRing = createSecretRing(options.config.token);

  const authority = createPlatformDesktop({
    secret: options.secret,
    secretRing: hostSecretRing,
    tokenTtlMs: options.tokenTtlMs,
    grantTtlMs: options.grantTtlMs,
  });

  const capabilities = new Map<string, ContentCapabilityController>();
  capabilities.set('echo', createEchoCapability());
  capabilities.set('chat-read', createChatReadCapability());
  capabilities.set('chat-insert', createChatInsertCapability());
  capabilities.set('chat-send', createChatSendCapability());

  // 工作区：未显式指定时自动解析（env > 用户配置 > 不可用）。
  // 解析失败不代表拒绝启动，而是让文件类能力进入 deny 状态（fail-closed 由 policy 兜住）。
  // M1：包一层可变代理，面板「打开文件夹」后 setRoot 热生效，已注册能力无需重建。
  let initialWorkspace: WorkspaceContext | null;
  if (options.workspace !== undefined) {
    initialWorkspace = options.workspace;
  } else {
    const resolvedRoot = resolveWorkspaceRoot();
    initialWorkspace = resolvedRoot.root ? createWorkspace(resolvedRoot.root) : null;
  }
  const mutableWorkspace: MutableWorkspaceContext = createMutableWorkspace(initialWorkspace);
  let policyMode: PolicyMode = options.policyMode ?? DEFAULT_POLICY_MODE;

  // M8-E1：持久白名单（E2 快照待接线）
  const whitelistStore = createWhitelistStore({
    homedir: os.homedir(),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    writeFile: (p, d) => fs.writeFileSync(p, d, 'utf-8'),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  });
  const shadowStore = createShadowStore({
    homedir: os.homedir(),
    readFile: (p) => fs.readFileSync(p),
    writeFile: (p, d) => fs.writeFileSync(p, d),
    readJson: (p) => JSON.parse(fs.readFileSync(p, 'utf-8')),
    writeJson: (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf-8'),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    unlink: (p) => fs.unlinkSync(p),
  });

  // 宿主侧能力表（v0.5：shell / file）。与页端能力分表：
  // 它们没有 DOM 生命周期，强行塞进 ContentCapabilityController 会违反「资源所有权归上游」不变量。
  const hostTools = new Map<string, ExecutableCapability>(
    Object.entries(
      options.hostTools ?? {
        'shell.exec': createShellCapability({ workspace: mutableWorkspace }),
        ...createFileTools({ workspace: mutableWorkspace }),
        'file.edit': createFileEditCapability({ workspace: mutableWorkspace }),
        // ORD-001：本地文件检索（listFiles + grepFiles 合成一个 search_files 工具）
        'search_files': {
          id: 'search_files',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const operation = String(params.operation ?? 'list');
            const root = typeof params.root === 'string' ? params.root : mutableWorkspace.root;
            if (operation === 'grep') {
              return grepFiles({
                root,
                query: String(params.query ?? ''),
                regex: Boolean(params.regex),
                caseInsensitive: Boolean(params.caseInsensitive),
                glob: typeof params.glob === 'string' ? params.glob : undefined,
                limit: typeof params.limit === 'number' ? params.limit : undefined,
              });
            }
            // 默认 list
            return listFiles({
              root,
              pattern: typeof params.pattern === 'string' ? params.pattern : undefined,
              recursive: typeof params.recursive === 'boolean' ? params.recursive : undefined,
              limit: typeof params.limit === 'number' ? params.limit : undefined,
            });
          },
        },
        // ORD-002：网页抓取（生产未接真实 transport，fail-closed 返 io-error）
        'web_fetch': {
          id: 'web_fetch',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            return webFetch({
              url: String(params.url ?? ''),
              timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
              maxBytes: typeof params.maxBytes === 'number' ? params.maxBytes : undefined,
            });
          },
        },
        // ORD-003：网页搜索（生产未接真实通道，fail-closed 返 channel-not-configured）
        'web_search': {
          id: 'web_search',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            return webSearch({
              query: String(params.query ?? ''),
              limit: typeof params.limit === 'number' ? params.limit : undefined,
            });
          },
        },
        'skill.list': {
          id: 'skill.list',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            // dir 可选：面板输入框传路径时按该路径扫描；缺省按 resolveSkillsDir 优先级解析。
            const dir = typeof params.dir === 'string' && params.dir.trim() ? params.dir.trim() : undefined;
            const skills = scanSkills(dir);
            return {
              ok: true,
              data: {
                dir: resolveSkillsDir(dir),
                skills: skills.map((s) => ({
                  id: s.id,
                  name: s.name,
                  description: s.description,
                  skillMdPath: s.skillMdPath,
                })),
              },
            };
          },
        },
        // v1.0：长期记忆保存（移植自 deepseek++ memory_save）。
        'memory.save': {
          id: 'memory.save',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const store = getMemoryStore();
            const result = store.save({
              type: String(params.type ?? 'user'),
              name: String(params.name ?? ''),
              content: String(params.content ?? ''),
              tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
              pinned: Boolean(params.pinned),
              // v2：治理字段透传（来源/可信度/人设标签，缺省不传）
              ...(typeof params.source === 'string' ? { source: params.source } : {}),
              ...(typeof params.confidence === 'number' ? { confidence: params.confidence } : {}),
              ...(Array.isArray(params.personaTags) ? { personaTags: params.personaTags.map(String) } : {}),
            });
            if (!result.ok) {
              return { ok: false, error: result.error };
            }
            // 保存成功后推送记忆列表更新到页端。
            const memories = (await store.list()).map((m) => ({
              id: m.id, type: m.type, name: m.name, content: m.content, tags: m.tags,
            }));
            hub?.broadcastMemories(memories);
            return { ok: true, data: { id: result.id, saved: true } };
          },
        },
        // v0.10：Python 代码执行（沙箱隔离执行器）。
        'python.exec': {
          id: 'python.exec',
          async execute(params: Record<string, unknown>, ctx?: { allowOutsideWorkspace?: boolean }): Promise<ExecuteResult> {
            const code = String(params.code ?? '');
            if (!code.trim()) return { ok: false, error: 'code is required' };
            const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 30000;
            const cwd = ctx?.allowOutsideWorkspace
              ? process.cwd()
              : mutableWorkspace.current?.root;
            const result = await execPythonInSandbox({ code, timeoutMs, cwd });
            if (result.ok) {
              return { ok: true, data: { stdout: result.stdout, stderr: result.stderr, exitCode: 0 } };
            }
            return {
              ok: false,
              error: result.error ?? (result.stderr || 'python execution failed'),
              data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut },
            };
          },
        },
        // v1.0：列出已配置的 MCP 服务器及其工具。
        'mcp.list': {
          id: 'mcp.list',
          async execute(): Promise<ExecuteResult> {
            const controller = getMcpController();
            const serverIds = controller.listServerIds();
            // 回传每台服务器的真实传输配置：UI 列表原来把 transport 写死成 stdio，
            // 编辑弹窗也无处回填，表现为「存的是 HTTP，再打开变成 stdio」。
            const configs = serverIds.map((id) => {
              const cfg = getMcpServer(id);
              return {
                id,
                transport: cfg?.transport ?? 'stdio',
                url: cfg?.url,
                command: cfg?.command,
                args: cfg?.args ?? [],
              };
            });
            const tools = await controller.getAllTools();
            return {
              ok: true,
              data: {
                servers: serverIds,
                configs,
                tools: tools.map((t) => ({ serverId: t.serverId, name: t.name, description: t.description })),
              },
            };
          },
        },
        // v1.9：读取单台 MCP 服务器完整配置（编辑弹窗回填）。
        'mcp.get': {
          id: 'mcp.get',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const serverId = String(params.serverId ?? '');
            if (!serverId) return { ok: false, error: 'serverId is required' };
            const cfg = getMcpServer(serverId);
            if (!cfg) return { ok: false, error: `server not found: ${serverId}` };
            return { ok: true, data: { id: serverId, config: cfg } };
          },
        },
        // v1.0：调用 MCP 工具。
        'mcp.call': {
          id: 'mcp.call',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const serverId = String(params.serverId ?? '');
            const toolName = String(params.tool ?? params.name ?? '');
            const args = (params.args ?? params.arguments ?? {}) as Record<string, unknown>;
            if (!serverId || !toolName) {
              return { ok: false, error: 'serverId and tool are required' };
            }
            const controller = getMcpController();
            const result = await controller.callTool(serverId, toolName, args);
            return {
              ok: result.ok,
              data: result.data,
              error: result.error,
              content: result.content,
              details: result.details,
              isError: result.isError,
            };
          },
        },
        // v1.1：测试 MCP 连接
        'mcp.test': {
          id: 'mcp.test',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const config = (params.config ?? {}) as Record<string, unknown>;
            const controller = getMcpController();
            const result = await controller.testConnection({
              command: String(config.command ?? ''),
              args: Array.isArray(config.args) ? config.args.map(String) : [],
              env: config.env && typeof config.env === 'object' ? (config.env as Record<string, string>) : {},
              transport: String(config.transport ?? 'stdio') as 'stdio' | 'http' | 'sse',
              url: typeof config.url === 'string' ? config.url : undefined,
              cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
              // HTTP/SSE 测试要带自定义 Headers（如 Authorization），否则鉴权服务器会 401。
              headers: config.headers && typeof config.headers === 'object' ? (config.headers as Record<string, string>) : undefined,
            });
            return { ok: result.ok, data: { tools: result.tools ?? [] }, error: result.error };
          },
        },
        // v1.1：保存 MCP 配置
        'mcp.save': {
          id: 'mcp.save',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const serverId = String(params.serverId ?? params.id ?? '');
            const config = (params.config ?? {}) as Record<string, unknown>;
            if (!serverId) return { ok: false, error: 'serverId is required' };
            const controller = getMcpController();
            const result = controller.saveServer(serverId, {
              command: String(config.command ?? ''),
              args: Array.isArray(config.args) ? config.args.map(String) : [],
              env: config.env && typeof config.env === 'object' ? (config.env as Record<string, string>) : {},
              transport: String(config.transport ?? 'stdio') as 'stdio' | 'http' | 'sse',
              url: typeof config.url === 'string' ? config.url : undefined,
              cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
              headers: config.headers && typeof config.headers === 'object' ? (config.headers as Record<string, string>) : undefined,
            });
            return { ok: result.ok, error: result.error };
          },
        },
        // v1.1：删除 MCP 服务器配置。
        'mcp.remove': {
          id: 'mcp.remove',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const serverId = String(params.serverId ?? '');
            if (!serverId) return { ok: false, error: 'serverId is required' };
            const configPath = process.env.STUDIO_CONFIG_DIR
              ? path.join(process.env.STUDIO_CONFIG_DIR, 'mcp-servers.json')
              : path.join(os.homedir(), '.config', 'deepseek-studio', 'mcp-servers.json');
            const result = removeMcpServer(serverId, configPath);
            if (result.ok) getMcpController().reload();
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          },
        },
        // v1.1：删除记忆。
        'memory.delete': {
          id: 'memory.delete',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const id = String(params.id ?? '');
            if (!id) return { ok: false, error: 'id is required' };
            const store = getMemoryStore();
            const ok = store.remove(id);
            return { ok: ok ?? true };
          },
        },
        // v1.1：设置工作区根目录。
        'workspace.set': {
          id: 'workspace.set',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const root = String(params.root ?? '').trim();
            if (!root) return { ok: false, error: 'root is required' };
            // 统一走 setWorkspaceRoot：目录校验 fail-closed、作废旧会话授权、落盘 config.json。
            // 原实现只改内存 + process.env，宿主重启即丢——这是「设置保存不了」的根因之一。
            const r = setWorkspaceRoot(root);
            if (!r.ok) return { ok: false, error: r.error ?? 'workspace-set-failed' };
            return { ok: true, data: { root: mutableWorkspace.root } };
          },
        },
        // v1.1：设置策略模式。
        'policy.set': {
          id: 'policy.set',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const mode = String(params.mode ?? 'auto') as 'workspace' | 'ask' | 'auto' | 'full';
            // 统一走 setPolicyMode：非法值抛错、作废旧会话授权、落盘 config.json。
            // 原实现只改内存 + process.env，宿主重启即丢。
            try {
              setPolicyMode(mode);
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
            return { ok: true, data: { mode: policyMode } };
          },
        },
        // v1.9：读取当前生效设置。面板打开时必须读这里，否则只会显示 globalState 的
        // 出厂默认值（工作区 E:\、策略 auto），看起来像「设置没保存」。
        'settings.get': {
          id: 'settings.get',
          async execute(): Promise<ExecuteResult> {
            const controller = getMcpController();
            return {
              ok: true,
              data: {
                workspaceRoot: mutableWorkspace.configured ? mutableWorkspace.root : null,
                policyMode,
                mcpServers: controller.listServerIds(),
                skillsDir: resolveSkillsDir(),
                configPath: defaultConfigPath(),
              },
            };
          },
        },
        // v1.1：项目列表（从配置文件读取）。
        'project.list': {
          id: 'project.list',
          async execute(): Promise<ExecuteResult> {
            const configPath = process.env.STUDIO_CONFIG_DIR
              ? path.join(process.env.STUDIO_CONFIG_DIR, 'projects.json')
              : path.join(os.homedir(), '.config', 'deepseek-studio', 'projects.json');
            try {
              const projects = JSON.parse(readFileSync(configPath, 'utf8'));
              return { ok: true, data: { projects: Array.isArray(projects) ? projects : [] } };
            } catch {
              return { ok: true, data: { projects: [] } };
            }
          },
        },
        // v1.1：创建项目（写入配置文件 + 创建目录）。
        'project.create': {
          id: 'project.create',
          async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
            const name = String(params.name ?? '');
            const projectPath = String(params.path ?? '');
            if (!name || !projectPath) return { ok: false, error: 'name and path are required' };
            const configPath = process.env.STUDIO_CONFIG_DIR
              ? path.join(process.env.STUDIO_CONFIG_DIR, 'projects.json')
              : path.join(os.homedir(), '.config', 'deepseek-studio', 'projects.json');
            try {
              mkdirSync(path.dirname(configPath), { recursive: true });
              let projects: Array<{ id: string; name: string; path: string }> = [];
              try { projects = JSON.parse(readFileSync(configPath, 'utf8')); } catch { /* new */ }
              const id = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
              if (!projects.find((p) => p.id === id)) {
                projects.push({ id, name, path: projectPath });
                // 原子写：tmp + rename，避免崩溃半截损坏 projects.json
                const tmp = `${configPath}.tmp`;
                writeFileSync(tmp, JSON.stringify(projects, null, 2), 'utf8');
                renameSync(tmp, configPath);
              }
              if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true });
              return { ok: true, data: { id, name, path: projectPath } };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          },
        },
        // v1.1：选择文件夹（Node 宿主无法弹原生对话框，返回 STUDIO_PICK_FOLDER 环境变量或 not-supported）。
        'folder.pick': {
          id: 'folder.pick',
          async execute(): Promise<ExecuteResult> {
            const envPath = process.env.STUDIO_PICK_FOLDER;
            if (envPath && existsSync(envPath)) {
              return { ok: true, data: { path: envPath } };
            }
            return { ok: false, error: 'folder.pick requires Tauri dialog; set STUDIO_PICK_FOLDER env var as fallback' };
          },
        },
      },
    ),
  );

  // 治理层：声明已登记工具 + 风险等级 + 站点 allowlist（v0.3.1）。
  const registry: ToolRegistry = createToolRegistry(DEFAULT_TOOL_DEFINITIONS);

  // 审计环：全链路执行留痕（还清 v0.3 遗留 3.2.4）。
  const audit: AuditLog = createAuditLog(options.auditCapacity ?? DEFAULT_AUDIT_CAPACITY);

  // —— M1 智能体：BotRegistry（v0.23 多 bot 化）——
  // 原单 agent 装配（agentToolCounter/stopFlag/listeners/lastAutoReply/webEngine/agentLoop）
  // 收敛进 BotRegistry：主 bot（botId='main'）作为第一个 BotInstance 启动时创建，
  // 其独立 state 由下方 hub 回调（onToolCall/onAssistantReply）驱动——行为与改造前一致。
  // 工具执行不在 loop 内重复实现：引擎把消息灌进聊天页，页端拦截器解析工具标签
  // 反向投递到 invokeTool（完整授权链），结果由拦截器 pending 回填下一次请求。
  const agentListeners = new Set<(event: AgentLoopEvent) => void>();
  // v0.28：聊天室结构化事件总线（ChatRoomEvent，非 AgentLoopEvent）。
  // onBotReply/onSummary 回调把 CB 准备好的结构化事件推入此集合，
  // 由 agent-channel 订阅并 broadcast 到 WS（经 {type:'chat-room-event'} 通道）。
  // 与 agentListeners 分离——AgentLoopEvent 是引擎层原始事件，ChatRoomEvent 是面向 UI 的干净事件。
  const chatRoomListeners = new Set<(event: ChatRoomEvent) => void>();
  const emitChatRoomEvent = (event: ChatRoomEvent): void => {
    for (const cb of chatRoomListeners) {
      try {
        cb(event);
      } catch {
        // 观察者异常不中断聊天室主流程
      }
    }
  };
  const botRegistry = createBotRegistry({
    onEvent: (event) => {
      for (const cb of agentListeners) {
        try {
          cb(event);
        } catch {
          // 观察者异常不得中断智能体循环
        }
      }
    },
    createEngine: ({ botId, state }) => {
      // F1：apiEngine 已在 main.ts 启动前完成健康探测；失效 key 在此处已被清空。
      const apiCfg = options.apiEngine;
      if (apiCfg?.apiKey) {
        return createApiEngine({
          config: {
            baseURL: apiCfg.baseURL,
            apiKey: apiCfg.apiKey,
            model: apiCfg.model,
          },
        });
      }
      return createWebEngine({
        // v0.24：每个 bot 的引擎 dispatch 带上自己的 botId，
        // 使工具执行路由到该 bot 自己的窗口（多窗口寻址）。
        dispatch: (tool, params) => invokeTool(tool, params, botId),
        toolCallCounter: state.toolCallCounter,
        isStopped: () => state.stopFlag.stopped,
        getAutoReply: () => state.lastAutoReply,
        consumeAutoReply: () => {
          const r = { ...state.lastAutoReply };
          state.lastAutoReply.fresh = false;
          return r;
        },
      });
    },
  });

  // M4-B 里程碑1：TaskLoop 装配点（暂不启用，只落位）。
  // 用 hostTools adapter 把宿主工具表接进 TaskLoop 的 ToolExecutor 接口。
  const kernelHistory = createMessageHistory();
  const kernelExecutor = createHostToolsAdapter(hostTools);
  void kernelHistory; void kernelExecutor; // 里程碑2 接开关时启用

  // 主 bot：v0.23 全网页路径下共用 main 窗口（v0.24 起 per-window）。
  // create 是 async（引擎工厂），但 main bot 必须在 stop()/hub 装配前就绪——
  // 启动时同步等待（createDesktopHost 本身不被 await，start() 才对外暴露）。
  let mainBot: BotInstance | null = null;
  const mainBotReady = botRegistry
    .create({ botId: 'main', slotId: 'main' })
    .then((b) => {
      mainBot = b;
    })
    .catch((err) => {
      console.error('[desktop-host] main bot 创建失败', err);
      throw err;
    });

  // v0.27：聊天室成员 bot 预创建 promise（有 chatRooms 时才非 null）。
  // start() 里 await 它，确保 handleUserMessage 被调前成员 bot 就绪。
  let roomBotsReady: Promise<void> | null = null;

  const agent: AgentFacade = {
    sendMessage: (text) => {
      // 面板用户发起智能体任务 = 用户已委托宿主驱动聊天页（网页引擎的运作机制）。
      // 否则每一步 chat-insert/send 都要在聊天页弹同意框，AgentLoop 根本跑不起来。
      // 仅限 chat 驱动两项；file/shell 的同意闸门不受影响。审计照常记录。
      const state = botRegistry.getState('main');
      state?.sessionAllowlist.addPermanent('chat-insert');
      state?.sessionAllowlist.addPermanent('chat-send');

      // TaskLoop 自驱（纯循环控制器，工具执行仍在 engine 内部）
      return mainBotReady.then(async () => {
          if (!mainBot) throw new Error('main bot not ready');
          const loop = createTaskLoop({
            engine: mainBot.engine,
            history: kernelHistory,
            maxRounds: 25,
          });
          const result = await loop.run(`${AGENT_SENTINEL}${text}`);
          // content 已落 kernelHistory，签名是 Promise<void>
          void result;
        });
    },
    stop: () => mainBot?.loop.stop(),
    get running() {
      return mainBot?.loop.running ?? false;
    },
    health: () => (mainBot ? mainBot.engine.health() : Promise.resolve({ ok: false, reason: 'bot-not-ready' })),
    pickFolder: () => pickFolderViaDialog(),
  };

  // v0.9：外部 agent 控制链——发消息到页面并等待最终回答。
  // 收集 AgentLoop 的 assistant 事件作为最终回答返回。
  async function agentSender(text: string): Promise<string> {
    const state = botRegistry.getState('main');
    state?.sessionAllowlist.addPermanent('chat-insert');
    state?.sessionAllowlist.addPermanent('chat-send');
    let finalAnswer = '';
    const listener = (event: AgentLoopEvent) => {
      if (event.type === 'assistant' && event.text) {
        finalAnswer = event.text;
      }
    };
    agentListeners.add(listener);
    try {
      if (!mainBot) await mainBotReady;
      if (!mainBot) throw new Error('main bot not ready');
      // TaskLoop 路径
      const loop = createTaskLoop({
        engine: mainBot.engine,
        history: kernelHistory,
        maxRounds: 25,
      });
      const result = await loop.run(`${AGENT_SENTINEL}${text}`);
      return result.content || finalAnswer;
    } finally {
      agentListeners.delete(listener);
    }
  }

  // —— v0.27：聊天室运行时装配 ——
  // 仅当 options.chatRooms 非空时装配；否则 chatRoomRuntime=null，原直发路径不变。
  // 需要：完整 SlotRuntime（含 loadPersona/loaded/renderPersonaBlock）+ 算法层 + 数据层。
  let chatRoomRuntime: ChatRoomRuntime | null = null;
  if (options.chatRooms && options.chatRooms.length > 0) {
    // 构建（或复用）完整 SlotRuntime
    const fullSlotRuntime: SlotRuntime =
      options.slotRuntime && 'loadPersona' in options.slotRuntime
        ? (options.slotRuntime as SlotRuntime)
        : createSlotRuntime({
            registry: botRegistry,
            personas: options.personas ?? new FilePersonaRegistry(),
            invokeTool,
          });
    const personas = options.personas ?? new FilePersonaRegistry();
    const memStore = getMemoryStore();
    const chatMessageStore = new SqliteChatMessageStore(memStore);
    const snapshots = new SnapshotStore(memStore);
    const summarizer = createModelSummarizer({
      registry: botRegistry,
      onAgentEvent: (cb) => { agentListeners.add(cb); return () => agentListeners.delete(cb); },
    });
    const chatContextEngine = new SqliteContextEngine({
      messageStore: chatMessageStore,
      memoryStore: memStore,
      summarizer: summarizer as never,
    });
    const chatSummaryService = new SqliteRoomSummaryService({
      messageStore: chatMessageStore,
      memoryStore: memStore,
      summarizer: summarizer as never,
      snapshots,
    });
    const chatMentionParser = new DefaultMentionParser();
    // v0.29：会议生命周期 —— 独立于 chat_snapshots 的状态表 + 主 bot 策略生成器。
    // meetingState 复用 memStore 连接（同 chat_messages/chat_snapshots 库，独立表零迁移）。
    // strategyGenerator 复用 summarizer 同款 agentSender 模式，让主 bot 产结构化策略。
    const chatRoomStateStore = new SqliteRoomStateStore(memStore);
    const strategyGenerator = createStrategyGenerator({
      registry: botRegistry,
      onAgentEvent: (cb) => { agentListeners.add(cb); return () => agentListeners.delete(cb); },
    });
    // v0.30：审计会议 —— 离线执行器 + ReportStore + AuditDispatcher。
    // auditSlotRegistry 用 S1-S5 工作槽（CB 的 FileSlotRegistry，1:1:1 铁律）。
    // Scheduler 注入 offlineRunExecutor 作 runner：assign 调 runner（副作用写 reportStore）
    // + 自动 release slot（scheduler.ts:83-89）。slotId===botId（offline-runner 读取）。
    // reportStore 用 CB 交付的 FileReportStore（FS 落盘，runs/<batchId>/ 下 .jsonl +
    // .report.json + summary.md）——v0.31 决策门的"落盘"项要求真实文件可读，
    // InMemoryReportStore 仅测试桩，真机必须走 FS 版。
    const auditSlotRegistry = new FileSlotRegistry({ slotIds: ['S1', 'S2', 'S3', 'S4', 'S5'] });
    const auditReportStore = new FileReportStore();
    // 任务级事件（task-progress/task-complete）由 runner 发出——它知道每个任务的粒度；
    // 批次级 report-ready 由 dispatcher 发出。两者都经 emitChatRoomEvent → UI。
    const offlineRunExecutor = createOfflineRunExecutor({
      registry: botRegistry,
      slotRuntime: fullSlotRuntime,
      onAgentEvent: (cb) => { agentListeners.add(cb); return () => agentListeners.delete(cb); },
      reportStore: auditReportStore,
      // 预检：槽必须有已连接的可信页（hub 在 start() 里建，闭包按调用时读取）。
      // 无窗口时立即失败并给出准确原因，而不是让 chat-read 轮询空转到 120s 超时。
      hasWindowFor: (botId) =>
        !!hub && hub.trustedPages.some((p) => (p.botId ?? 'main') === botId),
      onTaskProgress: (event) => emitChatRoomEvent(event),
      onTaskComplete: (event) => emitChatRoomEvent(event),
    });
    const auditScheduler = new Scheduler({
      slots: auditSlotRegistry,
      personas,
      runner: offlineRunExecutor,
    });
    const auditDispatcher = createAuditDispatcher({
      scheduler: auditScheduler,
      reportStore: auditReportStore,
      onReportReady: (event) => emitChatRoomEvent(event),
    });
    chatRoomRuntime = createChatRoomRuntime({
      mentionParser: chatMentionParser,
      handoffParser: new DefaultHandoffParser(chatMentionParser),
      instructionBuilder: createAgentInstructionBuilder(),
      messageStore: chatMessageStore,
      contextEngine: chatContextEngine,
      summaryService: chatSummaryService,
      registry: botRegistry,
      slotRuntime: fullSlotRuntime,
      personas,
      onAgentEvent: (cb) => { agentListeners.add(cb); return () => agentListeners.delete(cb); },
      rooms: options.chatRooms,
      maxDepth: options.chatRoomMaxDepth,
      onBotReply: (event) => {
        // v0.28：bot 回复落盘后，CB 已构造好 ChatRoomBotReplyEvent（含 roomId/persona/content/messageId）。
        // 经 chatRoomListeners → agent-channel broadcast 成 {type:'chat-room-event'}，UI 据此渲染气泡。
        emitChatRoomEvent(event);
      },
      onSummary: (event) => {
        // v0.28：摘要落快照成功后，CB 已构造好 ChatRoomSummaryEvent。同样经结构化通道推 UI。
        emitChatRoomEvent(event);
      },
      // v0.29：一轮讨论完成 → 推 round-complete 事件，让 UI 解锁输入框。
      // 必要性：v0.28 UI 的 roundInProgress 仅靠 main bot 摘要器 done 事件复位；
      // v0.29 无会议时跳过 summarize()，main bot 不跑，done 不发 → 输入框永久锁死。
      // 这个事件给 UI 确定性的轮次结束信号，不依赖摘要是否跑。
      onRoundComplete: (round) => {
        emitChatRoomEvent({
          kind: 'round-complete',
          roomId: round.roomId,
          memberCount: round.members.length,
          timestamp: Date.now(),
        });
      },
      // v0.29：会议状态变更 → 同样走 emitChatRoomEvent（非 hub —— 聊天室 UI 连 /agent-ws，
      // PageRuntimeHub 服务的 /studio 页面 WS 收不到）。复用 onBotReply/onSummary 同条路。
      meetingState: chatRoomStateStore,
      strategyGenerator,
      onMeetingStateChange: (roomId, status, strategy) => {
        emitChatRoomEvent({
          kind: 'meeting-state',
          roomId,
          status,
          strategy,
          timestamp: Date.now(),
        });
      },
      // v0.30：审计会议调度器（触发离线审计）。任务/报告事件在 runner + dispatcher
      // 创建处直接接 emitChatRoomEvent（见上方 offlineRunExecutor / auditDispatcher）。
      auditDispatcher,
    });

    // 预创建聊天室成员 bot + 加载人设。
    // buildParticipants 遍历 room.memberPersonas 查 registry.get(name)——未创建的 bot 不进 participants。
    // 这里把配置里声明的成员全部预创建，并加载对应 persona（SlotRuntime.loadPersona 幂等）。
    // 不 await（与 mainBotReady 同模式：start() 里 await）。
    const memberPersonas = new Set<string>();
    for (const room of options.chatRooms) {
      for (const name of room.memberPersonas) {
        if (name === 'main') continue; // main 已单独创建
        memberPersonas.add(name);
      }
      if (room.hostPersona && room.hostPersona !== 'main') memberPersonas.add(room.hostPersona);
    }
    roomBotsReady = Promise.all(
      [...memberPersonas].map(async (name) => {
        // 已创建则跳过（避免 main 重入或重复配置）
        if (botRegistry.get(name)) return;
        try {
          await botRegistry.create({ botId: name, slotId: name });
          await fullSlotRuntime.loadPersona(name, name);
        } catch (err) {
          console.warn(`[desktop-host] 聊天室成员 bot ${name} 创建/加载人设失败:`, err);
        }
      }),
    ).then(() => undefined);

    // v0.30：预创建审计工作槽 bot（S1-S5）。botId=slotId（offline-runner 读取 slotId===botId）。
    // 人设不在此加载——SlotRuntime.run 会按 handle.persona（'audit-expert'）幂等加载，
    // 离线执行器 finally 补 unloadPersona。这里只保证 registry.get('S1') 能取到 BotInstance。
    // 复用 roomBotsReady 的 await 时序（start() 里 await，审计 bot 在 agent-channel 启动前就绪）。
    const prevReady = roomBotsReady;
    roomBotsReady = (prevReady ?? Promise.resolve()).then(() =>
      Promise.all(
        ['S1', 'S2', 'S3', 'S4', 'S5'].map(async (slotId) => {
          if (botRegistry.get(slotId)) return;
          try {
            await botRegistry.create({ botId: slotId, slotId });
          } catch (err) {
            console.warn(`[desktop-host] 审计槽 bot ${slotId} 创建失败:`, err);
          }
        }),
      ).then(() => undefined),
    );
  }

  /** 切换审批档位并持久化（channel 与 DesktopHost 返回对象共用）。 */
  function setPolicyMode(mode: PolicyMode): void {
    if (!(POLICY_MODES as readonly string[]).includes(mode)) {
      throw new Error(`unknown policy mode: ${String(mode)}`);
    }
    policyMode = mode;
    // QD-R2-08：策略档位切换 → 旧 allow-session 授权一律作废（档位语义变了）。
    sessionAllowlist.clear();
    for (const bot of botRegistry.list()) botRegistry.getState(bot.id)?.sessionAllowlist.clear();
    const persist = persistConfigPatch({ policyMode: mode });
    if (!persist.ok) console.warn(`[desktop-host] policyMode 持久化失败: ${persist.error}`);
  }

  /** 热切换工作区并持久化；目录校验 fail-closed。 */
  function setWorkspaceRoot(target: string | null): { ok: boolean; error?: string } {
    if (target === null) {
      mutableWorkspace.setRoot(null);
      // QD-R2-08：工作区边界变化 → 旧 allow-session 授权一律作废。
      sessionAllowlist.clear();
      for (const bot of botRegistry.list()) botRegistry.getState(bot.id)?.sessionAllowlist.clear();
      const persist = persistConfigPatch({ workspaceRoot: '' });
      if (!persist.ok) console.warn(`[desktop-host] workspaceRoot 持久化失败: ${persist.error}`);
      return { ok: true };
    }
    if (!statSyncSafe(target)) {
      return { ok: false, error: 'not-a-directory' };
    }
    mutableWorkspace.setRoot(target);
    sessionAllowlist.clear();
    for (const bot of botRegistry.list()) botRegistry.getState(bot.id)?.sessionAllowlist.clear();
    const persist = persistConfigPatch({ workspaceRoot: mutableWorkspace.root });
    if (!persist.ok) console.warn(`[desktop-host] workspaceRoot 持久化失败: ${persist.error}`);
    return { ok: true };
  }

  // 每请求重新取令牌集合，使轮换无需重启进程（默认不自动轮换，见 rotateApiToken）
  const authenticator = createBearerAuthenticator(() => apiTokenRing.accepted);
  const backend = createFakeOfficialBackend();

  // v0.12 Phase 2：自动化调度引擎
  const automationManager: AutomationManager = createAutomationManager({
    onTaskTrigger: async (task) => {
      if (task.type === 'prompt' && task.payload.prompt) {
        // 通过 agentSender 发送提示词到页面
        try {
          await agentSender(task.payload.prompt);
        } catch (err) {
          console.warn(`[automation] prompt task failed: ${err}`);
        }
      }
    },
  });
  automationManager.start();

  const server: ApiServer = createApiServer({
    config: options.config,
    backend,
    authenticator,
    toolExecutor: (tool, params) => invokeTool(tool, params),
    // 审计经 HTTP 可读（v0.3 遗留 3.2.4 的验收条件：审计可读）
    auditReader: (limit) => audit.list(limit),
    // v0.9：工具目录 API。
    toolCatalog: () => registry.list().map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      risk: d.risk,
      side: executionSide(d),
    })),
    rateLimit: options.rateLimit,
    agentPage: options.agentPage,
    agentLanAccess: options.agentLanAccess,
    agentSender,
    automationManager: automationManager as NonNullable<import('../api/server').ApiServerOptions['automationManager']>,
    debugEval: (code) => new Promise((resolve) => {
      const requestId = 'dbg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout 5s' }), 5000);
      debugEvalPending.set(requestId, { resolve, timer });
      hub?.broadcastDebugEval(requestId, code);
    }),
  });

  // v0.7：全局 KV 存储（页端 chrome.storage shim 经 ws 读写此 backend，落盘）。
  const storageFilePath = path.join(os.homedir(), '.config', 'deepseek-studio', 'storage.json');
  const kvBackend = createFileStorageKvBackend({ filePath: storageFilePath });
  const kvCache: Record<string, unknown> = {};
  let kvLoaded = false;
  async function kvGet(key: string): Promise<unknown> {
    if (!kvLoaded) {
      Object.assign(kvCache, await kvBackend.readAll());
      kvLoaded = true;
    }
    return kvCache[key];
  }
  async function kvSet(key: string, value: unknown): Promise<void> {
    await kvGet(key); // ensure loaded
    kvCache[key] = value;
    await kvBackend.writeBatch({ set: { [key]: value }, remove: [] });
  }
  async function kvRemove(key: string): Promise<void> {
    await kvGet(key);
    delete kvCache[key];
    await kvBackend.writeBatch({ set: {}, remove: [key] });
  }

  let epoch = 0;
  let hub: PageRuntimeHub | null = null;
  const debugEvalPending = new Map<string, { resolve: (r: { ok: boolean; result?: string; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
  let agentChannel: AgentChannel | null = null;
  const sessionAllowlist = new SessionAllowlist();

  function randomCallId(): string {
    return crypto.randomUUID();
  }

  async function executeTool(name: string, params: unknown, grantToken: string, botId?: string): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    // 审计上下文随链路推进逐步补全（grantId/origin/risk/side）。
    // 所有拒绝分支一律经由 finish() 出口，确保「没有一条调用走出未被留痕的路径」——
    // 这是 v0.5 引入高风险能力（shell/file）后唯一能证明 fail-closed 真的生效的手段。
    // outcome 初值取 'denied' 仅为满足类型；下方每个出口都会覆盖成真实终态。
    let ctx: AuditInput = { tool: name, summary: summarizeParams(params, name), origin: '', outcome: 'denied' };

    const finish = (outcome: AuditOutcome, reason: string): ToolExecutionResult => {
      audit.record({ ...ctx, outcome, reason, durationMs: Date.now() - startedAt });
      return { ok: false, reason };
    };

    // 1) 授权先于执行：consume 失败（重放/过期/错误密钥/畸形令牌）→ fail-closed 拒绝。
    //    consume 遇到畸形令牌（atob 抛错）也按 malformed 处理，绝不向上冒泡崩溃。
    let verification: Awaited<ReturnType<typeof authority.consume>>;
    try {
      verification = await authority.consume(grantToken);
    } catch {
      return finish('malformed', 'malformed');
    }
    if (!verification.ok) {
      return finish('denied', verification.reason ?? 'denied');
    }
    const grantOrigin = verification.grant?.origin ?? '';
    ctx = { ...ctx, grantId: verification.grant?.grantId, origin: grantOrigin };

    // 2) 治理闸门：工具必须登记在册，且 grant 的发起 origin 命中其 allowlist。
    //    fail-closed——未登记工具或 origin 不在白名单，一律拒绝执行（R2 站点隔离）。
    const def = registry.get(name);
    if (!def) {
      return finish('unknown-capability', 'unknown-capability');
    }
    const side: ExecutionSide = executionSide(def);
    ctx = { ...ctx, risk: def.risk, side };
    // 3) 能力存在性闸门：按执行侧查对应能力表——
    //    宿主侧查 hostTools（ExecutableCapability），页端查 capabilities（DOM 生命周期控制器）。
    const executor = side === 'host' ? hostTools.get(name) : capabilities.get(name);
    if (!executor) {
      return finish('unknown-capability', 'unknown-capability');
    }
    // R2-05：宿主内部 origin（HOST_INTERNAL_ORIGIN）显式放行；页面来源仍必须命中白名单，
    // 闸门不再因硬编码 DEEPSEEK_ORIGIN 而对内部调用恒真。
    if (grantOrigin !== HOST_INTERNAL_ORIGIN && !registry.isOriginAllowed(name, grantOrigin)) {
      return finish('origin-denied', 'origin-denied');
    }
    // 4) 策略闸门（v0.5）：宿主本机型能力（shell / file）先过三档策略。
    //    受管辖工具以策略结论为准；其它工具沿用 risk 阈值闸门。
    const paramsBag = (params ?? {}) as Record<string, unknown>;
    let consentMeta: ConsentMeta | undefined;
    let requiresHumanConsent = needsConsent(def);
    /** 本次调用是否被批准越出工作区（仅由策略结论或用户同意置真）。 */
    let outsideApproved = false;

    if (isFileTool(name) || isProcessTool(name)) {
      // 传给策略层的永远是当前真实工作区（可变代理解引用），保持 policy 纯函数语义。
      // v0.9：额外可信目录（STUDIO_TRUSTED_DIRS 环境变量，分号分隔）。
      const trustedDirs = (process.env.STUDIO_TRUSTED_DIRS ?? '').split(';').filter(Boolean);
      const verdict = evaluatePolicy({
        tool: name,
        params: paramsBag,
        mode: policyMode,
        workspace: mutableWorkspace.current,
        trustedDirs,
      });
      ctx = { ...ctx, mode: policyMode };
      requiresHumanConsent = verdict.decision === 'require-consent';
      // 越界授权只能来自两个来源：策略直接放行（full 档），或下面用户明确同意。
      // 绝不允许调用方自己在 params 里声明「我已授权」。
      outsideApproved = verdict.reason === 'outside-workspace' && verdict.decision === 'allow';

      if (verdict.decision === 'deny') return finish('policy-denied', verdict.reason);

      consentMeta = {
        riskLabel: '特权级',
        modeLabel: POLICY_MODE_LABELS[policyMode],
        outside: verdict.reason === 'outside-workspace',
        riskFlagLabels: (verdict.riskFlags ?? []).map(riskLabel),
      };

      // M8-E1：白名单命中则跳过人工 consent
      if (requiresHumanConsent && !outsideApproved) {
        const wsRoot = mutableWorkspace.current?.root ?? null;
        const resolvedPath = typeof paramsBag.path === 'string' ? paramsBag.path : null;
        const relPath = resolvedPath && wsRoot
          ? path.relative(wsRoot, resolvedPath).replace(/\\/g, '/')
          : null;
        const wsHash = wsRoot ? createHash('sha1').update(wsRoot).digest('hex').slice(0, 12) : '';
        const wlResult = routeConsent({
          toolId: name,
          params: paramsBag,
          mode: policyMode,
          policy: verdict.decision,
          policyReason: verdict.reason,
          resolvedPath,
          relPath,
          outside: verdict.reason === 'outside-workspace',
          workspaceRoot: wsRoot,
          workspaceHash: wsHash,
          whitelist: whitelistStore.list(wsHash),
          now: Date.now(),
        });
        if (wlResult.verdict === 'safe' && wlResult.reason === 'whitelist-hit') {
          requiresHumanConsent = false;
        }
      }
    }

    //    同意闸门必须以「阈值比较」判定风险等级 ≥ insert，<｜hy_place▁holder▁no▁813｜>写成
    //    `risk === 'insert' || risk === 'send'`：那种写法在新增更高等级时
    //    TS 不报错、测试全绿，却会静默绕过同意闸门。
    if (requiresHumanConsent) {
      const decision = await ensureConsent(name, params, randomCallId(), consentMeta, botId);
      if (decision === 'consent-unavailable') return finish('consent-unavailable', 'consent-unavailable');
      if (decision === 'consent-denied') return finish('consent-denied', 'consent-denied');
      // 用户明确同意了这次越界请求 → 授予能力层越界授权
      if (consentMeta?.outside) outsideApproved = true;
    }
    // 5) 路由：宿主侧能力在宿主进程内执行；页端能力走页 DOM；无页则回退 Node 能力。
    const result = await routeExecution(def, name, params, outsideApproved, botId);
    audit.record({
      ...ctx,
      outcome: result.ok ? 'executed' : 'execution-failed',
      reason: result.reason,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  /** 同意判定结果：区分「需要却无法征求同意」与「用户明确拒绝」，两者都 fail-closed，但成因不同。 */
  type ConsentGate = 'approved' | 'session-approved' | 'consent-unavailable' | 'consent-denied';

  /** v0.24：取指定 bot 的会话级同意放行表（每 bot 独立，互不串）。
   *  无 botId / bot 未登记 → 回退桌面单例（保持 v0.23 及更早行为，向后兼容）。 */
  function allowlistFor(botId?: string): SessionAllowlist {
    return (botId && botRegistry.getState(botId)?.sessionAllowlist) || sessionAllowlist;
  }

  async function ensureConsent(tool: string, params: unknown, callId: string, meta?: ConsentMeta, botId?: string): Promise<ConsentGate> {
    const allowlist = allowlistFor(botId);
    if (allowlist.has(tool, params)) return 'session-approved';
    if (!hub) return 'consent-unavailable'; // 宿主尚未就绪，无法征求用户同意 → fail-closed
    // 「没有人类在场」与「人类点了拒绝」成因不同，审计必须能区分：
    // 前者是环境问题（窗口关了），后者是用户决策。两者都 fail-closed 拒绝。
    if (botId) {
      // v0.24：只认发起 bot 自己的窗口在场；无对应页 = 无人类在场 → fail-closed。
      if (!hub.connectedPages.some((p) => p.untrusted === false && (p.botId ?? 'main') === (botId ?? 'main'))) {
        return 'consent-unavailable';
      }
    } else if (hub.connectedPages.length === 0) {
      return 'consent-unavailable';
    }
    const decision = await hub.requestConsent(callId, tool, params, meta, botId);
    if (decision === 'allow-session') {
      // QD-R2-08：绑工具+参数指纹+10min TTL，不再永久全局放行。
      allowlist.addTemporary(tool, params, DEFAULT_SESSION_GRANT_TTL_MS);
    }
    return decision !== 'deny' ? 'approved' : 'consent-denied';
  }

  async function routeExecution(
    def: ToolDefinition,
    name: string,
    params: unknown,
    outsideApproved = false,
    botId?: string,
  ): Promise<ToolExecutionResult> {
    // 【v0.5 关键】宿主侧能力优先判定：必须放在「有页连接就派发到页面」之前。
    // 若顺序颠倒，shell/file 会被误派发到页端 host-client，页侧未登记该工具 → unknown-tool；
    // 更糟的情况是页端若被劫持，特权命令就有了被页面驱动的路径。
    if (executionSide(def) === 'host') {
      const tool = hostTools.get(name);
      if (!tool) return { ok: false, reason: 'unknown-capability' };
      // M8-E2：写前快照（file.edit / file.write）
      if ((name === 'file.edit' || name === 'file.write') && typeof (params as Record<string, unknown>)?.path === 'string') {
        const p = (params as Record<string, unknown>).path as string;
        const wsRoot = mutableWorkspace.current?.root;
        if (wsRoot) {
          const relPath = path.relative(wsRoot, p).replace(/\\/g, '/');
          const wsHash = createHash('sha1').update(wsRoot).digest('hex').slice(0, 12);
          shadowStore.capture({ absPath: p, relPath, workspaceHash: wsHash, source: name === 'file.edit' ? 'file.edit' : 'file.write' });
        }
      }
      const r = await tool.execute(params as Record<string, unknown>, { allowOutsideWorkspace: outsideApproved });
      return {
        ok: r.ok,
        reason: r.error,
        data: r.data,
        // v1.2：透传 Pi Agent 风格新格式字段（能力已给了就透传，缺省即回退旧格式）
        ...(r.content !== undefined ? { content: r.content } : {}),
        ...(r.details !== undefined ? { details: r.details } : {}),
        ...(r.isError !== undefined ? { isError: r.isError } : {}),
        ...(r.terminate !== undefined ? { terminate: r.terminate } : {}),
      };
    }
    // 派发只看可信页：被自检判定为篡改的页面不得再收到工具调用
    // v0.24：无 botId → 沿用「任一可信页在场」；有 botId → 该 bot 自己的可信页在场。
    //        不满足则走下方 Node 回退（与原语义一致），而不是拿错窗口的回复。
    if (hub) {
      const targetPages = botId
        ? hub.trustedPages.filter((p) => (p.botId ?? 'main') === botId)
        : hub.trustedPages;
      if (targetPages.length > 0) {
        const r = await hub.dispatch(name, params, randomCallId(), botId);
        return {
          ok: r.ok,
          reason: r.error,
          data: r.data,
          // v1.2：透传新格式字段
          ...(r.content !== undefined ? { content: r.content } : {}),
          ...(r.details !== undefined ? { details: r.details } : {}),
          ...(r.isError !== undefined ? { isError: r.isError } : {}),
          ...(r.terminate !== undefined ? { terminate: r.terminate } : {}),
        };
      }
    }
    // 回退：Node 宿主内 rehydrate。R2-04：只允许无 DOM 依赖的能力（当前仅 echo）。
    // 原实现只要 capabilities.get(name) 存在就 start→stop 并返回 ok:true，chat-send/insert
    // 这类真正需要 DOM 的能力在无页时也假成功，模型基于「已发送」继续推理，比报错更危险。
    const DOM_FREE_FALLBACK = new Set(['echo']);
    const cap = capabilities.get(name);
    if (cap) {
      if (!DOM_FREE_FALLBACK.has(name)) {
        return { ok: false, reason: 'no-page-for-dom-capability' };
      }
      const scope = createHostResourceScope();
      epoch += 1;
      await cap.start(scope, epoch);
      const snapshot = scope.snapshot();
      await cap.stop('manual' as ContentLifecycleStopReason);
      return { ok: true, snapshot };
    }
    return { ok: false, reason: 'no-capability' };
  }

  async function invokeTool(tool: string, params: unknown, botId?: string): Promise<ToolExecutionResult> {
    const grant = await authority.requestToolExecution({
      documentId: 'host-agent',
      sessionId: 'host-agent',
      requestId: crypto.randomUUID(),
      scope: tool,
      // R2-05：使用专用内部 origin，不再硬编码 DEEPSEEK_ORIGIN 让 origin 闸门恒真。
      origin: HOST_INTERNAL_ORIGIN,
    });
    return executeTool(tool, params, grant, botId);
  }

  return {
    authority,
    async start() {
      await server.start();
      // v0.27：确保聊天室成员 bot 预创建完成（main bot 由 mainBotReady 保证）。
      // roomBotsReady 为 null（无 chatRooms）时静默跳过。
      await Promise.allSettled([mainBotReady, roomBotsReady ?? Promise.resolve()]);
      if (options.agentPage) {
        agentChannel = createAgentChannel({
          server: server.rawServer,
          // QD-R2-12：WS 接轮换环，不再传冻结字面量。
          token: () => apiTokenRing.accepted,
          host: {
            bots: {
              get(botId = 'main') {
                const bot = botRegistry.get(botId);
                if (!bot) {
                  // bot 尚未创建 → 返回一个 always-not-running 的占位，
                  // 调用方 sendMessage 会 reject（agent.send 逻辑已处理）。
                  return {
                    sendMessage: () => Promise.reject(new Error(`bot not found: ${botId}`)),
                    stop: () => {},
                    get running() { return false; },
                    health: () => Promise.resolve({ ok: false, reason: `bot not found: ${botId}` }),
                  };
                }
                return {
                  sendMessage: (text) => {
                    const state = botRegistry.getState(botId);
                    state?.sessionAllowlist.addPermanent('chat-insert');
                    state?.sessionAllowlist.addPermanent('chat-send');
                    return bot.loop.send(`${AGENT_SENTINEL}${text}`);
                  },
                  stop: () => bot.loop.stop(),
                  get running() { return bot.loop.running; },
                  health: () => bot.engine.health(),
                };
              },
              list() {
                return botRegistry.list().map((b) => ({ botId: b.id, running: b.loop.running }));
              },
            },
            // v0.27：聊天室运行时。有 chatRooms 配置时才非 null。
            chatRoomRuntime: chatRoomRuntime ?? undefined,
            onAgentEvent: (cb) => {
              agentListeners.add(cb);
              return () => agentListeners.delete(cb);
            },
            // v0.28：聊天室结构化事件订阅（ChatRoomEvent → agent-channel broadcast）。
            onChatRoomEvent: (cb) => {
              chatRoomListeners.add(cb);
              return () => chatRoomListeners.delete(cb);
            },
            // C3：工具运行事件订阅（ToolRunEvent → agent-channel broadcast）
            onToolRunEvent: (cb) => onToolRun(cb),
            get policyMode() {
              return policyMode;
            },
            setPolicyMode,
            get workspaceRoot() {
              return mutableWorkspace.configured ? mutableWorkspace.root : null;
            },
            setWorkspaceRoot,
            pickFolder: () => agent.pickFolder(),
          },
        });
      }
      hub = createPageRuntimeHub({
        server: server.rawServer,
        // QD-R2-12：WS 接轮换环，不再传冻结字面量。
        token: () => apiTokenRing.accepted,
        onError: (m, e) => console.warn(`[page-runtime] ${m}`, e),
        // v0.6：页端 tool-call 的真实执行入口（走完整授权链 + 同意闸门 + 宿主侧能力）。
        // v0.24：botId 透传，工具按发起 bot 的窗口路由 + 其授权/白名单执行。
        // v0.25：该 bot 已加载人设时先经其白名单过滤器（SlotRuntime.executorFor）；
        //        未加载人设 / 未注入 SlotRuntime → 直调 invokeTool（v0.24 行为不变）。
        // 注意：白名单只是「拒绝」的一层，命中后仍回到 invokeTool——不绕过同意闸门。
        executor: (tool, params, botId) => {
          const exec = options.slotRuntime?.executorFor(botId);
          return exec ? exec(tool, params) : invokeTool(tool, params, botId);
        },
        // M1：AgentLoop 依据该计数决定「工具执行完毕 → 请求模型续跑」。
        // v0.24：按发起 botId 累加对应 bot 的独立 counter（main 缺省保持 v0.23 行为）。
        onToolCall: ({ callId, tool, botId }) => {
          const state = botRegistry.getState(botId ?? 'main');
          if (state) state.toolCallCounter.current += 1;
          // C3：记录 tool run started 事件
          pendingRuns.set(callId, { tool, botId: botId ?? 'main', startedAt: Date.now() });
          emitToolRun({ type: 'tool-run', runId: callId, tool, phase: 'started', botId });
        },
        onToolResult: ({ callId, tool, ok, error, botId, details }) => {
          // C3：根据结果发终态事件
          const pending = pendingRuns.get(callId);
          const durationMs = pending ? Date.now() - pending.startedAt : undefined;
          let phase: 'succeeded' | 'failed' | 'denied' | 'cancelled' = 'succeeded';
          let errorCode: string | undefined;
          if (!ok) {
            if (error && /consent-denied|policy-denied|denied/.test(error)) {
              phase = 'denied';
              errorCode = error;
            } else if (error && /cancel|abort|stopped/.test(error)) {
              phase = 'cancelled';
              errorCode = error;
            } else {
              phase = 'failed';
              errorCode = error;
            }
          }
          pendingRuns.delete(callId);
          // X2：仅 file.edit 从 details.path 收产物路径；shell/read/write 等无源不填，不猜。
          const artifactPaths = extractArtifactPaths(tool, details);
          emitToolRun({
            type: 'tool-run',
            runId: callId,
            tool,
            phase,
            durationMs,
            errorCode,
            botId,
            ...(artifactPaths ? { artifactPaths } : {}),
          });
        },
        // T5：页端断开 → pendingRuns 全部未完成 runId 标 failed/page-disconnected 并清空（无定时器）。
        onDisconnect: () => failPendingRunsOnDisconnect(pendingRuns, emitToolRun),
        // v0.9：页端 auto-continue 推送的模型回复（不渲染到 DOM）。
        // v0.24：写入发起 bot 的 lastAutoReply 缓冲。
        onAssistantReply: (text, loop, botId) => {
          console.log(`[desktop-host] onAssistantReply loop=${loop} len=${text.length} botId=${botId ?? 'main'}`);
          const state = botRegistry.getState(botId ?? 'main');
          if (!state) return;
          state.lastAutoReply.text = text;
          state.lastAutoReply.loop = loop;
          state.lastAutoReply.updatedAt = Date.now();
          state.lastAutoReply.fresh = true;
        },
        // M9：流式 delta 转发给对应 bot 的 engine（UI 打字机效果）
        onStreamDelta: (text, botId) => {
          const bot = botId ? botRegistry.get(botId) : mainBot;
          if (bot && 'pushStreamDelta' in bot.engine) {
            (bot.engine as { pushStreamDelta(text: string): void }).pushStreamDelta(text);
          }
        },
        // v0.31 账号身份锁：hello 上报指纹与已登记页重复（同账号双窗口 = 必封）。
        // 该连接已被 page-runtime 标 untrusted + 推阻塞覆盖层（fail-closed）；
        // 本回调仅告警（center 已配 onError 打 warn）。聊天室告警事件待 system-alert kind 落地再加。
        onDuplicateAccount: ({ duplicateBotId, existingBotId, fingerprint }) => {
          const fp = fingerprint.slice(0, 8);
          console.warn(
            `[account-lock] DUPLICATE account fp=${fp}… bot=${duplicateBotId ?? 'main'} ` +
            `already active as bot=${existingBotId ?? 'main'} — duplicate window fail-closed`,
          );
        },
        // v0.7：页端 storage shim 的 KV 落盘 backend。
        kvStore: { get: kvGet, set: kvSet, remove: kvRemove },
        onDebugEvalResult: (requestId, ok, result) => {
          const p = debugEvalPending.get(requestId);
          if (p) { clearTimeout(p.timer); debugEvalPending.delete(requestId); p.resolve({ ok, result }); }
        },
      });
      // v1.0：连接建立后立即推送当前记忆列表。
      const pushMemories = async () => {
        const memories = (await getMemoryStore().list()).map((m) => ({
          id: m.id, type: m.type, name: m.name, content: m.content, tags: m.tags,
        }));
        hub?.broadcastMemories(memories);
      };
      void pushMemories();
      // v1.0：确保技能目录存在
      ensureSkillsDir();
      // v1.0：确保 MCP 配置文件存在
      ensureMcpConfig();
    },
    async stop() {
      agentChannel?.dispose();
      agentChannel = null;
      hub?.dispose();
      hub = null;
      await server.stop();
    },
    get url() {
      return server.url;
    },
    issueGrant: (input) => authority.requestToolExecution(input),
    executeTool,
    invokeTool,
    audit,
    rotateApiToken: (next) => apiTokenRing.rotate(next),
    rotateHostSecret: (next) => hostSecretRing.rotate(next),
    get currentApiToken() {
      return apiTokenRing.current;
    },
    resolveSide: (name) => {
      const def = registry.get(name);
      return def ? executionSide(def) : DEFAULT_EXECUTION;
    },
    get policyMode() {
      return policyMode;
    },
    setPolicyMode,
    setWorkspaceRoot,
    get workspaceRoot() {
      return mutableWorkspace.configured ? mutableWorkspace.root : null;
    },
    agent,
    onAgentEvent(cb) {
      agentListeners.add(cb);
      return () => agentListeners.delete(cb);
    },
    // v0.28：聊天室结构化事件订阅（供 agent-channel 以外的消费方使用）。
    onChatRoomEvent(cb) {
      chatRoomListeners.add(cb);
      return () => chatRoomListeners.delete(cb);
    },
    // C3：结构化工具运行事件订阅（供 Workbench UI 消费）
    onToolRun,
  };
}

/**
 * T5：页端断线兜底——把 pendingRuns 中所有未完成 runId 统一标 failed / page-disconnected，再清空。
 * 纯函数：原地消费传入的 Map，不新建定时器；供 hub onDisconnect 接线与单测复用。
 */
export function failPendingRunsOnDisconnect(
  pending: Map<string, { tool: string; botId: string; startedAt: number }>,
  emit: (event: import('../shared/tool-run-event').ToolRunEvent) => void,
): void {
  for (const [callId, entry] of pending) {
    emit({
      type: 'tool-run',
      runId: callId,
      tool: entry.tool,
      phase: 'failed',
      errorCode: 'page-disconnected',
      botId: entry.botId,
      durationMs: Date.now() - entry.startedAt,
    });
  }
  pending.clear();
}

/**
 * X2：从工具结果 details 提取产物路径，供 ToolRunEvent.artifactPaths。
 * 仅 file.edit 有 details.path（EditEngineData）；shell / file.read / file.write 等
 * 无产物路径源，返回 undefined（不猜、不填 data.path）。纯函数，供单测复用。
 */
export function extractArtifactPaths(tool: string, details?: Record<string, unknown>): string[] | undefined {
  if (tool !== 'file.edit') return undefined;
  const p = details?.path;
  if (typeof p === 'string' && p.trim()) return [p.trim()];
  return undefined;
}

/** 目录校验：不存在或不是目录返回 null（供 setWorkspaceRoot fail-closed）。 */
function statSyncSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
