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
  /**
   * 最近一次从原生历史水合的时间。
   * 本地记录可能只捕获到部分轮次，不能仅凭「已有回答」就认定完整；
   * 记录同步时间后可在 TTL 内跳过重复请求，又能在远端新增轮次后再次补齐。
   */
  historySyncedAt?: number;
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
    (v.routeKey === undefined || typeof v.routeKey === 'string') &&
    (v.historySyncedAt === undefined || typeof v.historySyncedAt === 'number')
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
  const raw = String(chatSessionId).trim();
  // 幂等：已经是 chat: 键就原样返回。
  // 历史上这里无条件加前缀，捕获链路对同一个 chat_session_id 归一化了两次，
  // 落盘键变成 chat:chat:<id>；而切换对话时按 URL 派生的是 chat:<id>，
  // 两个键对不上 → 切会话后 overlay 查不到记录 → 空白。
  if (raw.startsWith('chat:')) return raw;
  return `chat:${raw}`;
}

/**
 * 规范键：把历史遗留的双前缀键（chat:chat:<id>）折回单前缀（chat:<id>）。
 */
export function canonicalChatSessionKey(key: string): string {
  if (key.startsWith('chat:chat:')) return `chat:${key.slice('chat:chat:'.length)}`;
  return key;
}

/**
 * 历史别名：规范键（chat:<id>）对应的旧双前缀键（chat:chat:<id>）。
 * 没有旧别名时返回 undefined。
 */
export function legacyChatSessionKey(key: string): string | undefined {
  if (key.startsWith('chat:') && !key.startsWith('chat:chat:')) return `chat:${key}`;
  return undefined;
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
export function normalizeSessionKeyFromPathname(pathname: string | undefined | null): string {
  // 文档早期（srcdoc/about:blank/注入过早）取不到 pathname 是常态，
  // 不能抛错：调用方外层通常有 catch，会把整段会话识别静默吞掉。
  if (typeof pathname !== 'string' || !pathname) {
    return normalizeRouteSessionKey('/');
  }
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

/**
 * 按 **UTF-8 字节** 上限截断，且**不在多字节字符中间切断**。
 *
 * C1 墨鉴 BUG-001：同一函数里混用两把尺（判定看 UTF-16 码元数、截断看字节数）
 *   → 中文载荷上限被放大近 3 倍，且看不到 `truncated` 标记。
 * C1 墨鉴 BUG-002：直接 `decoder.decode(bytes.slice(0, limit))` 会在多字节字符
 *   中间切断 → TextDecoder 非 fatal 模式输出 U+FFFD → 预览尾部乱码、且乱码永久落盘。
 *
 * 现在：单一字节口径 + **边界回退**。
 *   ① 先切到 limit 字节；
 *   ② 若切点落在多字节字符中间（且该字符尚未完整），**回退到该字符的起始边界**
 *      ——宁可少留几个字节，也绝不切半个字符。
 *
 * 边界回退的实现不依赖「解码后数 U+FFFD」（那会误伤正文里本来的 U+FFFD），
 * 而是用 UTF-8 的**续字节特征**（0b10xxxxxx）向前回退：
 *   从切点往回扫，直到落在一个**首字节**（0b11xxxxxx）或 ASCII（< 0x80）上。
 * 这样得到的是「最后一个完整字符的结尾」。
 *
 * 注意：首字节的完整长度由其高 4 位决定（110xxxxx→2 字节、1110xxxx→3、
 * 11110xxx→4），回退时按该长度再往前核对一次，避免落在**非法序列**上。
 */
export function truncateUtf8ByBytes(text: string, limit: number): string {
  if (limit <= 0) return '';
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= limit) return text;

  // ① 切到 limit 字节。
  let end = limit;
  // ② 边界回退：若切点落在**多字节字符中间**，回退到该字符的**起始边界**。
  //
  //    实现：从切点往回找**最后一个完整字符的结尾**。
  //    UTF-8 首字节的完整长度由其高 4 位决定：
  //      0xxxxxxx → 1 字节（ASCII）
  //      110xxxxx → 2 字节
  //      1110xxxx → 3 字节
  //      11110xxx → 4 字节
  //    做法：从 `end` 往回扫，**跳过所有续字节**（0b10xxxxxx），
  //    落到首字节上；再用首字节算出该字符总长度 `need`：
  //      - `start + need <= end` → 该字符**完整**，保留它（end 不变）；
  //      - `start + need > end`  → 该字符**被切断**，整个丢掉（end = start）。
  //    ASCII 字符 need=1，天然总是完整。
  let start = end;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) {
    start--;
  }
  if (start < end) {
    // start 指向某个字符的首字节（若 start===end 说明切点恰好落在字符边界）。
    const lead = bytes[start];
    let need = 1;
    if ((lead & 0xe0) === 0xc0) need = 2;
    else if ((lead & 0xf0) === 0xe0) need = 3;
    else if ((lead & 0xf8) === 0xf0) need = 4;
    // 该字符没写完 → 整个丢掉（end 回退到 start）。
    if (start + need > end) end = start;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
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
  // C1 墨鉴 BUG-001：判定与截断**统一按 UTF-8 字节**。
  // 原实现用 `serialized.length`（UTF-16 码元数）判定，而 limit 是字节语义
  // → 16000 个汉字（16000 码元 / 约 48000 字节）被判为「未超限」原样返回，
  // 上限被放大近 3 倍且看不到 truncated 标记。现在只认字节数。
  if (byteLength(serialized) <= limit) {
    return (value && typeof value === 'object' && !Array.isArray(value))
      ? value as Record<string, unknown>
      : { value };
  }
  return {
    truncated: true,
    originalBytes: byteLength(serialized),
    preview: truncateUtf8ByBytes(serialized, limit),
  };
}

export function limitFinalAnswer(text: string, limit = STUDIO_FINAL_ANSWER_LIMIT): {
  text: string;
  truncationMarker?: string;
} {
  const bytes = byteLength(text);
  if (bytes <= limit) return { text };
  return {
    text: truncateUtf8ByBytes(text, limit),
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
