/**
 * 事件驱动工具循环（Pi Agent 移植 · 第二阶段）
 *
 * 单次工具调用的完整流水线：
 *   runBefore → emit('before-call') → execute → runAfter → emit('after-call')
 * 拦截与异常分别落到 'call-skip' / 'call-error'。
 */

import type {
  ToolCallParams,
  ToolCallResult,
  ToolCallSkipReason,
  ToolHooksRegistry,
} from './tool-hooks';
import { toolHooks } from './tool-hooks';
import type { ToolEventBus } from './tool-event-bus';
import { toolEvents } from './tool-event-bus';
import { buildErrorExtras } from './tool-result-format';

export interface RunToolCallOptions {
  toolName: string;
  params: ToolCallParams;
  execute: (params: ToolCallParams) => ToolCallResult | Promise<ToolCallResult>;
  /** 缺省用默认注册表。 */
  hooks?: ToolHooksRegistry;
  /** 缺省用默认事件总线。 */
  events?: ToolEventBus;
  callId?: string | undefined;
  /** 被拦截时结果是否带 terminate=true（默认 true，防自动续跑死循环）。 */
  terminateOnSkip?: boolean | undefined;
  now?: (() => number) | undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '[unknown error]';
  }
}

export async function runToolCall(options: RunToolCallOptions): Promise<ToolCallResult> {
  const hooks = options.hooks ?? toolHooks;
  const events = options.events ?? toolEvents;
  const now = options.now ?? Date.now;
  const terminateOnSkip = options.terminateOnSkip !== false;
  const callId = options.callId;

  // 1. before 钩子闸门
  const gate = await hooks.runBefore(options.toolName, options.params, callId);
  if (!gate.proceed) {
    const reason: ToolCallSkipReason = gate.reason ?? 'before-hook-deny';
    const message = `工具 ${options.toolName} 调用被跳过（${reason}）`;
    const skipResult: ToolCallResult = {
      ok: false,
      error: message,
      ...buildErrorExtras({
        message,
        code: 'call-skip',
        details: { toolName: options.toolName, reason },
      }),
    };
    if (terminateOnSkip) skipResult.terminate = true;

    await events.emitAsync('call-skip', {
      toolName: options.toolName,
      params: gate.params,
      reason,
      ...(callId !== undefined ? { callId } : {}),
    });
    return skipResult;
  }

  const params = gate.params;

  // 2. before-call 事件（带最终参数）
  await events.emitAsync('before-call', {
    toolName: options.toolName,
    params,
    ...(callId !== undefined ? { callId } : {}),
  });

  // 3. 执行
  const startedAt = now();
  let raw: ToolCallResult;
  try {
    raw = await options.execute(params);
  } catch (error) {
    const durationMs = Math.max(0, now() - startedAt);
    const message = toErrorMessage(error);
    const errorResult: ToolCallResult = {
      ok: false,
      error: message,
      ...buildErrorExtras({
        message,
        code: 'call-error',
        details: { toolName: options.toolName },
      }),
    };
    // 异常也走 after 钩子：策略钩子仍可补 terminate / 改写文案
    const final = await hooks.runAfter(options.toolName, params, errorResult, callId);
    await events.emitAsync('call-error', {
      toolName: options.toolName,
      params,
      result: final,
      durationMs,
      error,
      reason: 'execute-threw',
      ...(callId !== undefined ? { callId } : {}),
    });
    return final;
  }

  // 4. after 钩子 + after-call 事件（带最终结果）
  const durationMs = Math.max(0, now() - startedAt);
  const final = await hooks.runAfter(options.toolName, params, raw, callId);
  await events.emitAsync('after-call', {
    toolName: options.toolName,
    params,
    result: final,
    durationMs,
    ...(callId !== undefined ? { callId } : {}),
  });
  return final;
}