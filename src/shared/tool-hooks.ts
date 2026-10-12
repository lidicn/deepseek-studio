/**
 * 工具调用 before / after 钩子（Pi Agent 移植 · 第二阶段）
 *
 * 对齐契约：
 *   registerBefore(toolName: string | '*', hook: BeforeToolCallHook): () => void
 *   registerAfter (toolName: string | '*', hook: AfterToolCallHook):  () => void
 *   runBefore(toolName, params): { proceed: boolean; params: modifiedParams }
 *   runAfter (toolName, params, result): modifiedResult
 *   BeforeToolCallHook = (params) => false | { params: modifiedParams } | void
 *   AfterToolCallHook  = (params, result) => modifiedResult | void
 *
 * 执行语义：
 *   - 注册顺序即执行顺序（具名与 '*' 混排时同样按注册先后），异步串行、逐个 await；
 *   - before 钩子链式传递 params：后一个钩子看到前一个钩子改写后的参数；
 *   - after  钩子链式传递 result：返回对象即整体替换，返回 void 即保持当前结果；
 *   - 无任何钩子时 runBefore / runAfter 等价于直通。
 *
 * 失败语义（详见交付说明 §7）：
 *   - before 阶段 fail-closed：钩子抛错 / 返回非法值 → proceed=false（闸门默认关闭）；
 *   - after  阶段 fail-open ：钩子抛错 / 返回非法值 → 保持当前结果并继续后续钩子；
 *   - 所有钩子异常都会上报 onHookError，绝不静默吞掉。
 *
 * 纯模块：无 DOM / 宿主运行时依赖，无副作用（默认异常上报走 console.error）。
 */

import type { ToolResultExtras } from './tool-result-format';

// ---------------------------------------------------------------- 类型

/** 工具调用参数（JSON 对象）。 */
export type ToolCallParams = Record<string, unknown>;

/** 结果里的旧字段（与 tool-result-format.ts 的 LegacyToolCardResult / ToolExecutionResult 同构）。 */
export interface ToolCallResultLegacy {
  ok?: boolean;
  reason?: string;
  data?: unknown;
  error?: string;
  snapshot?: { total: number; byKind: Record<string, number> };
}

/**
 * 钩子可见的工具结果 = 旧字段 + Pi Agent 风格四字段（content / details / isError / terminate）。
 * 语义真相源仍是 src/shared/tool-result-format.ts 的 ToolResultExtras，这里只做结构复用。
 * 全部字段可选：ToolExecutionResult / ToolCardResult / ExecuteResult 都能原样流过。
 */
export type ToolCallResult = ToolCallResultLegacy & ToolResultExtras;

/** 钩子上下文：让通配符钩子也能拿到本次实际调用的工具名。 */
export interface ToolHookContext {
  toolName: string;
  callId?: string;
}

/** before 钩子返回值：false=拦截，{ params }=整体替换参数，void=不改。 */
export type BeforeToolCallHookResult = false | { params: ToolCallParams } | void;

export type BeforeToolCallHook = (
  params: ToolCallParams,
  context: ToolHookContext,
) => BeforeToolCallHookResult | Promise<BeforeToolCallHookResult>;

/** after 钩子返回值：返回对象=整体替换结果，void=保持当前结果。 */
export type AfterToolCallHookResult = ToolCallResult | void;

export type AfterToolCallHook = (
  params: ToolCallParams,
  result: ToolCallResult,
  context: ToolHookContext,
) => AfterToolCallHookResult | Promise<AfterToolCallHookResult>;

export type ToolHookErrorReason = 'hook-threw' | 'hook-invalid-return';

export interface ToolHookError {
  phase: 'before' | 'after';
  toolName: string;
  /** 钩子注册序号（按注册先后递增，从 1 开始）。 */
  hookId: number;
  reason: ToolHookErrorReason;
  error: unknown;
}

export type ToolCallSkipReason = 'before-hook-deny' | 'hook-threw' | 'hook-invalid-return';

export interface RunBeforeOutcome {
  /** 是否放行本次调用。 */
  proceed: boolean;
  /** 经钩子改写后的最终参数；proceed=false 时是拦截发生那一刻的参数。 */
  params: ToolCallParams;
  /** proceed=false 时的原因码。 */
  reason?: ToolCallSkipReason;
  /** 执行期间收集到的钩子异常（含 fail-open 忽略掉的）。 */
  hookErrors: ToolHookError[];
}

export interface ToolHooksRegistry {
  registerBefore(toolName: string | '*', hook: BeforeToolCallHook): () => void;
  registerAfter(toolName: string | '*', hook: AfterToolCallHook): () => void;
  runBefore(toolName: string, params: ToolCallParams, callId?: string): Promise<RunBeforeOutcome>;
  runAfter(
    toolName: string,
    params: ToolCallParams,
    result: ToolCallResult,
    callId?: string,
  ): Promise<ToolCallResult>;
  clearHooks(): void;
  hookCount(): { before: number; after: number };
}

export interface ToolHooksOptions {
  /** 钩子异常上报（默认 console.error）。 */
  onHookError?: (error: ToolHookError) => void;
}

// ---------------------------------------------------------------- 实现

interface HookEntry<T> {
  id: number;
  toolName: string;
  hook: T;
}

function defaultHookErrorReporter(error: ToolHookError): void {
  console.error('[tool-hooks]', error.phase, error.reason, error.toolName, error.error);
}

function assertToolName(toolName: string): void {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new TypeError(`tool-hooks: toolName 必须是非空字符串，收到 ${JSON.stringify(toolName)}`);
  }
}

function assertHook(hook: unknown): void {
  if (typeof hook !== 'function') {
    throw new TypeError('tool-hooks: hook 必须是函数');
  }
}

function matches(entryToolName: string, toolName: string): boolean {
  return entryToolName === toolName || entryToolName === '*';
}

function makeContext(toolName: string, callId: string | undefined): ToolHookContext {
  return { toolName, ...(callId !== undefined ? { callId } : {}) };
}

function describeValue(value: unknown): string {
  const kind = value === null ? 'null' : typeof value;
  try {
    return `${kind}(${JSON.stringify(value) ?? String(value)})`;
  } catch {
    return kind;
  }
}

export function createToolHooks(options?: ToolHooksOptions): ToolHooksRegistry {
  const onHookError = options?.onHookError ?? defaultHookErrorReporter;
  const beforeEntries: Array<HookEntry<BeforeToolCallHook>> = [];
  const afterEntries: Array<HookEntry<AfterToolCallHook>> = [];
  let nextId = 1;

  function registerEntry<T>(list: Array<HookEntry<T>>, toolName: string | '*', hook: T): () => void {
    assertToolName(toolName);
    assertHook(hook);
    const entry: HookEntry<T> = { id: nextId, toolName, hook };
    nextId += 1;
    list.push(entry);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    };
  }

  async function runBefore(
    toolName: string,
    params: ToolCallParams,
    callId?: string,
  ): Promise<RunBeforeOutcome> {
    let current = params;
    const hookErrors: ToolHookError[] = [];

    const failClosed = (info: ToolHookError, reason: ToolCallSkipReason): RunBeforeOutcome => {
      hookErrors.push(info);
      onHookError(info);
      return { proceed: false, params: current, reason, hookErrors };
    };

    for (const entry of beforeEntries) {
      if (!matches(entry.toolName, toolName)) continue;

      let returned: unknown;
      try {
        returned = await entry.hook(current, makeContext(toolName, callId));
      } catch (error) {
        return failClosed(
          { phase: 'before', toolName, hookId: entry.id, reason: 'hook-threw', error },
          'hook-threw',
        );
      }

      if (returned === false) {
        return { proceed: false, params: current, reason: 'before-hook-deny', hookErrors };
      }
      if (returned === undefined || returned === null) continue;
      if (typeof returned === 'object' && returned !== null && 'params' in returned) {
        current = (returned as { params: ToolCallParams }).params;
        continue;
      }

      return failClosed(
        {
          phase: 'before',
          toolName,
          hookId: entry.id,
          reason: 'hook-invalid-return',
          error: new TypeError(`before 钩子返回值非法：${describeValue(returned)}`),
        },
        'hook-invalid-return',
      );
    }

    return { proceed: true, params: current, hookErrors };
  }

  async function runAfter(
    toolName: string,
    params: ToolCallParams,
    result: ToolCallResult,
    callId?: string,
  ): Promise<ToolCallResult> {
    let current = result;

    for (const entry of afterEntries) {
      if (!matches(entry.toolName, toolName)) continue;

      let returned: unknown;
      try {
        returned = await entry.hook(params, current, makeContext(toolName, callId));
      } catch (error) {
        onHookError({ phase: 'after', toolName, hookId: entry.id, reason: 'hook-threw', error });
        continue;
      }

      if (returned === undefined || returned === null) continue;
      if (typeof returned === 'object' && !Array.isArray(returned)) {
        current = returned as ToolCallResult;
        continue;
      }

      onHookError({
        phase: 'after',
        toolName,
        hookId: entry.id,
        reason: 'hook-invalid-return',
        error: new TypeError(`after 钩子返回值非法：${describeValue(returned)}`),
      });
    }

    return current;
  }

  return {
    registerBefore: (toolName, hook) => registerEntry(beforeEntries, toolName, hook),
    registerAfter: (toolName, hook) => registerEntry(afterEntries, toolName, hook),
    runBefore,
    runAfter,
    clearHooks: () => {
      beforeEntries.length = 0;
      afterEntries.length = 0;
    },
    hookCount: () => ({ before: beforeEntries.length, after: afterEntries.length }),
  };
}

// ---------------------------------------------------------------- 默认注册表

/** 默认注册表：模块级 registerBefore / registerAfter / runBefore / runAfter 共用。 */
export const toolHooks: ToolHooksRegistry = createToolHooks();

export function registerBefore(toolName: string | '*', hook: BeforeToolCallHook): () => void {
  return toolHooks.registerBefore(toolName, hook);
}

export function registerAfter(toolName: string | '*', hook: AfterToolCallHook): () => void {
  return toolHooks.registerAfter(toolName, hook);
}

export function runBefore(
  toolName: string,
  params: ToolCallParams,
  callId?: string,
): Promise<RunBeforeOutcome> {
  return toolHooks.runBefore(toolName, params, callId);
}

export function runAfter(
  toolName: string,
  params: ToolCallParams,
  result: ToolCallResult,
  callId?: string,
): Promise<ToolCallResult> {
  return toolHooks.runAfter(toolName, params, result, callId);
}

export function clearHooks(): void {
  toolHooks.clearHooks();
}