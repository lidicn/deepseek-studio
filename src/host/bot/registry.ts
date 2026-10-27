/**
 * BotRegistry（Bot 平台 v0.23 · Claude 主开发）
 *
 * 把 desktop-host 的「单 agent 单例装配」改为「N bot 注册表」。
 * 每个 BotInstance 独立持有：
 *   - toolCallCounter / stopFlag / lastAutoReply / sessionAllowlist（原 desktop-host lines 540-544 的单实例）
 *   - 自己的 AgentLoop（createAgentLoop 已是工厂，天然支持多实例）
 *   - 自己的 ModelEngine（由宿主经 createEngine 注入，v0.23 共用 main 窗口；v0.24 起 per-window）
 *
 * 事件流：loop 的 onEvent 经 deps.onEvent 推给宿主广播层，事件已带 botId 标签
 * （agent-loop.ts 的 emit 戳 stamp）。
 *
 * 主 bot（botId='main'）作为第一个 BotInstance 启动时创建，其 state 由 desktop-host
 * 接到 hub 的 onToolCall/onAssistantReply 回调——与改造前行为一致（向后兼容）。
 */

import { createAgentLoop, type AgentLoop, type AgentLoopEvent } from '../agent-loop';
import type { ToolExecutionResult } from '../desktop-host';
import type { ModelEngine } from '../engine/model-engine';
import type { BotInstance, BotRegistry, Persona } from './types';

/** WebEngine 所需的 auto-reply 缓冲形状（与 web-engine.ts WebEngineOptions 对齐）。 */
export interface AutoReplyBuffer {
  text: string;
  loop: number;
  /** R-W4：单调代次，不随 loopDepth 归零；消费时比对 seq > lastConsumedSeq。 */
  seq: number;
  updatedAt: number;
  fresh: boolean;
}

import type { ApprovalClass, GrantScope } from '../../shared/consent-contract';

/**
 * QD-R2-08：会话级放行表。
 *
 * 过去是裸 Set<string>：用户点一次「本次会话允许」= 该 bot 永久放行该工具，
 * 无 TTL、无参数作用域（允许 shell.exec 跑 ls 之后跑 rm 也免检）、无撤销路径。
 *
 * A3（交接单_20261026 §6）升级为 v2，两类分开记账：
 * - **internal preauth**：bot 启动时给自己发的 chat-insert / chat-send 工具级预授权，
 *   标 `source='internal-bot'`。它**不是**用户授权，审计与撤销都必须与用户 grant 分开。
 * - **user grant**：用户点「本次会话允许此操作」产生的放行，key =
 *   `principal|workspaceHash|toolId|approvalClass|digest(target)`（见 authorization.grantKeyOf）。
 *   `session` 作用域不设固定 TTL，靠生命周期清理（会话结束 / bot 断开 / 改工作区 / 改档位 / 撤销）；
 *   只有 `temporary`（always 类的高级二次放行）才带 10 分钟倒计时。
 *
 * 兼容层：旧的 `addPermanent(tool)` / `has(tool, params?)` 仍在，供既有内部调用与测试使用；
 * 它们只映射到 internal preauth 与 legacy 指纹桶，不参与 user grant 判定。
 */
export class SessionAllowlist {
  /** legacy 兼容表：key = `${tool}#${fingerprint}`，value = expiresAt（null = 工具级预授权）。 */
  private entries = new Map<string, number | null>();
  /** v2：user grant 表，key = grantKey。 */
  private grants = new Map<string, GrantEntry>();
  /** v2：internal preauth 集合（工具名 → 记账时间）。 */
  private internal = new Map<string, number>();

  /** bot 启动时的内部预授权（chat-insert/send）：工具级、不绑参数、标源。 */
  addPermanent(tool: string): void {
    this.entries.set(`${tool}#`, null);
    this.internal.set(tool, Date.now());
  }

  /** 用户点「本次会话允许」：绑参数指纹 + TTL。 */
  addTemporary(tool: string, params: unknown, ttlMs: number): void {
    this.entries.set(`${tool}#${fingerprint(params)}`, Date.now() + ttlMs);
  }

  /**
   * A3：发放结构化 grant。
   * `session` 不设 TTL（expiresAt 留空，靠生命周期清理）；`temporary` 必须带 expiresAt。
   * 只有 approvalClass=mode 的调用方应拿到 session；always 最多 temporary（由宿主侧把关）。
   */
  grant(input: {
    key: string;
    toolId: string;
    approvalClass: ApprovalClass;
    grantScope: GrantScope;
    workspaceHash: string;
    canonicalTarget: string;
    expiresAt?: number;
    source?: 'user' | 'internal-bot';
    id?: string;
  }): GrantEntry {
    const entry: GrantEntry = {
      id: input.id ?? `grant_${this.seq++}_${input.toolId.replace(/[^a-zA-Z0-9]/g, '_')}`,
      key: input.key,
      toolId: input.toolId,
      approvalClass: input.approvalClass,
      grantScope: input.grantScope,
      workspaceHash: input.workspaceHash,
      canonicalTarget: input.canonicalTarget,
      createdAt: Date.now(),
      source: input.source ?? 'user',
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    this.grants.set(entry.key, entry);
    return entry;
  }

  /** A3：查 user grant（internal preauth 不会被这里读到）。 */
  hasUserGrant(key: string, now: number = Date.now()): GrantEntry | undefined {
    const g = this.grants.get(key);
    if (!g) return undefined;
    if (g.source !== 'user') return undefined;
    if (g.expiresAt !== undefined && now >= g.expiresAt) {
      this.grants.delete(key);
      return undefined;
    }
    return g;
  }

  /** A3：internal preauth 命中（工具级，不含参数）。 */
  hasInternalPreauth(tool: string): boolean {
    return this.internal.has(tool);
  }

  /** 面板/审计展示用的全部有效 grant（已过期的不返回）。 */
  listGrants(now: number = Date.now()): readonly GrantEntry[] {
    this.sweep();
    return [...this.grants.values()].filter((g) => g.expiresAt === undefined || g.expiresAt > now);
  }

  /** A3 撤销：按 grant id。 */
  revokeById(id: string): boolean {
    for (const [k, g] of this.grants) {
      if (g.id === id) {
        this.grants.delete(k);
        return true;
      }
    }
    return false;
  }

  /** A3 撤销：按工具（含 internal preauth）。 */
  revokeByTool(tool: string): number {
    let n = 0;
    for (const [k, g] of this.grants) {
      if (g.toolId === tool) {
        this.grants.delete(k);
        n++;
      }
    }
    if (this.internal.delete(tool)) n++;
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(`${tool}#`)) {
        this.entries.delete(k);
        n++;
      }
    }
    return n;
  }

  /**
   * A3 撤销：工作区变更后，绑在该旧工作区 hash 上的 grant 全部作废（目标解析已换根）。
   * 传入被换掉的旧 workspaceHash；返回被清条数。
   */
  revokeWorkspace(workspaceHash: string): number {
    let n = 0;
    for (const [k, g] of this.grants) {
      if (g.workspaceHash === workspaceHash) {
        this.grants.delete(k);
        n++;
      }
    }
    return n;
  }

  /**
   * A3 撤销：只清用户 grant，保留 bot 内部预授权。
   * 用于「页面关闭 / bot 断开」——窗口没了就没有人能再为这些放行负责，
   * 但 chat-insert / chat-send 的内部预授权属于运行期装配，不该被顺带打断。
   */
  clearUserGrants(): number {
    let n = 0;
    for (const [k, g] of this.grants) {
      if (g.source === 'user') {
        this.grants.delete(k);
        n++;
      }
    }
    // legacy 参数指纹桶同样来自用户的 allow-session，一并作废。
    for (const [k, exp] of this.entries) {
      if (exp !== null) {
        this.entries.delete(k);
        n++;
      }
    }
    return n;
  }

  has(tool: string, params?: unknown): boolean {
    this.sweep();
    if (this.entries.has(`${tool}#`)) return true; // 永久预授权
    if (params !== undefined && this.entries.has(`${tool}#${fingerprint(params)}`)) return true;
    return false;
  }

  clear(): void {
    this.entries.clear();
    this.grants.clear();
    this.internal.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, exp] of this.entries) {
      if (exp !== null && now > exp) this.entries.delete(k);
    }
    for (const [k, g] of this.grants) {
      if (g.expiresAt !== undefined && now >= g.expiresAt) this.grants.delete(k);
    }
  }

  private seq = 0;
}

/** A3 grant 条目（会话内存态，重启即失效——这是设计选择，不落盘）。 */
export interface GrantEntry {
  readonly id: string;
  readonly key: string;
  readonly toolId: string;
  readonly approvalClass: ApprovalClass;
  readonly grantScope: GrantScope;
  readonly workspaceHash: string;
  readonly canonicalTarget: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly source: 'user' | 'internal-bot';
}

/** 稳定参数指纹：排序 key 后 JSON.stringify。工具 params 都是纯 JSON，无循环。 */
function fingerprint(params: unknown): string {
  if (params === null || typeof params !== 'object') return String(params ?? '');
  try {
    const sorted = sortKeys(params as Record<string, unknown>);
    return JSON.stringify(sorted);
  } catch {
    return '';
  }
}
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    out[k] = v !== null && typeof v === 'object' ? sortKeys(v as Record<string, unknown>) : v;
  }
  return out;
}

/** 每个 bot 独立持有的协调状态。原 desktop-host 单实例的 4 个对象（540-544）拆到 per-bot。
 * desktop-host 经 registry.getState(botId) 取到后，把 hub 回调接到 main bot 的 state。
 */
export interface BotInternalState {
  /** 本 bot 的工具调用计数（hub.onToolCall 累加；AgentLoop 依据它决策续跑）。 */
  toolCallCounter: { current: number };
  /** 本 bot 的停止旗标（AgentLoop.stop() 置位；WebEngine.isStopped() 读它）。 */
  stopFlag: { stopped: boolean };
  /** 本 bot 的 auto-continue 回复缓冲（hub.onAssistantReply 写；WebEngine 读/消费）。 */
  lastAutoReply: AutoReplyBuffer;
  /** 本 bot 的会话级工具放行表（sendMessage 时预授权 chat-insert/chat-send；用户 allow-session 走 TTL）。 */
  sessionAllowlist: SessionAllowlist;
  /** v0.25：人设（SlotRuntime.loadPersona 写入）。 */
  persona?: Persona;
  /** v0.25：人设工具白名单（persona.tools 转 Set；空/缺省=继承全部）。 */
  whitelist?: Set<string>;
  /**
   * v0.25：按人设白名单过滤的执行器（SlotRuntime.createPersonaExecutor 产出）。
   * hub 收到页端 tool-call 时经 SlotRuntime.executorFor(botId) 取用；未加载人设 → undefined
   * （调用方回退到直调 invokeTool，与 v0.24 行为一致）。
   */
  executor?: (tool: string, params: unknown) => Promise<ToolExecutionResult>;
}

/** BotRegistry 构造依赖：宿主提供引擎工厂 + 事件出口。 */
export interface BotRegistryDeps {
  /**
   * 为指定 bot 创建 ModelEngine。registry 已为该 bot 建好独立 state，
   * 宿主在此把 state 的 counter/stopFlag/autoReply 接到引擎（及 v0.23 main bot 的 hub 回调）。
   */
  createEngine(input: { botId: string; state: BotInternalState }): ModelEngine;
  /** loop 事件出口：推给宿主广播层（事件已带 botId 标签）。 */
  onEvent(event: AgentLoopEvent): void;
  /** 可选的 loop 配置覆盖（测试传 throttleBetweenSteps:false 等）。 */
  loopOptions?: Partial<Pick<import('../agent-loop').AgentLoopOptions, 'maxSteps' | 'watchdogMs' | 'throttleBetweenSteps' | 'continueNudge'>>;
}

/** BotRegistry 的内部扩展接口（types.ts 的 BotRegistry 是最小契约；此处加宿主装配用的访问器）。 */
export interface BotRegistryInternal extends BotRegistry {
  /** 取指定 bot 的内部 state（desktop-host 用来接 hub 回调）。 */
  getState(botId: string): BotInternalState | undefined;
}

function freshState(): BotInternalState {
  return {
    toolCallCounter: { current: 0 },
    stopFlag: { stopped: false },
    lastAutoReply: { text: '', loop: 0, seq: 0, updatedAt: 0, fresh: false },
    sessionAllowlist: new SessionAllowlist(),
  };
}

interface BotEntry {
  instance: BotInstance;
  state: BotInternalState;
  loop: AgentLoop;
}

export function createBotRegistry(deps: BotRegistryDeps): BotRegistryInternal {
  const bots = new Map<string, BotEntry>();

  async function create(opts: {
    botId?: string;
    slotId: string;
    personaName?: string;
    engine?: ModelEngine;
  }): Promise<BotInstance> {
    const botId = opts.botId ?? `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    if (bots.has(botId)) throw new Error(`bot already exists: ${botId}`);

    const state = freshState();
    const engine = opts.engine ?? deps.createEngine({ botId, state });

    const loop = createAgentLoop({
      engine,
      stopFlag: state.stopFlag,
      botId,
      onEvent: (event) => deps.onEvent(event),
      ...deps.loopOptions,
    });

    const instance: BotInstance = {
      id: botId,
      loop,
      engine,
      slotId: opts.slotId,
      // persona 由 v0.25 SlotRuntime.loadPersona 写入；v0.23 主 bot 无 人设
    };
    bots.set(botId, { instance, state, loop });
    return instance;
  }

  function get(id: string): BotInstance | undefined {
    return bots.get(id)?.instance;
  }

  function list(): BotInstance[] {
    return [...bots.values()].map((e) => e.instance);
  }

  async function destroy(id: string): Promise<void> {
    const entry = bots.get(id);
    if (!entry) return;
    // 停掉活跃循环（若有）：置位 stopFlag，loop 的 watchdog/轮询会读到并退出
    entry.state.stopFlag.stopped = true;
    bots.delete(id);
  }

  function getState(botId: string): BotInternalState | undefined {
    return bots.get(botId)?.state;
  }

  return { create, get, list, destroy, getState };
}
