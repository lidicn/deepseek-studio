/**
 * 宿主侧「本轮用户话语」台账（2026-11-13，配合 `memory-write-gate`）
 *
 * 为什么需要两份来源：
 *   ① **页端**聊天路径的用户原话，已经由页端 UI 经 `kv-set` 落进宿主 KV
 *      （`studio.execution.v2.session.<hash>` 里的 `user-message` 事件）——
 *      这是真机现场那条会话的既有事实，宿主读 KV 即可，不必改注入层。
 *   ② **宿主自己的入口**（`handleUserMessage` 这类宿主直接收到用户话语的路径）
 *      没有 KV 写入方，只能由宿主自己记一笔。
 *
 * 台账只做「最近一条」：硬闸问的是「本轮用户说了什么」，不是历史归档。
 * 条目带 TTL —— 三小时前的一句「记住」不能给现在这次写入当证据。
 */

export interface UserTurn {
  readonly text: string;
  readonly at: number;
}

export interface UserTurnLedger {
  /** 记一笔（同一会话覆盖，只保留最近一条）。 */
  record(conversationId: string, text: string, at?: number): void;
  /** 取最近一条；超过 TTL 视为没有。 */
  latest(conversationId: string, now?: number): UserTurn | undefined;
  /** 清空（宿主停止时调用）。 */
  clear(): void;
  /** 当前条目数（诊断/测试用）。 */
  readonly size: number;
}

export interface UserTurnLedgerOptions {
  /** 条目存活时间，缺省 30 分钟。 */
  readonly ttlMs?: number;
  /** 会话数上限，缺省 200（超过按最旧淘汰）。 */
  readonly maxConversations?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONVERSATIONS = 200;

export function createUserTurnLedger(options: UserTurnLedgerOptions = {}): UserTurnLedger {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
  // Map 的插入顺序即「写入先后」：覆盖写会先 delete 再 set，保持 LRU 语义。
  const entries = new Map<string, UserTurn>();

  return {
    get size() {
      return entries.size;
    },
    record(conversationId, text, at = Date.now()) {
      const key = String(conversationId ?? '');
      const val = String(text ?? '');
      if (!key || !val.trim()) return;
      entries.delete(key);
      entries.set(key, { text: val, at });
      while (entries.size > maxConversations) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    latest(conversationId, now = Date.now()) {
      const key = String(conversationId ?? '');
      if (!key) return undefined;
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now - hit.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit;
    },
    clear() {
      entries.clear();
    },
  };
}
