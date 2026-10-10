/**
 * 常驻桌面宿主（v0.2 Node 原型）
 *
 * 组合两件事：
 *   1. 本地 HTTP API（createApiServer，8756，fake backend）
 *   2. 工具执行授权方（createPlatformDesktop，签发一次性 grant）
 *
 * 暴露 executeTool：先 consume grant（校验 + 一次性消费）→ 再 rehydrate/执行能力。
 * 这是「授权先于执行」硬不变量的落点。v0.7 起由 Rust 主进程托管，本文件逻辑上等价。
 */

import { createApiServer, type ApiServer, type RateLimitOptions } from '../api/server';
import { createBearerAuthenticator } from '../api/auth';
import { createFakeOfficialBackend } from '../api/official-backend';
import { createPlatformDesktop, type PlatformDesktop } from './platform-desktop';
import { createSecretRing, type SecretRing } from './host-token';
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
import { DEFAULT_TOOL_DEFINITIONS, DEEPSEEK_ORIGIN } from './tool-definitions';
import { createPageRuntimeHub, type PageRuntimeHub } from './page-runtime';
import { createAgentLoop, AGENT_SENTINEL, type AgentLoop, type AgentLoopEvent } from './agent-loop';
import { createAgentChannel, type AgentChannel } from './agent-channel';
import { pickFolderViaDialog } from './folder-picker';
import { createWebEngine } from './engine/web-engine';
import { createFileStorageKvBackend } from './file-storage-backend';
import os from 'node:os';
import path from 'node:path';
import type { ModelEngine } from './engine/model-engine';
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
import {
  createMutableWorkspace,
  createWorkspace,
  persistConfigPatch,
  resolveWorkspaceRoot,
  type MutableWorkspaceContext,
  type WorkspaceContext,
} from './workspace';
import { statSync } from 'node:fs';
import { createShellCapability } from '../capabilities/shell';
import { createFileTools } from '../capabilities/file';
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
  /** 限流与并发（透传给 API server，默认串行 + 60/分钟）。 */
  rateLimit?: RateLimitOptions;
  /**
   * M1 智能体面板静态资源（磁盘路径）。提供后开放 GET /agent 与 GET /agent.js，
   * 并挂载 /agent-ws 通道；缺省则面板路由整体不可用（fail-closed）。
   */
  agentPage?: { htmlPath: string; jsPath: string; cssPath: string };
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
}

export interface DesktopHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  readonly authority: PlatformDesktop;
  /** 签发一张一次性 tool grant（常驻宿主侧调用）。 */
  issueGrant(input: IssueGrantInput): Promise<string>;
  /** 持 grant 执行能力：先 consume（失败即拒绝），再 start/stop。 */
  executeTool(name: string, params: unknown, grantToken: string): Promise<ToolExecutionResult>;
  /** 便捷入口：已鉴权的 agent 经此发起工具调用（内部签发+消费一次性 grant，再走同意闸门与页端路由）。 */
  invokeTool(tool: string, params: unknown): Promise<ToolExecutionResult>;
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

export function createDesktopHost(options: DesktopHostOptions): DesktopHost {
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

  // 宿主侧能力表（v0.5：shell / file）。与页端能力分表：
  // 它们没有 DOM 生命周期，强行塞进 ContentCapabilityController 会违反「资源所有权归上游」不变量。
  const hostTools = new Map<string, ExecutableCapability>(
    Object.entries(
      options.hostTools ?? {
        'shell.exec': createShellCapability({ workspace: mutableWorkspace }),
        ...createFileTools({ workspace: mutableWorkspace }),
        'skill.list': {
          id: 'skill.list',
          async execute(): Promise<ExecuteResult> {
            return {
              ok: true,
              data: {
                skills: [
                  { id: 'file-ops', name: '文件操作', description: '读取/写入/列出工作区内文件', tools: ['file.read', 'file.write', 'file.list', 'file.stat'] },
                  { id: 'shell-ops', name: '命令执行', description: '在宿主进程内以 argv 方式执行命令', tools: ['shell.exec'] },
                ],
              },
            };
          },
        },
      },
    ),
  );

  // 治理层：声明已登记工具 + 风险等级 + 站点 allowlist（v0.3.1）。
  const registry: ToolRegistry = createToolRegistry(DEFAULT_TOOL_DEFINITIONS);

  // 审计环：全链路执行留痕（还清 v0.3 遗留 3.2.4）。
  const audit: AuditLog = createAuditLog(options.auditCapacity ?? DEFAULT_AUDIT_CAPACITY);

  // —— M1 智能体：网页模型引擎 + AgentLoop ——
  // 工具执行不在 loop 内重复实现：引擎把消息灌进聊天页，页端拦截器解析工具标签
  // 反向投递到 invokeTool（完整授权链），结果由拦截器 pending 回填下一次请求。
  // 这里只维护「每步工具调用计数」与「停止旗标」两个协调状态。
  const agentToolCounter = { current: 0 };
  const agentStopFlag = { stopped: false };
  const agentListeners = new Set<(event: AgentLoopEvent) => void>();
  const webEngine: ModelEngine = createWebEngine({
    dispatch: (tool, params) => invokeTool(tool, params),
    toolCallCounter: agentToolCounter,
    isStopped: () => agentStopFlag.stopped,
  });
  const agentLoop: AgentLoop = createAgentLoop({
    engine: webEngine,
    stopFlag: agentStopFlag,
    onEvent: (event) => {
      for (const cb of agentListeners) {
        try {
          cb(event);
        } catch {
          // 观察者异常不得中断智能体循环
        }
      }
    },
  });
  const agent: AgentFacade = {
    sendMessage: (text) => {
      // 面板用户发起智能体任务 = 用户已委托宿主驱动聊天页（网页引擎的运作机制）。
      // 否则每一步 chat-insert/send 都要在聊天页弹同意框，AgentLoop 根本跑不起来。
      // 仅限 chat 驱动两项；file/shell 的同意闸门不受影响。审计照常记录。
      sessionAllowlist.add('chat-insert');
      sessionAllowlist.add('chat-send');
      return agentLoop.send(`${AGENT_SENTINEL}${text}`);
    },
    stop: () => agentLoop.stop(),
    get running() {
      return agentLoop.running;
    },
    health: () => webEngine.health(),
    pickFolder: () => pickFolderViaDialog(),
  };

  /** 切换审批档位并持久化（channel 与 DesktopHost 返回对象共用）。 */
  function setPolicyMode(mode: PolicyMode): void {
    if (!(POLICY_MODES as readonly string[]).includes(mode)) {
      throw new Error(`unknown policy mode: ${String(mode)}`);
    }
    policyMode = mode;
    const persist = persistConfigPatch({ policyMode: mode });
    if (!persist.ok) console.warn(`[desktop-host] policyMode 持久化失败: ${persist.error}`);
  }

  /** 热切换工作区并持久化；目录校验 fail-closed。 */
  function setWorkspaceRoot(target: string | null): { ok: boolean; error?: string } {
    if (target === null) {
      mutableWorkspace.setRoot(null);
      const persist = persistConfigPatch({ workspaceRoot: '' });
      if (!persist.ok) console.warn(`[desktop-host] workspaceRoot 持久化失败: ${persist.error}`);
      return { ok: true };
    }
    if (!statSyncSafe(target)) {
      return { ok: false, error: 'not-a-directory' };
    }
    mutableWorkspace.setRoot(target);
    const persist = persistConfigPatch({ workspaceRoot: mutableWorkspace.root });
    if (!persist.ok) console.warn(`[desktop-host] workspaceRoot 持久化失败: ${persist.error}`);
    return { ok: true };
  }

  // 每请求重新取令牌集合，使轮换无需重启进程（默认不自动轮换，见 rotateApiToken）
  const authenticator = createBearerAuthenticator(() => apiTokenRing.accepted);
  const backend = createFakeOfficialBackend();
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
  let agentChannel: AgentChannel | null = null;
  const sessionAllowlist = new Set<string>();

  function randomCallId(): string {
    return crypto.randomUUID();
  }

  async function executeTool(name: string, params: unknown, grantToken: string): Promise<ToolExecutionResult> {
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
    if (!registry.isOriginAllowed(name, grantOrigin)) {
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
    }

    //    同意闸门必须以「阈值比较」判定风险等级 ≥ insert，<｜hy_place▁holder▁no▁813｜>写成
    //    `risk === 'insert' || risk === 'send'`：那种写法在新增更高等级时
    //    TS 不报错、测试全绿，却会静默绕过同意闸门。
    if (requiresHumanConsent) {
      const decision = await ensureConsent(name, params, randomCallId(), consentMeta);
      if (decision === 'consent-unavailable') return finish('consent-unavailable', 'consent-unavailable');
      if (decision === 'consent-denied') return finish('consent-denied', 'consent-denied');
      // 用户明确同意了这次越界请求 → 授予能力层越界授权
      if (consentMeta?.outside) outsideApproved = true;
    }
    // 5) 路由：宿主侧能力在宿主进程内执行；页端能力走页 DOM；无页则回退 Node 能力。
    const result = await routeExecution(def, name, params, outsideApproved);
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

  async function ensureConsent(tool: string, params: unknown, callId: string, meta?: ConsentMeta): Promise<ConsentGate> {
    if (sessionAllowlist.has(tool)) return 'session-approved';
    if (!hub) return 'consent-unavailable'; // 宿主尚未就绪，无法征求用户同意 → fail-closed
    // 「没有人类在场」与「人类点了拒绝」成因不同，审计必须能区分：
    // 前者是环境问题（窗口关了），后者是用户决策。两者都 fail-closed 拒绝。
    if (hub.connectedPages.length === 0) return 'consent-unavailable';
    const decision = await hub.requestConsent(callId, tool, params, meta);
    if (decision === 'allow-session') sessionAllowlist.add(tool);
    return decision !== 'deny' ? 'approved' : 'consent-denied';
  }

  async function routeExecution(
    def: ToolDefinition,
    name: string,
    params: unknown,
    outsideApproved = false,
  ): Promise<ToolExecutionResult> {
    // 【v0.5 关键】宿主侧能力优先判定：必须放在「有页连接就派发到页面」之前。
    // 若顺序颠倒，shell/file 会被误派发到页端 host-client，页侧未登记该工具 → unknown-tool；
    // 更糟的情况是页端若被劫持，特权命令就有了被页面驱动的路径。
    if (executionSide(def) === 'host') {
      const tool = hostTools.get(name);
      if (!tool) return { ok: false, reason: 'unknown-capability' };
      const r = await tool.execute(params as Record<string, unknown>, { allowOutsideWorkspace: outsideApproved });
      return { ok: r.ok, reason: r.error, data: r.data };
    }
    // 派发只看可信页：被自检判定为篡改的页面不得再收到工具调用
    if (hub && hub.trustedPages.length > 0) {
      const r = await hub.dispatch(name, params, randomCallId());
      return { ok: r.ok, reason: r.error, data: r.data };
    }
    // 回退：Node 宿主内 rehydrate（仅 echo 等无 DOM 依赖能力）。
    const cap = capabilities.get(name);
    if (cap) {
      const scope = createHostResourceScope();
      epoch += 1;
      await cap.start(scope, epoch);
      const snapshot = scope.snapshot();
      await cap.stop('manual' as ContentLifecycleStopReason);
      return { ok: true, snapshot };
    }
    return { ok: false, reason: 'no-capability' };
  }

  async function invokeTool(tool: string, params: unknown): Promise<ToolExecutionResult> {
    const grant = await authority.requestToolExecution({
      documentId: 'host-agent',
      sessionId: 'host-agent',
      requestId: crypto.randomUUID(),
      scope: tool,
      origin: DEEPSEEK_ORIGIN,
    });
    return executeTool(tool, params, grant);
  }

  return {
    authority,
    async start() {
      await server.start();
      if (options.agentPage) {
        agentChannel = createAgentChannel({
          server: server.rawServer,
          token: options.config.token,
          host: {
            agent,
            onAgentEvent: (cb) => {
              agentListeners.add(cb);
              return () => agentListeners.delete(cb);
            },
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
        onError: (m, e) => console.warn(`[page-runtime] ${m}`, e),
        // v0.6：页端 tool-call 的真实执行入口（走完整授权链 + 同意闸门 + 宿主侧能力）。
        executor: (tool, params) => invokeTool(tool, params),
        // M1：AgentLoop 依据该计数决定「工具执行完毕 → 请求模型续跑」。
        onToolCall: () => {
          agentToolCounter.current += 1;
        },
        // v0.7：页端 storage shim 的 KV 落盘 backend。
        kvStore: { get: kvGet, set: kvSet, remove: kvRemove },
      });
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
  };
}

/** 目录校验：不存在或不是目录返回 null（供 setWorkspaceRoot fail-closed）。 */
function statSyncSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
