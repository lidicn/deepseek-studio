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

import type { ModelEngine, ToolCallRecord } from '../engine/model-engine';
import type { MessageHistory } from './message-history';
import { extractTaskCompleteSignal } from '../../shared/continuation-prompt';

// ---------------------------------------------------------------- 类型

export type TaskLoopStopReason =
  | 'completed'
  | 'empty-response'
  | 'no-tool-calls'
  | 'timeout'
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
}

export interface TaskLoop {
  run(userText: string): Promise<TaskLoopRoundResult>;
}

// ---------------------------------------------------------------- 内部工具

/** 从 history 拼一段给引擎的上下文（纯文本，M3 再接真实协议）。 */
function buildPrompt(history: MessageHistory): string {
  const all = history.all();
  if (all.length === 0) return '';
  return all.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/** 把一条工具记录格式化成 role:'tool' 的可见内容。 */
function formatToolRecord(rec: ToolCallRecord): string {
  if (rec.ok) return `[${rec.tool}] ok`;
  return `[${rec.tool}] failed: ${rec.error ?? 'unknown error'}`;
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
  if (extractTaskCompleteSignal(content) !== null) return 'completed';
  if (content.trim() === '' && toolCalls === 0) return 'empty-response';
  if (toolCalls === 0) return 'no-tool-calls';
  return undefined;
}

// ---------------------------------------------------------------- 工厂

export function createTaskLoop(opts: TaskLoopOptions): TaskLoop {
  const { engine, history } = opts;
  const maxRounds = opts.maxRounds ?? 1;

  async function run(userText: string): Promise<TaskLoopRoundResult> {
    // 1. 落用户消息
    history.append({ role: 'user', content: userText });

    let last: TaskLoopRoundResult | undefined;

    for (let round = 1; round <= maxRounds; round += 1) {
      // 2. 拼上下文 → 3. send（抛错时：user 已落库、assistant 不落，带 round 抛出）
      let result;
      try {
        result = await engine.send(buildPrompt(history));
      } catch (cause) {
        throw new TaskLoopError(`engine.send failed at round ${round}`, round, cause);
      }

      // 4. 落 assistant
      history.append({ role: 'assistant', content: result.content });

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
