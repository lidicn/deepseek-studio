/**
 * RoomMeetingState 持久化（v0.29 · Claude 主开发）
 *
 * 契约来源：src/host/bot/types.ts 的 ChatRoomStateStore / RoomMeetingState /
 * MeetingStrategy / MeetingStatus（Claude 锁定）。
 *
 * 复用 MemoryStore 的 SQLite 连接（单 db 文件，与 chat_messages / chat_snapshots 同库），
 * 降级模式走内存 Map。
 *
 * **为什么独立于 chat_snapshots**：快照表的 version/CAS/租约是为「摘要写入防覆盖」设计的
 * 并发控制。会议策略写入是低频、无竞争的控制面操作，不该与摘要的乐观锁耦合 —— 一次策略
 * 更新不该 bump snapshot.version，反之摘要提交也不该携带策略。独立表 = 零迁移、零干扰。
 *
 * 状态机（幂等）：
 *   idle ──startMeeting──▶ active ──endMeeting──▶ closed ──startMeeting──▶ active
 *   active 时 startMeeting 是 no-op（不覆盖既有策略）；closed/idle 时 endMeeting 是 no-op。
 *
 * 线程模型：单进程单连接（node:sqlite 同步 API），无跨进程竞争；不另加行锁。
 */

import type { MeetingStrategy, MeetingStatus, ChatRoomStateStore, RoomMeetingState } from './types';
import type { MemoryStore } from '../memory-store';

type Db = import('node:sqlite').DatabaseSync;

/** 落库行（snake_case ↔ 契约 camelCase 的映射在 load/rowToState 完成）。 */
interface RoomStateRow {
  room_id: string;
  status: string;
  strategy_json: string;
  rounds_since_summary: number;
  updated_at: number;
  updated_by: string;
}

const STATUSES: readonly MeetingStatus[] = ['idle', 'active', 'closed'];
const DEFAULT_ROUNDS = 3;

/** 兜底策略：生成器失败/超时/输出不合法时使用，绝不阻塞会议开启。 */
export function defaultMeetingStrategy(topic: string): MeetingStrategy {
  return {
    focusTopics: topic.trim() ? [topic.trim()] : [],
    minRoundsBeforeAutoSummary: DEFAULT_ROUNDS,
  };
}

const isMeetingStatus = (v: unknown): v is MeetingStatus =>
  typeof v === 'string' && (STATUSES as readonly string[]).includes(v);

/**
 * 宽松解析策略 JSON：字段类型不合法或越界一律回落到合理默认，绝不让一次脏数据
 * 卡死会议（生成器输出是模型文本，不可信）。
 */
export function parseMeetingStrategy(raw: unknown, fallbackTopic?: string): MeetingStrategy {
  if (!raw || typeof raw !== 'object') {
    return {
      focusTopics: fallbackTopic && fallbackTopic.trim() ? [fallbackTopic.trim()] : [],
      minRoundsBeforeAutoSummary: DEFAULT_ROUNDS,
    };
  }

  const obj = raw as Record<string, unknown>;

  let focusTopics: string[] = [];
  const topics = obj.focusTopics;
  if (Array.isArray(topics)) {
    const clean = topics
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim());
    focusTopics = clean;
  }

  let minRounds = DEFAULT_ROUNDS;
  const rounds = obj.minRoundsBeforeAutoSummary;
  if (typeof rounds === 'number' && Number.isFinite(rounds)) {
    // 下界 1（每轮都总结退化为旧行为，但仍属用户显式选择）；上界 20 防模型胡言。
    minRounds = Math.min(20, Math.max(1, Math.round(rounds)));
  }

  let summaryStyle: string | undefined;
  const style = obj.summaryStyle;
  if (typeof style === 'string' && style.trim().length > 0) {
    summaryStyle = style.trim();
  }

  // focusTopics 全缺时保留兜底主题（模型可能返回空数组但会议主题是真的）
  if (focusTopics.length === 0 && fallbackTopic && fallbackTopic.trim()) {
    focusTopics = [fallbackTopic.trim()];
  }

  return { focusTopics, minRoundsBeforeAutoSummary: minRounds, ...(summaryStyle ? { summaryStyle } : {}) };
}

function rowToState(row: RoomStateRow): RoomMeetingState {
  return {
    status: isMeetingStatus(row.status) ? row.status : 'idle',
    strategy: parseMeetingStrategy(safeParse(row.strategy_json)),
    roundsSinceSummary: Number(row.rounds_since_summary) || 0,
  };
}

function safeParse(json: string): unknown {
  if (!json || json === '{}') return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 基于 SQLite（复用 MemoryStore 连接）的 ChatRoomStateStore 实现。 */
export class SqliteRoomStateStore implements ChatRoomStateStore {
  private readonly db: Db | null;
  /** 降级模式下的内存存储：roomId → 行。 */
  private readonly mem = new Map<string, RoomStateRow>();

  constructor(memoryStore: MemoryStore) {
    this.db = memoryStore.getDb();
    if (this.db) this.ensureSchema(this.db);
  }

  private ensureSchema(db: Db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_room_state (
        room_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        strategy_json TEXT NOT NULL DEFAULT '{}',
        rounds_since_summary INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  private load(roomId: string): RoomStateRow | null {
    if (this.db) {
      const r = this.db
        .prepare(
          'SELECT room_id, status, strategy_json, rounds_since_summary, updated_at, updated_by FROM chat_room_state WHERE room_id = ?',
        )
        .get(roomId) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        room_id: String(r.room_id ?? roomId),
        status: String(r.status ?? 'idle'),
        strategy_json: String(r.strategy_json ?? '{}'),
        rounds_since_summary: Number(r.rounds_since_summary ?? 0),
        updated_at: Number(r.updated_at ?? 0),
        updated_by: String(r.updated_by ?? ''),
      };
    }
    const m = this.mem.get(roomId);
    return m ? { ...m } : null;
  }

  private save(row: RoomStateRow): void {
    if (this.db) {
      // INSERT OR REPLACE：room_id 是主键，upsert 语义同 memory-store.ts:233 的既有 idiom。
      this.db
        .prepare(
          `INSERT OR REPLACE INTO chat_room_state (room_id, status, strategy_json, rounds_since_summary, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.room_id,
          row.status,
          row.strategy_json,
          row.rounds_since_summary,
          row.updated_at,
          row.updated_by,
        );
      return;
    }
    this.mem.set(row.room_id, { ...row });
  }

  get(roomId: string): RoomMeetingState | null {
    const row = this.load(roomId);
    return row ? rowToState(row) : null;
  }

  startMeeting(roomId: string, strategy: MeetingStrategy, by: string): void {
    const row = this.load(roomId);
    if (row && row.status === 'active') return; // 幂等：已在会中不覆盖策略

    this.save({
      room_id: roomId,
      status: 'active',
      strategy_json: JSON.stringify(strategy),
      rounds_since_summary: 0,
      updated_at: Date.now(),
      updated_by: by,
    });
  }

  endMeeting(roomId: string, by: string): void {
    const row = this.load(roomId);
    if (!row || row.status !== 'active') return; // 幂等：非会中不重复散会

    this.save({
      room_id: roomId,
      status: 'closed',
      // 策略保留（审计/复盘可见）；closed 态接线层不读策略，只凭 status 判活。
      strategy_json: row.strategy_json,
      rounds_since_summary: 0,
      updated_at: Date.now(),
      updated_by: by,
    });
  }

  incrementRounds(roomId: string): void {
    const row = this.load(roomId) ?? this.blankRow(roomId);
    this.save({ ...row, rounds_since_summary: (Number(row.rounds_since_summary) || 0) + 1 });
  }

  resetRounds(roomId: string): void {
    const row = this.load(roomId);
    if (!row || row.rounds_since_summary === 0) return;
    this.save({ ...row, rounds_since_summary: 0 });
  }

  private blankRow(roomId: string): RoomStateRow {
    return {
      room_id: roomId,
      status: 'idle',
      strategy_json: '{}',
      rounds_since_summary: 0,
      updated_at: Date.now(),
      updated_by: '',
    };
  }
}
