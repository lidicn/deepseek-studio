/**
 * ChatMessageStore（v0.26 聊天室数据层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 ChatMessageStore（Claude 锁定）。
 * 复用 MemoryStore 的 SQLite 连接（单 db 文件，方案 A），不另开 db；
 * 降级模式下走内存数组。消息不加 FTS5，仅按时间/范围查询。
 */

import * as crypto from 'node:crypto';
import type { ChatMessage, ChatMessageStore, ChatSenderType, MessageInsight, StructuredMention } from './types';
import type { MemoryStore } from '../memory-store';

/** 生成消息 id：msg-<base36 时间戳>-<6 位 base36 随机>，与 Memory.id 同款风格。 */
export function generateMessageId(): string {
  const ts = Date.now().toString(36);
  // 每位取 [0,36) 的随机下标，保证恰好 6 个 base36 字符（直接 toString(36) 会是变长）。
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(6);
  let rand = '';
  for (let i = 0; i < 6; i += 1) rand += alphabet[bytes[i] % 36];
  return `msg-${ts}-${rand}`;
}

type Db = import('node:sqlite').DatabaseSync;

interface ChatMessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  sender_type: string;
  content: string;
  timestamp: number;
  mentions_json: string;
  insights_json?: string | null;
}

/** 解析 insights_json 为 MessageInsight；非法/空 → undefined。 */
function parseInsights(raw: string | null | undefined): MessageInsight | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<MessageInsight>;
    if (parsed && typeof parsed.count === 'number' && typeof parsed.taggedAt === 'number') {
      return {
        count: parsed.count,
        reviewer: typeof parsed.reviewer === 'string' ? parsed.reviewer : undefined,
        taggedAt: parsed.taggedAt,
      };
    }
  } catch {
    /* 非法 JSON → 视为未打标 */
  }
  return undefined;
}

/** 把存储行还原为 ChatMessage（解析 mentions_json + insights_json）。 */
function rowToMessage(row: ChatMessageRow): ChatMessage {
  let mentions: StructuredMention[] = [];
  try {
    const parsed = JSON.parse(row.mentions_json);
    if (Array.isArray(parsed)) {
      mentions = parsed.filter(
        (m): m is StructuredMention =>
          m && (m.type === 'all' || (m.type === 'agent' && typeof m.participantId === 'string')),
      );
    }
  } catch {
    mentions = [];
  }
  const insights = parseInsights(row.insights_json);
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderType: row.sender_type as ChatSenderType,
    content: row.content,
    timestamp: row.timestamp,
    mentions,
    ...(insights ? { insights } : {}),
  };
}

/** 基于 SQLite（复用 MemoryStore 连接）的 ChatMessageStore 实现。 */
export class SqliteChatMessageStore implements ChatMessageStore {
  private readonly db: Db | null;
  /** 降级模式下的内存存储：roomId → 消息列表。 */
  private readonly mem = new Map<string, ChatMessage[]>();
  /** audit P2-52：已见最大 timestamp，保证 append 单调递增。 */
  private maxSeenTs = 0;

  constructor(memoryStore: MemoryStore) {
    this.db = memoryStore.getDb();
    if (this.db) this.ensureSchema(this.db);
  }

  private ensureSchema(db: Db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        insights_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_room_ts
        ON chat_messages (room_id, timestamp, id);
    `);
    // 旧库迁移：v0.26 建的 chat_messages 无 insights_json 列，CREATE IF NOT EXISTS 不会补列。
    const cols = db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'insights_json')) {
      db.exec('ALTER TABLE chat_messages ADD COLUMN insights_json TEXT');
    }
  }

  append(msg: Omit<ChatMessage, 'id'> & { id?: string }): ChatMessage {
    const full: ChatMessage = {
      id: msg.id && msg.id.length > 0 ? msg.id : generateMessageId(),
      roomId: msg.roomId,
      senderId: msg.senderId,
      senderType: msg.senderType,
      content: msg.content,
      // audit P2-52（D-4 P1 修正）：仅对缺省 timestamp 做单调钳制；
      // 显式传入的 timestamp 原样保留（测试/回放需要），不得向后/向前钳成同一毫秒。
      timestamp: this.clampTimestamp(msg.timestamp),
      mentions: msg.mentions ?? [],
      ...(msg.insights ? { insights: msg.insights } : {}),
    };
    this.maxSeenTs = Math.max(this.maxSeenTs, full.timestamp);

    if (this.db) {
      const stmt = this.db.prepare(
        `INSERT INTO chat_messages (id, room_id, sender_id, sender_type, content, timestamp, mentions_json, insights_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      stmt.run(
        full.id,
        full.roomId,
        full.senderId,
        full.senderType,
        full.content,
        full.timestamp,
        JSON.stringify(full.mentions),
        full.insights ? JSON.stringify(full.insights) : null,
      );
    } else {
      const list = this.mem.get(full.roomId) ?? [];
      list.push(full);
      this.mem.set(full.roomId, list);
    }
    return full;
  }

  /**
   * audit P2-52（D-4 P1 修正）：显式 timestamp 原样返回；仅当调用方未给时才用墙钟，
   * 并保证缺省值不早于该房间已见最大时间，让 append 缺省路径单调递增。
   */
  private clampTimestamp(ts: number | undefined): number {
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    return Math.max(Date.now(), this.maxSeenTs);
  }

  getMessages(
    roomId: string,
    opts?: { throughMessageId?: string; limit?: number },
  ): ChatMessage[] {
    const through = opts?.throughMessageId;
    const limit = opts?.limit;
    // audit P2-51：SQL 路径下推 LIMIT，避免整房间全表加载后再内存 slice。
    if (this.db && through === undefined && typeof limit === 'number' && limit >= 0) {
      // audit P2-51：SQL 下推取最近 N 条（先倒序 LIMIT 再正序返回），避免整房间全表加载。
      const rows = this.db
        .prepare(
          'SELECT * FROM (SELECT id, room_id, sender_id, sender_type, content, timestamp, mentions_json, insights_json FROM chat_messages WHERE room_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?) ORDER BY timestamp ASC, id ASC',
        )
        .all(roomId, limit) as unknown as ChatMessageRow[];
      return rows.map(rowToMessage);
    }
    const all = this.loadRoom(roomId);
    let selected = all;
    if (through !== undefined) {
      const idx = all.findIndex((m) => m.id === through);
      selected = idx >= 0 ? all.slice(0, idx + 1) : [];
    }
    if (typeof limit === 'number' && limit >= 0 && selected.length > limit) {
      selected = selected.slice(selected.length - limit);
    }
    return selected;
  }

  count(roomId: string): number {
    if (this.db) {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE room_id = ?')
        .get(roomId) as { n: number } | undefined;
      return row?.n ?? 0;
    }
    return this.mem.get(roomId)?.length ?? 0;
  }

  /**
   * 给某条消息打「洞察数」标签（v0.28 PoC 门槛 #6 对照用）。
   * 覆盖写：同一消息重复打标取最后一次。返回是否命中并更新。
   */
  tagInsights(roomId: string, messageId: string, insight: { count: number; reviewer?: string }): boolean {
    const full: MessageInsight = {
      count: insight.count,
      ...(insight.reviewer !== undefined ? { reviewer: insight.reviewer } : {}),
      taggedAt: Date.now(),
    };
    const json = JSON.stringify(full);
    if (this.db) {
      const res = this.db
        .prepare('UPDATE chat_messages SET insights_json = ? WHERE room_id = ? AND id = ?')
        .run(json, roomId, messageId);
      return (res.changes ?? 0) > 0;
    }
    const list = this.mem.get(roomId);
    if (!list) return false;
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    list[idx] = { ...list[idx], insights: full };
    return true;
  }

  /** 读取某房间全部消息，按 timestamp 升序；并列时 mem 走单调插入序，SQL 走 id 兜底。 */
  private loadRoom(roomId: string): ChatMessage[] {
    if (this.db) {
      const rows = this.db
        .prepare(
          'SELECT id, room_id, sender_id, sender_type, content, timestamp, mentions_json, insights_json FROM chat_messages WHERE room_id = ? ORDER BY timestamp ASC, id ASC',
        )
        .all(roomId) as unknown as ChatMessageRow[];
      return rows.map(rowToMessage);
    }
    const list = this.mem.get(roomId) ?? [];
    // D-4 P1：同 timestamp 不按随机 id 排序；JS sort 稳定，tie 时保留 list 即插入序。
    return [...list].sort((a, b) => a.timestamp - b.timestamp);
  }
}
