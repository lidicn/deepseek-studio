/**
 * ChatMessageStore（v0.26 聊天室数据层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 ChatMessageStore（Claude 锁定）。
 * 复用 MemoryStore 的 SQLite 连接（单 db 文件，方案 A），不另开 db；
 * 降级模式下走内存数组。消息不加 FTS5，仅按时间/范围查询。
 */

import * as crypto from 'node:crypto';
import type { ChatMessage, ChatMessageStore, ChatSenderType, StructuredMention } from './types';
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
}

/** 把存储行还原为 ChatMessage（解析 mentions_json）。 */
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
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderType: row.sender_type as ChatSenderType,
    content: row.content,
    timestamp: row.timestamp,
    mentions,
  };
}

/** 基于 SQLite（复用 MemoryStore 连接）的 ChatMessageStore 实现。 */
export class SqliteChatMessageStore implements ChatMessageStore {
  private readonly db: Db | null;
  /** 降级模式下的内存存储：roomId → 消息列表。 */
  private readonly mem = new Map<string, ChatMessage[]>();

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
        mentions_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_room_ts
        ON chat_messages (room_id, timestamp, id);
    `);
  }

  append(msg: Omit<ChatMessage, 'id'> & { id?: string }): ChatMessage {
    const full: ChatMessage = {
      id: msg.id && msg.id.length > 0 ? msg.id : generateMessageId(),
      roomId: msg.roomId,
      senderId: msg.senderId,
      senderType: msg.senderType,
      content: msg.content,
      timestamp: msg.timestamp ?? Date.now(),
      mentions: msg.mentions ?? [],
    };

    if (this.db) {
      const stmt = this.db.prepare(
        `INSERT INTO chat_messages (id, room_id, sender_id, sender_type, content, timestamp, mentions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      stmt.run(
        full.id,
        full.roomId,
        full.senderId,
        full.senderType,
        full.content,
        full.timestamp,
        JSON.stringify(full.mentions),
      );
    } else {
      const list = this.mem.get(full.roomId) ?? [];
      list.push(full);
      this.mem.set(full.roomId, list);
    }
    return full;
  }

  getMessages(
    roomId: string,
    opts?: { throughMessageId?: string; limit?: number },
  ): ChatMessage[] {
    const all = this.loadRoom(roomId);
    let selected = all;
    const through = opts?.throughMessageId;
    if (through !== undefined) {
      const idx = all.findIndex((m) => m.id === through);
      selected = idx >= 0 ? all.slice(0, idx + 1) : [];
    }
    const limit = opts?.limit;
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

  /** 读取某房间全部消息，按 (timestamp, id) 升序。 */
  private loadRoom(roomId: string): ChatMessage[] {
    if (this.db) {
      const rows = this.db
        .prepare(
          'SELECT id, room_id, sender_id, sender_type, content, timestamp, mentions_json FROM chat_messages WHERE room_id = ? ORDER BY timestamp ASC, id ASC',
        )
        .all(roomId) as unknown as ChatMessageRow[];
      return rows.map(rowToMessage);
    }
    const list = this.mem.get(roomId) ?? [];
    return [...list].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
