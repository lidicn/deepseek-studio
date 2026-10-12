/**
 * 工具事件总线（Pi Agent 移植 · 第二阶段）
 *
 * 对齐契约：
 *   on(event: ToolEvent, handler): () => void     // 支持 '*' 通配订阅全部事件
 *   emit(event: ToolEvent, payload): void
 *   ToolEvent = 'before-call' | 'after-call' | 'call-error' | 'call-skip'
 *
 * payload 形状固定：event / toolName / params / result / durationMs 五个键恒在
 * （before-call / call-skip 阶段 result / durationMs 显式为 undefined），
 * '*' 通配订阅者因此可以用同一段代码处理所有事件。
 *
 * 执行语义：
 *   - 同一事件的多个 handler 按订阅先后串行派发；具名 handler 先于 '*' handler；
 *   - emit    ：同步派发（满足 emit(...): void 契约）；handler 返回 promise 时内部挂
 *               .catch 兜底（避免未处理拒绝），但不等待其完成；
 *   - emitAsync：逐个 await 每个 handler（异步串行），全部完成后 resolve；
 *   - 派发使用订阅快照：派发过程中的订阅 / 卸载不影响本次派发。
 *
 * 失败语义：单个 handler 抛错（同步或 promise 拒绝）不影响其他 handler，
 * 错误统一走 onHandlerError 上报（默认 console.error）。
 */

import type { ToolCallParams, ToolCallResult } from './tool-hooks';

// ---------------------------------------------------------------- 类型

/** 四类工具事件；'*' 只用于订阅（通配所有事件），不接受 emit。 */
export type ToolEvent = 'before-call' | 'after-call' | 'call-error' | 'call-skip';
export type ToolEventName = ToolEvent | '*';

/** handler 收到的事件 payload（形状固定）。 */
export interface ToolEventPayload {
  /** 本次事件名；'*' 订阅者靠它区分事件。 */
  event: ToolEvent;
  toolName: string;
  params: ToolCallParams;
  /** 本次调用最终结果（call-error 是合成的错误结果）；before-call / call-skip 为 undefined。 */
  result: ToolCallResult | undefined;
  /** execute 实际耗时（不含钩子与派发）；before-call / call-skip 为 undefined。 */
  durationMs: number | undefined;
  /** call-error：抛出的原始错误。 */
  error?: unknown;
  /** call-skip / call-error：原因码。 */
  reason?: string | undefined;
  callId?: string | undefined;
}

/** emit 入参：event 可省略，由 emit 按第一个参数补齐 / 覆盖。 */
export interface ToolEventInput {
  toolName: string;
  params: ToolCallParams;
  result?: ToolCallResult | undefined;
  durationMs?: number | undefined;
  error?: unknown;
  reason?: string | undefined;
  callId?: string | undefined;
  event?: ToolEvent | undefined;
}

export type ToolEventHandler = (payload: ToolEventPayload) => void | Promise<void>;

export interface ToolEventHandlerError {
  /** 实际派发的事件名。 */
  event: ToolEvent;
  handlerId: number;
  error: unknown;
}

export interface ToolEventBusOptions {
  onHandlerError?: (info: ToolEventHandlerError) => void;
}

export interface ToolEventBus {
  on(event: ToolEventName, handler: ToolEventHandler): () => void;
  /** 移除该 handler 最先注册的那一条；其余用 on 的返回值卸载。 */
  off(event: ToolEventName, handler: ToolEventHandler): void;
  emit(event: ToolEvent, payload: ToolEventInput): void;
  emitAsync(event: ToolEvent, payload: ToolEventInput): Promise<void>;
  clear(event?: ToolEventName): void;
  listenerCount(event?: ToolEventName): number;
}

// ---------------------------------------------------------------- 实现

interface Subscription {
  id: number;
  event: ToolEventName;
  handler: ToolEventHandler;
}

const TOOL_EVENTS: readonly string[] = ['before-call', 'after-call', 'call-error', 'call-skip'];

function isToolEventName(value: unknown): value is ToolEventName {
  return value === '*' || (typeof value === 'string' && TOOL_EVENTS.indexOf(value) >= 0);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

function defaultHandlerErrorReporter(info: ToolEventHandlerError): void {
  console.error('[tool-event-bus]', info.event, info.error);
}

function assertEmitEvent(event: string): void {
  if (!isToolEventName(event) || event === '*') {
    throw new TypeError(`tool-event-bus: emit 只接受具体事件名，收到 ${String(event)}`);
  }
}

function normalize(event: ToolEvent, input: ToolEventInput): ToolEventPayload {
  return {
    event,
    toolName: input.toolName,
    params: input.params,
    result: input.result,
    durationMs: input.durationMs,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
  };
}

export function createToolEventBus(options?: ToolEventBusOptions): ToolEventBus {
  const onHandlerError = options?.onHandlerError ?? defaultHandlerErrorReporter;
  const subscriptions = new Map<string, Set<Subscription>>();
  let nextId = 1;

  function bucket(event: ToolEventName): Set<Subscription> {
    const existing = subscriptions.get(event);
    if (existing !== undefined) return existing;
    const created = new Set<Subscription>();
    subscriptions.set(event, created);
    return created;
  }

  /** 派发顺序：具名桶（订阅序）→ '*' 桶（订阅序）；返回快照。 */
  function targets(event: ToolEvent): Subscription[] {
    const list: Subscription[] = [];
    const exact = subscriptions.get(event);
    if (exact !== undefined) {
      for (const sub of Array.from(exact)) list.push(sub);
    }
    const wild = subscriptions.get('*');
    if (wild !== undefined) {
      for (const sub of Array.from(wild)) list.push(sub);
    }
    return list;
  }

  function drop(event: ToolEventName, sub: Subscription): void {
    const set = subscriptions.get(event);
    if (set === undefined) return;
    set.delete(sub);
    if (set.size === 0) subscriptions.delete(event);
  }

  function on(event: ToolEventName, handler: ToolEventHandler): () => void {
    if (!isToolEventName(event)) {
      throw new TypeError(`tool-event-bus: 未知事件名 ${String(event)}`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError('tool-event-bus: handler 必须是函数');
    }
    const sub: Subscription = { id: nextId, event, handler };
    nextId += 1;
    bucket(event).add(sub);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      drop(event, sub);
    };
  }

  function off(event: ToolEventName, handler: ToolEventHandler): void {
    const set = subscriptions.get(event);
    if (set === undefined) return;
    for (const sub of Array.from(set)) {
      if (sub.handler !== handler) continue;
      drop(event, sub);
      return;
    }
  }

  function emit(event: ToolEvent, input: ToolEventInput): void {
    assertEmitEvent(event);
    const payload = normalize(event, input);
    for (const sub of targets(event)) {
      let returned: unknown;
      try {
        returned = sub.handler(payload);
      } catch (error) {
        onHandlerError({ event, handlerId: sub.id, error });
        continue;
      }
      if (isThenable(returned)) {
        Promise.resolve(returned).catch((error: unknown) => {
          onHandlerError({ event, handlerId: sub.id, error });
        });
      }
    }
  }

  async function emitAsync(event: ToolEvent, input: ToolEventInput): Promise<void> {
    assertEmitEvent(event);
    const payload = normalize(event, input);
    for (const sub of targets(event)) {
      try {
        await sub.handler(payload);
      } catch (error) {
        onHandlerError({ event, handlerId: sub.id, error });
      }
    }
  }

  function clear(event?: ToolEventName): void {
    if (event === undefined) {
      subscriptions.clear();
      return;
    }
    if (!isToolEventName(event)) {
      throw new TypeError(`tool-event-bus: 未知事件名 ${String(event)}`);
    }
    subscriptions.delete(event);
  }

  function listenerCount(event?: ToolEventName): number {
    if (event === undefined) {
      let total = 0;
      subscriptions.forEach((set) => {
        total += set.size;
      });
      return total;
    }
    const set = subscriptions.get(event);
    return set === undefined ? 0 : set.size;
  }

  return { on, off, emit, emitAsync, clear, listenerCount };
}

// ---------------------------------------------------------------- 默认实例

/** 默认总线：模块级 on / emit / emitAsync 共用。 */
export const toolEvents: ToolEventBus = createToolEventBus();

export function on(event: ToolEventName, handler: ToolEventHandler): () => void {
  return toolEvents.on(event, handler);
}

export function emit(event: ToolEvent, payload: ToolEventInput): void {
  toolEvents.emit(event, payload);
}

export async function emitAsync(event: ToolEvent, payload: ToolEventInput): Promise<void> {
  await toolEvents.emitAsync(event, payload);
}

export function clearToolEvents(event?: ToolEventName): void {
  toolEvents.clear(event);
}