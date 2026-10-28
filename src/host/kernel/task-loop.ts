/**
 * TaskLoop 自驱（M2-3）：吃一条用户消息，驱动引擎跑工具回合，
 * 把工具记录回填进 MessageHistory，并判定该不该继续。
 *
 * 边界：
 *   - 只依赖 ModelEngine 接口（禁止 import 真 WebEngine），测试塞假引擎即可；
 *   - 只读 import message-history（M2-1）与 continuation-prompt 的判停信号；
 *   - 不读网页、不改 agent-loop、不碰 main-world-interceptor。
 *
 * 一轮的固定顺序（A-2）：
 *   1. append user
 *   2. 从 history 拼上下文 → engine.send()
 *   3. append assistant
 *   4. 若 toolCallRecords 存在，逐条 append role:'tool'
 *   5. 算 stopReason
 *   6. 返回
 *
 * stopReason 优先级：timeout > completed > no-tool-calls > undefined(继续)。
 *   - timedOut            → 'timeout'
 *   - 含 <task_complete>   → 'completed'（复用 continuation-prompt.extractTaskCompleteSignal）
 *   - toolCalls === 0     → 'no-tool-calls'
 *   - 否则                → undefined（本轮有工具调用，需继续跑下一轮）
 * 跑满 maxRounds 仍无 stopReason → 终态 'max-rounds'。
 */

import type { ModelEngine, ToolCallRecord, EngineSendResult } from '../engine/model-engine';
import type { MessageHistory } from './message-history';
import type { HistoryStore } from './history-store';
import { detectPlanRequest } from '../plan-gate';

// ---------------------------------------------------------------- 类型

export type TaskLoopStopReason =
  | 'completed'
  | 'empty-response'
  | 'no-tool-calls'
  | 'timeout'
  | 'aborted'
  | 'max-rounds';

export interface TaskLoopRoundResult {
  readonly round: number;
  readonly content: string;
  readonly toolCalls: number;
  readonly toolCallRecords?: readonly ToolCallRecord[];
  readonly stopReason?: TaskLoopStopReason;
  /** 非致命错误标记（不污染 stopReason 语义）。 */
  readonly error?: string;
}

/** 终态不可作为成功回复返回的错误。 */
export class TaskLoopReplyError extends Error {
  readonly stopReason?: TaskLoopStopReason;

  constructor(message: string, stopReason?: TaskLoopStopReason) {
    super(message);
    this.name = 'TaskLoopReplyError';
    this.stopReason = stopReason;
  }
}

/**
 * 把 TaskLoop 结果转成调用方可直接消费的成功回复。
 * 空正文、超时、中止、空响应和跑满轮数都不能伪装成成功。
 */
export function requireTaskLoopReply(result: TaskLoopRoundResult): string {
  const content = result.content.trim();
  const failedReason =
    result.stopReason === 'empty-response' ||
    result.stopReason === 'timeout' ||
    result.stopReason === 'aborted' ||
    result.stopReason === 'max-rounds';
  if (content === '' || failedReason) {
    const detail = result.stopReason ?? 'empty-response';
    throw new TaskLoopReplyError(`task loop returned no successful reply (${detail})`, result.stopReason);
  }
  return result.content;
}

/** 引擎抛错时向上抛出，带发生错误时的轮次。 */
export class TaskLoopError extends Error {
  readonly round: number;
  declare readonly cause?: unknown;
  constructor(message: string, round: number, cause?: unknown) {
    super(message);
    this.name = 'TaskLoopError';
    this.round = round;
    this.cause = cause;
  }
}

export interface TaskLoopOptions {
  readonly engine: ModelEngine;
  readonly history: MessageHistory;
  /** 最多跑几轮，默认 1（阶段 A 单回合）。 */
  readonly maxRounds?: number;
  /** S9：外部取消信号；abort 后当前轮 send reject、循环以 aborted 收尾。 */
  readonly signal?: AbortSignal;
  /** S10：每轮 send 独立超时，默认 120000ms。 */
  readonly roundTimeoutMs?: number;
  /** S11：可选 checkpoint 存储；注入后每轮结束自动快照。 */
  readonly store?: HistoryStore;
  /** S15：可选 delta 回调；每轮 send 完成后把 content 透传出去。 */
  readonly onDelta?: (chunk: string) => void;
}

/** S10：单轮超时标记错误。 */
class RoundTimeoutError extends Error {
  constructor() {
    super('RoundTimeoutError');
    this.name = 'RoundTimeoutError';
  }
}

export interface TaskLoop {
  run(userText: string): Promise<TaskLoopRoundResult>;
}

// ---------------------------------------------------------------- 内部工具

/** S18：内联判停信号提取，不再依赖 continuation-prompt。 */
const TASK_COMPLETE_RE = /<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/;

function hasTaskComplete(text: string): boolean {
  return TASK_COMPLETE_RE.test(text);
}

/**
 * R-W3：把 history 渲染成带角色标签的纯文本有界窗口（去 JSON 包装）。
 * 窗口参数：
 *   - 最多保留最近 12 条消息（够多轮工具链用，有界）
 *   - 总字符上限 4000（约 2k token，避免上下文膨胀）
 *   - 超长时从头部截断，保留最近对话
 * 续跑轮（round>1）跳过最后一条 user 消息——它已在首轮 chat-insert 写入页面，
 * 重发会导致输入框重复插入同一条用户文本。
 */
const PROMPT_MAX_MESSAGES = 12;
const PROMPT_MAX_CHARS = 4000;

function buildPrompt(history: MessageHistory, round = 1): string {
  const all = history.all();
  if (all.length === 0) return '';
  // 续跑轮：跳过最后一条 user 消息（已在首轮插入页面，避免重复 chat-insert）
  const msgs = round > 1 ? all.filter((m) => m.role !== 'user') : all;
  if (msgs.length === 0) return '';
  // 取最近 N 条
  const recent = msgs.slice(-PROMPT_MAX_MESSAGES);
  const lines = recent.map((m) => {
    const role = m.role === 'tool' ? 'tool' : m.role;
    return `[${role}] ${m.content}`;
  });
  let out = lines.join('\n');
  // 超长从头部截断，保留尾部
  if (out.length > PROMPT_MAX_CHARS) {
    out = out.slice(out.length - PROMPT_MAX_CHARS);
  }
  return out;
}

/** 把一条工具记录格式化成 role:'tool' 的可见内容。 */
function formatToolRecord(rec: ToolCallRecord): string {
  if (rec.ok) return `[${rec.tool}] ok`;
  return `[${rec.tool}] failed: ${rec.error ?? 'unknown error'}`;
}

/** S9：给任意引擎调用套一层 abort 竞速；signal 为 undefined 时原样返回。 */
function withAbort<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return call();
  // 已 abort 直接 reject，避免 listener 挂晚了收不到事件
  if (signal.aborted) return Promise.reject(new Error('AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    call().then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 单轮判停（优先级写死：timeout > completed > empty-response > no-tool-calls）。
 * 返回 undefined 表示本轮有工具调用、应继续。
 *   - timedOut                                  → 'timeout'
 *   - 含 <task_complete>                         → 'completed'
 *   - content 为空且 toolCalls===0              → 'empty-response'
 *   - toolCalls===0                              → 'no-tool-calls'
 *   - 否则                                       → undefined（继续）
 */
function computeStop(content: string, toolCalls: number, timedOut?: boolean): TaskLoopStopReason | undefined {
  if (timedOut) return 'timeout';
  if (hasTaskComplete(content)) return 'completed';
  if (content.trim() === '' && toolCalls === 0) return 'empty-response';
  if (toolCalls === 0) return 'no-tool-calls';
  return undefined;
}

// ---------------------------------------------------------------- 工厂

export function createTaskLoop(opts: TaskLoopOptions): TaskLoop {
  const { engine, history, signal, store, onDelta } = opts;
  const maxRounds = opts.maxRounds ?? 1;
  const roundTimeoutMs = opts.roundTimeoutMs ?? 120000;
  // 续跑轮优先等待页端 auto-continue 推送，而不是重复 send 用户文本。
  const waitForNextReply = engine.waitForNextReply?.bind(engine);

  async function run(userText: string): Promise<TaskLoopRoundResult> {
    // M8-E3：Plan 模式——只跑一轮，禁止工具调用
    const isPlan = detectPlanRequest(userText);
    const effectiveMaxRounds = isPlan ? 1 : maxRounds;

    // S11：可选 checkpoint —— 启动时从 store 恢复历史
    if (store) {
      const snap = await store.load();
      if (snap) history.restore(snap.history);
    }

    // 1. 落用户消息
    history.append({ role: 'user', content: userText });

    let last: TaskLoopRoundResult | undefined;
    // 上一轮是否发生过工具调用；只有工具轮才需要等页端续跑。
    let previousToolCalls = 0;

    for (let round = 1; round <= effectiveMaxRounds; round += 1) {
      // S9：本轮开始前已 abort → 以 aborted 收尾（user 已落库不回滚）
      if (signal?.aborted) {
        last = { round, content: '', toolCalls: 0, stopReason: 'aborted' };
        break;
      }

      // M6：DeepSeek 网页端限流——每轮间隔 2 秒，避免"发送过于频繁"
      if (round > 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      // 2. 拼上下文 → 3. send / waitForNextReply（套 abort + per-round timeout 竞速）
      //
      // v0.9：页端 POW auto-continue 是唯一续跑权威。工具轮之后宿主不再重复
      // send 用户文本（那会与页端续跑争抢同一会话），而是等待页端推送下一条回复。
      // 仅当引擎不支持 waitForNextReply 时才降级为 send(buildPrompt)。
      const useWait = round > 1 && previousToolCalls > 0 && typeof waitForNextReply === 'function';
      const call: () => Promise<EngineSendResult> = useWait
        ? () => (waitForNextReply as () => Promise<EngineSendResult>)()
        : () => engine.send(buildPrompt(history, round));

      let result;
      let roundTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          withAbort(call, signal),
          new Promise<never>((_, reject) => {
            roundTimer = setTimeout(() => reject(new RoundTimeoutError()), roundTimeoutMs);
          }),
        ]);
      } catch (cause) {
        if (cause instanceof RoundTimeoutError) {
          last = { round, content: '', toolCalls: 0, stopReason: 'timeout' };
          break;
        }
        if (signal?.aborted) {
          last = { round, content: '', toolCalls: 0, stopReason: 'aborted' };
          break;
        }
        const phase = useWait ? 'engine.waitForNextReply' : 'engine.send';
        throw new TaskLoopError(`${phase} failed at round ${round}`, round, cause);
      } finally {
        // 成功轮次也必须清掉超时器，否则 CLI / 宿主会因悬空 timer 多存活 120s。
        if (roundTimer !== undefined) clearTimeout(roundTimer);
      }

      // 4. 落 assistant + S15 透传 delta
      history.append({ role: 'assistant', content: result.content });
      onDelta?.(result.content);

      // 5. 逐条落 tool 记录（toolCallRecords 可选，缺省则跳过、不崩）
      // M8-E3：plan 模式下禁止工具调用，不落 tool 记录
      if (result.toolCallRecords && !isPlan) {
        for (const rec of result.toolCallRecords) {
          history.append({
            role: 'tool',
            content: formatToolRecord(rec),
            toolCallId: rec.tool,
          });
        }
      }

      // 6. 判停
      const stopReason = computeStop(result.content, result.toolCalls, result.timedOut);
      previousToolCalls = result.toolCalls;
      last = {
        round,
        content: result.content,
        toolCalls: result.toolCalls,
        ...(result.toolCallRecords ? { toolCallRecords: result.toolCallRecords } : {}),
        ...(stopReason ? { stopReason } : {}),
      };

      // S11：每轮结束落 checkpoint
      if (store) {
        await store.save({ version: 1, history: history.snapshot(), round });
      }

      if (stopReason !== undefined) break;
    }

    // 跑满 maxRounds 仍未判停 → 终态 max-rounds
    if (last !== undefined && last.stopReason === undefined) {
      last = { ...last, stopReason: 'max-rounds' };
    }

    // maxRounds>=1 时 last 必被赋值；这里兜底类型
    return last as TaskLoopRoundResult;
  }

  return { run };
}
