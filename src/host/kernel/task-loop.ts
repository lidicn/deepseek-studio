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

/** 从 history 拼一段给引擎的上下文（纯文本，M3 再接真实协议）。 */
/**
 * 把 history 的 ChatMessage[] 序列化成引擎输入（JSON 消息数组）。
 * S7：不再做 role/content 裸 join；直接以消息数组为单位序列化，
 * 未来换消息协议时只改这里。ModelEngine.send 现签名收 string，故序列化为 JSON 串。
 */
function buildPrompt(history: MessageHistory): string {
  const all = history.all();
  if (all.length === 0) return '';
  return JSON.stringify(all.map((m) => ({ role: m.role, content: m.content })));
}

/** 把一条工具记录格式化成 role:'tool' 的可见内容。 */
function formatToolRecord(rec: ToolCallRecord): string {
  if (rec.ok) return `[${rec.tool}] ok`;
  return `[${rec.tool}] failed: ${rec.error ?? 'unknown error'}`;
}

/** S9：给 send 套一层 abort 竞速；signal 为 undefined 时原样返回。 */
function sendWithAbort(
  engine: ModelEngine,
  text: string,
  signal?: AbortSignal,
): Promise<EngineSendResult> {
  if (!signal) return engine.send(text);
  return new Promise<EngineSendResult>((resolve, reject) => {
    const onAbort = () => reject(new Error('AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    engine.send(text).then(
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

  async function run(userText: string): Promise<TaskLoopRoundResult> {
    // S11：可选 checkpoint —— 启动时从 store 恢复历史
    if (store) {
      const snap = await store.load();
      if (snap) history.restore(snap.history);
    }

    // 1. 落用户消息
    history.append({ role: 'user', content: userText });

    let last: TaskLoopRoundResult | undefined;

    for (let round = 1; round <= maxRounds; round += 1) {
      // S9：本轮开始前已 abort → 以 aborted 收尾（user 已落库不回滚）
      if (signal?.aborted) {
        last = { round, content: '', toolCalls: 0, stopReason: 'aborted' };
        break;
      }

      // M6：DeepSeek 网页端限流——每轮间隔 2 秒，避免"发送过于频繁"
      if (round > 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }

      // 2. 拼上下文 → 3. send（套 abort + per-round timeout 竞速）
      let result;
      try {
        result = await Promise.race([
          sendWithAbort(engine, buildPrompt(history), signal),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new RoundTimeoutError()), roundTimeoutMs),
          ),
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
        throw new TaskLoopError(`engine.send failed at round ${round}`, round, cause);
      }

      // 4. 落 assistant + S15 透传 delta
      history.append({ role: 'assistant', content: result.content });
      onDelta?.(result.content);

      // 5. 逐条落 tool 记录（toolCallRecords 可选，缺省则跳过、不崩）
      if (result.toolCallRecords) {
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
