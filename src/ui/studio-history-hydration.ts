/**
 * 跨设备会话水合：当本地执行记录缺失、但会话键是原生 chat:<id> 时，
 * 直接从 DeepSeek 历史接口拉取 user/assistant 文本，重建一份只读视图。
 *
 * 只提取 user 的 REQUEST 片段和 assistant 的 RESPONSE 片段；THINK 等其余
 * 片段不进入执行记录，也不伪造本地从未出现过的工具卡。
 */

import {
  createEmptyStudioExecutionSession,
  limitFinalAnswer,
  type StudioExecutionEvent,
  type StudioExecutionSession,
} from '../shared/studio-execution';

const CHAT_KEY_PREFIX = 'chat:';
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

export interface HistoryFragment {
  type?: string;
  content?: string;
}

export interface HistoryMessage {
  message_id?: number | string;
  role?: string;
  inserted_at?: number;
  fragments?: HistoryFragment[];
}

export interface HistoryPayload {
  code?: number;
  data?: {
    biz_data?: {
      chat_messages?: HistoryMessage[] | null;
    } | null;
  } | null;
}

export interface HistoryHydrationOptions {
  /** 便于测试替换；默认用页面全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 便于测试替换；默认读 localStorage.userToken。 */
  getAuthToken?: () => string | null;
  now?: () => number;
}

/**
 * DeepSeek 把登录 token 存在 localStorage.userToken，形如 {"value":"..."}。
 * 也兼容裸字符串，避免上游存储格式微调后直接失效。
 */
export function readDeepSeekAuthToken(
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined,
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem('userToken');
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 上游若改成裸字符串存储，仍按 token 使用。
      const bare = raw.trim();
      return bare ? bare : null;
    }
    const value = parsed && typeof parsed === 'object' && 'value' in parsed
      ? (parsed as { value?: unknown }).value
      : parsed;
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function fragmentText(message: HistoryMessage, type: string): string {
  const fragments = Array.isArray(message.fragments) ? message.fragments : [];
  return fragments
    .filter((fragment) => (fragment.type ?? '').toUpperCase() === type)
    .map((fragment) => fragment.content ?? '')
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
}

/**
 * 纯解析：把原生历史消息映射成 Studio 执行事件。
 * 保持服务端顺序，不推断工具调用，空文本直接跳过。
 */
export function parseHistoryMessages(
  key: string,
  messages: HistoryMessage[],
  now = Date.now(),
): StudioExecutionSession {
  const session = createEmptyStudioExecutionSession(key, now);
  const events: StudioExecutionEvent[] = [];
  for (const message of messages) {
    const role = (message.role ?? '').toUpperCase();
    const at = typeof message.inserted_at === 'number'
      ? Math.round(message.inserted_at * 1000)
      : now;
    const turnId = message.message_id != null
      ? `history-${message.message_id}`
      : `history-${events.length}`;
    if (role === 'USER') {
      const text = fragmentText(message, 'REQUEST');
      if (text) events.push({ type: 'user-message', at, turnId, text });
    } else if (role === 'ASSISTANT') {
      const text = fragmentText(message, 'RESPONSE');
      if (text) {
        const limited = limitFinalAnswer(text);
        events.push({
          type: 'final-answer',
          at,
          turnId,
          text: limited.text,
          ...(limited.truncationMarker ? { truncationMarker: limited.truncationMarker } : {}),
        });
      }
    }
  }
  session.events = events;
  session.updatedAt = now;
  return session;
}

/**
 * 生成水合函数。非 chat:<id> 键、无 token、请求失败、空历史都返回 null，
 * 由调用方回落到明确的空态，而不是静默伪造内容。
 */
export function createHistoryHydrator(
  options: HistoryHydrationOptions = {},
): (key: string) => Promise<StudioExecutionSession | null> {
  const fetchImpl = options.fetchImpl
    ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
  const getAuthToken = options.getAuthToken ?? (() => readDeepSeekAuthToken());
  const now = options.now ?? (() => Date.now());

  return async (key: string): Promise<StudioExecutionSession | null> => {
    const normalized = key.trim();
    if (!normalized.startsWith(CHAT_KEY_PREFIX)) return null;
    const chatId = normalized.slice(CHAT_KEY_PREFIX.length);
    if (!CHAT_ID_PATTERN.test(chatId)) return null;
    if (!fetchImpl) return null;

    let token: string | null = null;
    try {
      token = getAuthToken();
    } catch {
      token = null;
    }
    if (!token) return null;

    let response: Response;
    try {
      response = await fetchImpl(
        `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatId)}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            accept: '*/*',
            authorization: `Bearer ${token}`,
          },
        },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let payload: HistoryPayload | null = null;
    try {
      payload = (await response.json()) as HistoryPayload;
    } catch {
      return null;
    }
    if (!payload || payload.code !== 0) return null;
    const messages = payload.data?.biz_data?.chat_messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;

    const session = parseHistoryMessages(normalized, messages, now());
    return session.events.length > 0 ? session : null;
  };
}
