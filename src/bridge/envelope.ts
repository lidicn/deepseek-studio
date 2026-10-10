/**
 * deepseek-studio MV3 桥接层 · 运行时信封
 *
 * 与上游 deepseek-pp/src/core/messaging/runtime-boundary.ts 保持「同判据镜像」：
 * 上游依赖 ../deepseek/chat-session（本仓未内联），直接 import 会破坏 tsc；
 * 且 deepseek-pp/** 是只读快照，禁止改写。这里只镜像解码 / 授权 / 错误响应三处判据，
 * tests/desktop/bridge-runtime.test.ts 用同一组断言锁住行为。
 */

export interface RuntimeMessageEnvelope<TPayload = unknown> {
  readonly command: string;
  readonly requestId: string;
  readonly payload: TPayload;
}

/** 上游 DEEPSEEK_CONTENT_RUNTIME_COMMANDS 白名单（镜像，集中在此一处）。 */
export const DEEPSEEK_CONTENT_RUNTIME_COMMANDS = new Set<string>([
  'bridge_invoke',
  'kv_get',
  'kv_set',
  'kv_remove',
  'kv_list',
  'tool_execute',
  'tool_cancel',
  'agent_turn',
  'agent_cancel',
  'capability_start',
  'capability_stop',
  'ping',
  'pong',
]);

export type RuntimeBoundaryErrorCode =
  | 'INVALID_ENVELOPE'
  | 'UNKNOWN_COMMAND'
  | 'UNAUTHORIZED'
  | 'DISPATCH_TIMEOUT';

export interface RuntimeBoundaryError {
  readonly ok: false;
  readonly error: {
    readonly code: RuntimeBoundaryErrorCode;
    readonly message: string;
  };
}

export function createRuntimeBoundaryErrorResponse(
  _requestId: string,
  code: RuntimeBoundaryErrorCode,
  message: string,
): RuntimeBoundaryError {
  return {
    ok: false,
    error: { code, message },
  };
}

/** 解码并校验原始消息，非法返回 null（调用方据此回 INVALID_ENVELOPE）。 */
export function decodeRuntimeMessageEnvelope(raw: unknown): RuntimeMessageEnvelope | null {
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.command !== 'string') return null;
  if (typeof rec.requestId !== 'string') return null;
  // payload 允许任意 JSON 值（含 undefined 之外），缺失视为 null
  return {
    command: rec.command,
    requestId: rec.requestId,
    payload: (rec.payload === undefined ? null : rec.payload) as unknown,
  };
}

/**
 * 按 command 授权：白名单外的命令一律拒绝（fail-closed）。
 * 上游判据点：authorizeRuntimeMessage 在 dispatch 前对 command 做白名单校验。
 */
export function authorizeRuntimeMessage(envelope: RuntimeMessageEnvelope): boolean {
  return DEEPSEEK_CONTENT_RUNTIME_COMMANDS.has(envelope.command);
}

/** 判断是否为普通 JSON 对象（无原型链方法），供 storage 克隆校验复用。 */
export function isPlainRuntimeRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
