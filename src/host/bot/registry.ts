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
  updatedAt: number;
  fresh: boolean;
}

/**
 * 每个 bot 独立持有的协调状态。原 desktop-host 单实例的 4 个对象（540-544）拆到 per-bot。
 * desktop-host 经 registry.getState(botId) 取到后，把 hub 回调接到 main bot 的 state。
 */
export interface BotInternalState {
  /** 本 bot 的工具调用计数（hub.onToolCall 累加；AgentLoop 依据它决策续跑）。 */
  toolCallCounter: { current: number };
  /** 本 bot 的停止旗标（AgentLoop.stop() 置位；WebEngine.isStopped() 读它）。 */
  stopFlag: { stopped: boolean };
  /** 本 bot 的 auto-continue 回复缓冲（hub.onAssistantReply 写；WebEngine 读/消费）。 */
  lastAutoReply: AutoReplyBuffer;
  /** 本 bot 的会话级工具放行表（sendMessage 时 add chat-insert/chat-send）。 */
  sessionAllowlist: Set<string>;
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
    lastAutoReply: { text: '', loop: 0, updatedAt: 0, fresh: false },
    sessionAllowlist: new Set<string>(),
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
