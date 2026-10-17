/**
 * MessageHistory 真源（M2-1）：宿主持有 messages[]，不再每次去问网页会话。
 *
 * 定位：地基的地基。本模块不接任何真实数据源、不读网页、不碰 agent-loop；
 *   只把「宿主持有一份可追加 / 可查询 / 可快照 / 可恢复的对话历史」做对。
 *   M2-3 TaskLoop 才会把它接到 WebEngine 上。
 *
 * 硬性质：
 *   - 纯内存、零 IO、零依赖（不 import 任何 src 内其他模块）；
 *   - append 返回落库后的完整对象（含生成的 id 与 createdAt）；
 *   - all() 返回浅拷贝数组，调用方 push/pop 改不动内部；消息字段 readonly；
 *   - snapshot 带 version:1；restore 遇 version!==1 或结构非法一律抛错，不静默降级；
 *   - idFactory / now 可注入，测试用确定性时钟与 id。
 */

// ---------------------------------------------------------------- 类型

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  /** 稳定唯一 id（append 时缺省由 idFactory 生成）。 */
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  /** role='tool' 时关联的调用 id。 */
  readonly toolCallId?: string;
  /** 落库时间戳（缺省由 now() 生成）。 */
  readonly createdAt: number;
}

/** append 入参：id / createdAt 可缺省（缺省由内部生成），其余必填。 */
export type AppendMessageInput = Omit<ChatMessage, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
};

export interface MessageHistorySnapshot {
  readonly version: 1;
  readonly messages: readonly ChatMessage[];
}

export interface MessageHistory {
  /** 追加一条消息，返回落库后的完整对象（含 id / createdAt）。 */
  append(msg: AppendMessageInput): ChatMessage;
  /** 全部消息，按追加顺序；返回浅拷贝，改它不影响内部。 */
  all(): readonly ChatMessage[];
  /** 按角色过滤，保持原顺序。 */
  byRole(role: ChatRole): readonly ChatMessage[];
  /** 末尾 n 条；n<=0 返回空；n>size 返回全部。 */
  lastN(n: number): readonly ChatMessage[];
  /** 清空全部消息。 */
  clear(): void;
  /** 当前消息数。 */
  size(): number;
  /** 可 JSON.stringify 的快照（带 version:1）。 */
  snapshot(): MessageHistorySnapshot;
  /** 从快照恢复；version 不认识 / 结构非法一律抛错。 */
  restore(snap: unknown): void;
}

export interface MessageHistoryOptions {
  /** id 生成器（缺省：单调递增 msg-N）。 */
  idFactory?: () => string;
  /** 时钟（缺省：Date.now）。 */
  now?: () => number;
}

// ---------------------------------------------------------------- 常量与工具

/** 当前快照协议版本。恢复时只认 1。 */
export const MESSAGE_HISTORY_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------- 工厂

export function createMessageHistory(opts?: MessageHistoryOptions): MessageHistory {
  let messages: ChatMessage[] = [];
  let nextId = 1;

  const idFactory =
    opts?.idFactory ??
    ((): string => `msg-${nextId++}`);
  const now = opts?.now ?? ((): number => Date.now());

  function append(msg: AppendMessageInput): ChatMessage {
    const entry: ChatMessage = {
      id: msg.id ?? idFactory(),
      role: msg.role,
      content: msg.content,
      ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
      createdAt: msg.createdAt ?? now(),
    };
    messages.push(entry);
    return entry;
  }

  function all(): readonly ChatMessage[] {
    // 浅拷贝数组：调用方 push/pop 不影响内部；消息对象本身字段 readonly。
    return [...messages];
  }

  function byRole(role: ChatRole): readonly ChatMessage[] {
    return messages.filter((m) => m.role === role);
  }

  function lastN(n: number): readonly ChatMessage[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    return messages.slice(-n);
  }

  function clear(): void {
    messages = [];
  }

  function size(): number {
    return messages.length;
  }

  function snapshot(): MessageHistorySnapshot {
    return { version: MESSAGE_HISTORY_VERSION, messages: [...messages] };
  }

  function restore(snap: unknown): void {
    if (!isRecord(snap)) {
      throw new TypeError('MessageHistory.restore: 快照必须是对象');
    }
    if (snap.version !== MESSAGE_HISTORY_VERSION) {
      throw new TypeError(
        `MessageHistory.restore: 不认识的快照版本 ${String(snap.version)}（只认 version=${MESSAGE_HISTORY_VERSION}）`,
      );
    }
    if (!Array.isArray(snap.messages)) {
      throw new TypeError('MessageHistory.restore: 快照缺少 messages 数组');
    }
    // 拷贝入参数组，切断与调用方引用的关联。
    messages = [...(snap.messages as ChatMessage[])];
  }

  return { append, all, byRole, lastN, clear, size, snapshot, restore };
}
