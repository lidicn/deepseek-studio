/**
 * SlotRuntime（Bot 平台 v0.25 · Claude 主开发）
 *
 * 把「人设 + 槽位 + Bot 执行体」三者接起来：加载人设 → 按人设过滤工具 → 以人设执行任务。
 *
 * 两个必须分清的工具路径（本模块的核心设计）：
 *   1. 页面驱动工具（chat-read / chat-insert / chat-send）
 *      WebEngine.dispatch 直接调 desktop-host.invokeTool，**结构上不过白名单**——
 *      这是引擎与页面通信的唯一通道，过滤掉它引擎就死了。
 *   2. 模型发起工具（shell.exec / file.read 等）
 *      页内拦截器流式解析 → ws 反向投递 → hub.executor → 本模块的 botExecutor
 *      → **按 persona.tools 白名单过滤** → 再过完整授权链 + 同意闸门。
 *
 * 白名单语义是「拒绝」，从来不是「放行」：
 *   - 命中白名单 ≠ 免授权。仍然要走 invokeTool 的同意闸门/工具注册表校验。
 *   - 人设未声明白名单（tools 为空数组或缺省）= 继承全部工具，与 v0.23/v0.24 行为一致。
 *   - 拒绝码固定为 'tool-not-allowed-by-persona'，与其它 reason（consent-denied、
 *     unknown-tool 等）区分，便于调用方与审计层识别。
 *
 * 人设 prompt 注入方式（重要）：WebEngine 没有系统提示词概念——它把文本贴进
 * chat.deepseek.com 的输入框。所以 persona.prompt 只能作为消息文本的一部分，
 * 紧跟 AGENT_SENTINEL 之后（desktop-host 的发送路径都加这个前缀，语义是
 * 「由 agent 驱动而非用户手输」）。这是 v0.25 与通用「系统提示词注入」的实质差异。
 */

import { AGENT_SENTINEL } from '../agent-loop';
import type { ToolExecutionResult } from '../desktop-host';
import type { BotRegistryInternal, BotInternalState } from './registry';
import type { BotTask, RunHandle } from './scheduler';
import type { Persona, PersonaRegistry, SlotRegistry } from './types';

/** 页面驱动工具：引擎↔页面通信通道，永不受人设白名单限制。 */
export const PAGE_DRIVING_TOOLS: ReadonlySet<string> = new Set(['chat-read', 'chat-insert', 'chat-send']);

/** 人设未声明白名单时是否允许全部工具。默认 true（与 v0.23/v0.24 行为一致）。 */
export const DEFAULT_ALLOW_ALL_WITHOUT_WHITELIST = true;

/** 白名单拒绝时的固定 reason（审计/调用方可据此识别「人设不允许」而非「没同意」）。 */
export const REASON_TOOL_NOT_ALLOWED = 'tool-not-allowed-by-persona';

/** 单条任务的最大渲染长度，防止把整个仓库贴进聊天框。 */
const MAX_TASK_TEXT_CHARS = 4000;

export type BotExecutor = (tool: string, params: unknown) => Promise<ToolExecutionResult>;

/** 宿主提供的真实执行器：desktop-host.invokeTool（完整授权链 + 同意闸门）。 */
export type InvokeTool = (tool: string, params: unknown, botId?: string) => Promise<ToolExecutionResult>;

export interface SlotRuntimeOptions {
  /** Bot 注册表（需带 getState 的 BotRegistryInternal）。 */
  readonly registry: BotRegistryInternal;
  /** 人设注册表（CodeBuddy 交付，PersonaRegistry 契约）。 */
  readonly personas: PersonaRegistry;
  /** 真实执行器。白名单放行后仍然走这里，不绕过授权链。 */
  readonly invokeTool: InvokeTool;
  /** 槽位注册表（可选）。提供时：run 用 loadedPersona 对账，release 后可清理。 */
  readonly slots?: SlotRegistry;
  /** slotId → botId 映射。缺省按「botId 等于 slotId」处理。 */
  readonly botIdForSlot?: (slotId: string) => string;
  /** 人设未声明白名单时是否允许全部工具（默认 true）。 */
  readonly allowAllWithoutWhitelist?: boolean;
  /** 日志钩子（可选）。 */
  readonly onLog?: (message: string) => void;
}

/** loadPersona 后 bot 上挂载的人设视图。 */
export interface LoadedPersonaView {
  readonly persona: Persona;
  /** 人设声明的工具白名单。undefined = 继承全部工具。 */
  readonly whitelist: Set<string> | undefined;
  readonly loadedAt: number;
}

/**
 * SlotRuntime 主接口。
 */
export interface SlotRuntime {
  /** 加载人设到指定 bot：注入 prompt 视图 + 建白名单 executor。幂等（同名重复加载无害）。 */
  loadPersona(botId: string, personaName: string): Promise<Persona>;
  /** 卸载人设：清 prompt 视图 + 白名单 + executor。bot 回退到 v0.23 行为。 */
  unloadPersona(botId: string): Promise<void>;
  /** 取指定 bot 当前的人设视图；未加载 → undefined。 */
  loaded(botId: string): LoadedPersonaView | undefined;
  /** 取指定 bot 的执行器（含白名单过滤）。未加载人设 → undefined，调用方应回退 invokeTool。 */
  executorFor(botId: string | undefined): BotExecutor | undefined;
  /** Scheduler.TaskRunner 实现：占槽后的执行体。返回 engine.send 的结果。 */
  run(handle: RunHandle): Promise<unknown>;
  /** 渲染人设系统提示块（纯文本，注入消息文本用）。 */
  renderPersonaBlock(persona: Persona): string;
  /** 渲染任务文本（纯文本）。 */
  renderTaskText(task: BotTask): string;
}

/**
 * 按人设白名单过滤的执行器工厂。
 *
 * 白名单非空 且 工具不在白名单 且 不是页面驱动工具 → 拒绝。
 * 其它情况 → 委托 invokeTool（授权链照走，白名单不绕过它）。
 */
export function createPersonaExecutor(opts: {
  botId: string;
  whitelist: Set<string> | undefined;
  invokeTool: InvokeTool;
  onLog?: (message: string) => void;
}): BotExecutor {
  const { whitelist, invokeTool, onLog } = opts;
  // 白名单为空/缺省 = 继承全部工具（与 v0.23/v0.24 一致），直接透传不多一层判断。
  if (!whitelist || whitelist.size === 0) {
    return (tool, params) => invokeTool(tool, params, opts.botId);
  }
  return (tool, params) => {
    if (!whitelist.has(tool) && !PAGE_DRIVING_TOOLS.has(tool)) {
      onLog?.(`[slot-runtime] bot=${opts.botId} persona 白名单拒绝工具 ${tool}`);
      return Promise.resolve({
        ok: false,
        reason: REASON_TOOL_NOT_ALLOWED,
        isError: true,
        content: [{ type: 'text', text: `工具 ${tool} 不在当前人设的允许列表中，已拒绝执行。` }],
      });
    }
    return invokeTool(tool, params, opts.botId);
  };
}

/** 渲染人设系统提示块：人设名 + prompt 正文 + 可见的边界标记。 */
export function renderPersonaBlock(persona: Persona): string {
  const prompt = persona.prompt.trim();
  if (!prompt) return '';
  const lines: string[] = [];
  lines.push(`【人设：${persona.name}】`);
  lines.push(prompt);
  return lines.join('\n');
}

/** 渲染任务文本：优先用显式 text，否则从 dimension/target 拼出可读一句话。 */
export function renderTaskText(task: BotTask): string {
  if (typeof task.text === 'string' && task.text.trim()) return task.text.trim();
  const parts: string[] = [];
  if (task.dimension) parts.push(`维度：${task.dimension}`);
  if (task.target) parts.push(`目标：${task.target}`);
  // 其余键按稳定顺序补充，避免遗漏调用方透传的结构化字段
  for (const [key, value] of Object.entries(task)) {
    if (key === 'text' || key === 'dimension' || key === 'target') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}：${value}`);
    }
  }
  return parts.join('\n');
}

export function createSlotRuntime(options: SlotRuntimeOptions): SlotRuntime {
  const { registry, personas, invokeTool, slots, onLog } = options;
  const allowAllWithoutWhitelist = options.allowAllWithoutWhitelist ?? DEFAULT_ALLOW_ALL_WITHOUT_WHITELIST;
  const botIdForSlot = options.botIdForSlot ?? ((slotId: string) => slotId);
  const loadedAt = new Map<string, number>();

  function log(message: string): void {
    onLog?.(message);
  }

  function getEntry(botId: string) {
    const instance = registry.get(botId);
    const state = registry.getState(botId);
    if (!instance || !state) {
      throw new Error(`slot-runtime: bot not found: ${botId}`);
    }
    return { instance, state };
  }

  /** 白名单集合：persona.tools 非空才建；空数组 = 继承全部（undefined）。 */
  function whitelistFor(persona: Persona): Set<string> | undefined {
    if (!persona.tools || persona.tools.length === 0) return undefined;
    return new Set(persona.tools);
  }

  async function loadPersona(botId: string, personaName: string): Promise<Persona> {
    if (!personaName) throw new Error('slot-runtime.loadPersona: personaName is required');
    const { instance, state } = getEntry(botId);

    const persona = await personas.load(personaName);
    if (persona.name !== personaName) {
      // 注册表返回了不同名字的人设（软链接/别名等），按实际加载的为准但不掩盖错误
      log(`[slot-runtime] bot=${botId} 请求人设 ${personaName} 实际加载为 ${persona.name}`);
    }

    instance.persona = persona;
    state.persona = persona;
    state.whitelist = allowAllWithoutWhitelist ? whitelistFor(persona) : persona.tools.length > 0 ? new Set(persona.tools) : new Set<string>();
    // executor 存到 state 上，desktop-host 的 hub.executor 通过 executorFor 取
    (state as BotInternalState & { executor?: BotExecutor }).executor = createPersonaExecutor({
      botId,
      whitelist: state.whitelist,
      invokeTool,
      onLog,
    });
    loadedAt.set(botId, Date.now());
    log(
      `[slot-runtime] bot=${botId} 加载人设 ${persona.name}，` +
        `工具白名单=${state.whitelist ? `[${[...state.whitelist].join(',')}]` : '继承全部'}`,
    );
    return persona;
  }

  async function unloadPersona(botId: string): Promise<void> {
    const instance = registry.get(botId);
    const state = registry.getState(botId);
    // 与 loadPersona 的不对称是刻意的：load 失败必须抛错——静默跳过会让 bot 在无
    // 人设、无白名单的状态下执行（该过滤而不过滤，安全相关）。unload 对不存在的
    // bot 则是真正的空操作（删掉一个不存在的键），记录后返回即可。
    if (!instance || !state) {
      log(`[slot-runtime] unloadPersona: bot 不存在，忽略 ${botId}`);
      return;
    }
    const prev = instance.persona?.name;
    instance.persona = undefined;
    state.persona = undefined;
    state.whitelist = undefined;
    (state as BotInternalState & { executor?: BotExecutor }).executor = undefined;
    loadedAt.delete(botId);
    log(`[slot-runtime] bot=${botId} 卸载人设 ${prev ?? '(无)'}`);
  }

  function loaded(botId: string): LoadedPersonaView | undefined {
    const state = registry.getState(botId);
    const persona = state?.persona;
    if (!persona) return undefined;
    return { persona, whitelist: state!.whitelist, loadedAt: loadedAt.get(botId) ?? 0 };
  }

  function executorFor(botId: string | undefined): BotExecutor | undefined {
    if (!botId) return undefined;
    const state = registry.getState(botId);
    return (state as (BotInternalState & { executor?: BotExecutor }) | undefined)?.executor;
  }

  /** Scheduler.TaskRunner：handle.slotId → botId → 加载人设 → 发消息。 */
  async function run(handle: RunHandle): Promise<unknown> {
    const botId = botIdForSlot(handle.slotId);
    const { instance } = getEntry(botId);

    // 人设可能与槽位记录不一致（热插拔 / 复用槽位），以 handle.persona 为准对齐
    const view = loaded(botId);
    if (view?.persona.name !== handle.persona.name) {
      await loadPersona(botId, handle.persona.name);
    }

    // runId ↔ 槽位记录对账：不一致说明槽位被别的 run 占用过，继续跑会污染他人结果
    if (slots?.get(handle.slotId)?.currentRunId && slots.get(handle.slotId)!.currentRunId !== handle.runId) {
      throw new Error(
        `slot-runtime.run: slot ${handle.slotId} 当前 run 为 ${slots.get(handle.slotId)!.currentRunId}，与本次 ${handle.runId} 不符`,
      );
    }

    const personaBlock = renderPersonaBlock(handle.persona);
    const taskText = renderTaskText(handle.task);
    if (!taskText) {
      throw new Error(`slot-runtime.run: 任务文本为空，无法执行（task=${JSON.stringify(handle.task)}）`);
    }

    // 组合消息：AGENT_SENTINEL（agent 驱动标记）+ 人设块 + 任务。
    // 两者用空行分隔——人设是「你是谁」，任务是「现在做什么」，混在一起模型会混淆。
    const message = [personaBlock, taskText]
      .filter(Boolean)
      .join('\n\n---\n\n');
    const limited = message.length > MAX_TASK_TEXT_CHARS
      ? message.slice(0, MAX_TASK_TEXT_CHARS) + `\n\n[任务内容已截断至 ${MAX_TASK_TEXT_CHARS} 字符]`
      : message;

    log(`[slot-runtime] run ${handle.runId} bot=${botId} persona=${handle.persona.name} 发送 ${limited.length} 字符`);
    // desktop-host 的发送路径统一加 AGENT_SENTINEL 前缀；这里保持一致，
    // 使引擎与页内拦截器都能看到 agent 驱动标记。
    return instance.loop.send(`${AGENT_SENTINEL}${limited}`);
  }

  return { loadPersona, unloadPersona, loaded, executorFor, run, renderPersonaBlock, renderTaskText };
}
