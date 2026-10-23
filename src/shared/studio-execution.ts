/**
 * Studio 主视图的版本化执行记录。
 *
 * 事件只在明确边界写入：用户消息、工具开始、工具结束、最终答复、系统错误。
 * 流式 token 不进入持久化记录。
 */

export const STUDIO_EXECUTION_VERSION = 2 as const;
export const STUDIO_EXECUTION_INDEX_KEY = 'studio.execution.v2.index';
export const STUDIO_EXECUTION_SESSION_PREFIX = 'studio.execution.v2.session.';
export const STUDIO_EXECUTION_MAX_SESSIONS = 50;
export const STUDIO_EXECUTION_MAX_EVENTS = 500;
export const STUDIO_TOOL_PAYLOAD_LIMIT = 16 * 1024;
export const STUDIO_FINAL_ANSWER_LIMIT = 64 * 1024;

export interface StudioTruncatedPayload {
  truncated: true;
  originalBytes: number;
  preview: string;
}

export type StudioToolPayload = Record<string, unknown> | StudioTruncatedPayload;

export interface StudioUserMessageEvent {
  type: 'user-message';
  at: number;
  turnId: string;
  text: string;
}

export interface StudioToolStartEvent {
  type: 'tool-start';
  at: number;
  turnId: string;
  callId: string;
  toolName: string;
  params: StudioToolPayload;
}

export interface StudioToolResultEvent {
  type: 'tool-result';
  at: number;
  turnId: string;
  callId: string;
  toolName: string;
  ok: boolean;
  durationMs?: number;
  result: StudioToolPayload;
  error?: string;
}

export interface StudioFinalAnswerEvent {
  type: 'final-answer';
  at: number;
  turnId: string;
  text: string;
  truncationMarker?: string;
}

export interface StudioSystemErrorEvent {
  type: 'system-error';
  at: number;
  turnId: string;
  code: string;
  message: string;
}

export type StudioExecutionEvent =
  | StudioUserMessageEvent
  | StudioToolStartEvent
  | StudioToolResultEvent
  | StudioFinalAnswerEvent
  | StudioSystemErrorEvent;

export interface StudioExecutionSession {
  version: typeof STUDIO_EXECUTION_VERSION;
  key: string;
  routeKey?: string;
  createdAt: number;
  updatedAt: number;
  events: StudioExecutionEvent[];
}

export interface StudioExecutionIndexEntry {
  key: string;
  routeKey?: string;
  updatedAt: number;
  title: string;
}

export interface StudioExecutionIndex {
  version: typeof STUDIO_EXECUTION_VERSION;
  sessions: StudioExecutionIndexEntry[];
}

export function isStudioExecutionIndex(value: unknown): value is StudioExecutionIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StudioExecutionIndex>;
  if (v.version !== STUDIO_EXECUTION_VERSION || !Array.isArray(v.sessions)) return false;
  return v.sessions.every((entry) => (
    !!entry &&
    typeof entry === 'object' &&
    typeof entry.key === 'string' &&
    typeof entry.updatedAt === 'number' &&
    typeof entry.title === 'string' &&
    (entry.routeKey === undefined || typeof entry.routeKey === 'string')
  ));
}

export function isStudioExecutionSession(value: unknown): value is StudioExecutionSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<StudioExecutionSession>;
  return (
    v.version === STUDIO_EXECUTION_VERSION &&
    typeof v.key === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number' &&
    Array.isArray(v.events) &&
    (v.routeKey === undefined || typeof v.routeKey === 'string')
  );
}

export function normalizeRouteSessionKey(pathname: string): string {
  const normalized = pathname
    .split('?')[0]
    .split('#')[0]
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '') || '/';
  return `route:${normalized}`;
}

export function normalizeChatSessionKey(chatSessionId: string | number): string {
  return `chat:${String(chatSessionId).trim()}`;
}

function hashSessionKey(key: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x1000003b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0')
    + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * 页端持久化和宿主远程读取必须使用同一条键映射。
 * 入参既接受逻辑会话键（chat:... / route:...），也接受已经映射过的存储键。
 */
export function studioExecutionStorageKey(key: string): string {
  if (key.startsWith(STUDIO_EXECUTION_SESSION_PREFIX)) return key;
  return `${STUDIO_EXECUTION_SESSION_PREFIX}${hashSessionKey(key)}`;
}

/**
 * DeepSeek 会话页 URL 已包含稳定会话 id。优先用它恢复已捕获的执行记录，
 * 其余路径继续使用规范化 route 键兜底。
 */
export function normalizeSessionKeyFromPathname(pathname: string): string {
  const match = pathname.match(/^\/(?:a\/)?chat\/s\/([^/?#]+)/);
  if (match?.[1]) {
    return normalizeChatSessionKey(match[1]);
  }
  return normalizeRouteSessionKey(pathname);
}

export function createEmptyStudioExecutionSession(
  key: string,
  now = Date.now(),
  routeKey?: string,
): StudioExecutionSession {
  return {
    version: STUDIO_EXECUTION_VERSION,
    key,
    routeKey,
    createdAt: now,
    updatedAt: now,
    events: [],
  };
}

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return text.length;
  }
}

function truncateUtf8(text: string, limit: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= limit) return text;
  return new TextDecoder().decode(bytes.slice(0, limit));
}

/**
 * 限制单个工具参数/结果的大小。超限时保留可读预览和原始字节数，
 * 不静默丢失“这里曾被截断”的事实。
 */
export function limitToolPayload(value: unknown, limit = STUDIO_TOOL_PAYLOAD_LIMIT): StudioToolPayload {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= limit) {
    return (value && typeof value === 'object' && !Array.isArray(value))
      ? value as Record<string, unknown>
      : { value };
  }
  return {
    truncated: true,
    originalBytes: byteLength(serialized),
    preview: truncateUtf8(serialized, limit),
  };
}

export function limitFinalAnswer(text: string, limit = STUDIO_FINAL_ANSWER_LIMIT): {
  text: string;
  truncationMarker?: string;
} {
  const bytes = byteLength(text);
  if (bytes <= limit) return { text };
  return {
    text: truncateUtf8(text, limit),
    truncationMarker: `\n\n> 回答过长，已截断（原始 ${bytes} 字节，仅保留前 ${limit} 字节预览）。`,
  };
}

export function appendExecutionEvent(
  session: StudioExecutionSession,
  event: StudioExecutionEvent,
  maxEvents = STUDIO_EXECUTION_MAX_EVENTS,
): void {
  session.events.push(event);
  if (session.events.length > maxEvents) {
    session.events.splice(0, session.events.length - maxEvents);
  }
  session.updatedAt = event.at;
}

export function sessionTitle(session: StudioExecutionSession): string {
  const user = session.events.find((event) => event.type === 'user-message');
  if (user && user.type === 'user-message') {
    return user.text.replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名会话';
  }
  return session.routeKey ?? session.key;
}
