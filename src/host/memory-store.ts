/**
 * 本地记忆系统（v2.0，SQLite + FTS5，Bot 基础设施 · 副开发 CodeBuddy 负责）
 *
 * 升级自动因（侦查报告硬约束③）：v1 扁平 JSON 全量重写，撑不起 Bot 的
 * 「治理级记忆」。v2 落点：
 * - 存储：SQLite（node:sqlite，Node 24 内置）+ FTS5 全文检索（trigram 分词，
 *   中文子串可命中 —— 沿用 memory-agent 同款结论：unicode61 会把连续汉字
 *   当成单个 token 导致中文专名不命中）；
 * - 新字段：source（来源）/ confidence（可信度 0-1）/ personaTags（人设维度）/
 *   contentHash（去重）/ invalidAt（失效标记，失效而非删除）；
 * - 接口：search(query) 混合检索（FTS bm25 → LIKE 兜底 → 标签精确加权）、
 *   invalidate(id) 失效、listByPersona(tag) 人设路由；
 * - 兼容：save/remove/getMemoryStore 签名不变；formatForPrompt 输出格式与
 *   v1 一致（- #id [type] name: content）；旧 memories.json 首次启动自动导入。
 *
 * 降级路径：node:sqlite 不可用（Node < 22.5）或库文件打不开时，自动退化为
 * 内存存储（检索退化为子串扫描），保证宿主不崩；控制台会打 warn。
 *
 * 接口契约：src/host/bot/types.ts 的 MemoryStoreV2（Claude 定义，签名锁定）。
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { Memory, MemoryStoreV2 } from './bot/types';
import { MEMORY_INJECT_LIMIT } from '../inject/untrusted-memory';

export type MemoryType = 'user' | 'project';

/** v2 记忆行 = 契约 Memory + v1 遗留字段（pinned/时间戳，内部使用）。 */
export interface MemoryRow extends Memory {
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 行构造时保证存在（契约里可选），内部按必填用。 */
  readonly personaTags: string[];
}

export interface SaveMemoryParams {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly tags?: string[];
  readonly pinned?: boolean;
  /** v2：来源（谁写入的，如 'agent' / 'user' / 'curator'）。 */
  readonly source?: string;
  /** v2：可信度 0-1（人工=1，模型推断=0.5 等）。 */
  readonly confidence?: number;
  /** v2：人设维度标签，用于 listByPersona 路由。 */
  readonly personaTags?: string[];
}

export interface SaveMemoryResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
}

/** 默认记忆存储路径：~/.config/deepseek-studio/memories.db */
function defaultStorePath(): string {
  const configDir = process.env.STUDIO_CONFIG_DIR
    ?? path.join(os.homedir(), '.config', 'deepseek-studio');
  return path.join(configDir, 'memories.db');
}

/** v1 旧存储路径（用于一次性迁移导入）。 */
function legacyJsonPath(storePath: string): string {
  return path.join(path.dirname(storePath), 'memories.json');
}

function genId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidMemoryType(t: string): t is MemoryType {
  return t === 'user' || t === 'project';
}

/** 内容指纹：type + name + 规范化内容（去首尾空白 + 压缩连续空白）。 */
function contentHash(type: string, name: string, content: string): string {
  const norm = content.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(`${type}\n${name.toLowerCase()}\n${norm}`).digest('hex');
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * FTS5 查询串构造：每个空白分词加双引号成短语，OR 连接。
 * 内部双引号翻倍防注入；返回 null 表示无有效分词（走 LIKE 兜底）。
 */
function toFtsQuery(query: string): string | null {
  const toks = query.split(/\s+/).map((t) => t.replace(/"/g, '')).filter(Boolean);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t}"`).join(' OR ');
}

/** LIKE 模式转义（% _ \ 三个字符），配合 ESCAPE '\'。 */
function likePattern(q: string): string {
  const esc = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${esc}%`;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  confidence REAL,
  persona_tags_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT,
  invalid_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_invalid_at ON memories(invalid_at);
-- trigram 分词：中文子串可命中（unicode61 会把连续汉字当单 token，不可用）。
-- 代价：<3 字符的查询 FTS 不命中，由 LIKE 兜底覆盖。
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  name, content, tags,
  tokenize = 'trigram'
);
`;

/** DB 行 → MemoryRow。 */
function rowToMemory(r: Record<string, unknown>): MemoryRow {
  const base: Memory = {
    id: String(r.id),
    type: (r.type === 'project' ? 'project' : 'user') as MemoryType,
    name: String(r.name ?? ''),
    content: String(r.content ?? ''),
    tags: parseJsonArray(r.tags_json),
    ...(r.source !== null && r.source !== undefined ? { source: String(r.source) } : {}),
    ...(typeof r.confidence === 'number' ? { confidence: r.confidence as number } : {}),
    personaTags: parseJsonArray(r.persona_tags_json),
    invalidAt: typeof r.invalid_at === 'number' ? (r.invalid_at as number) : null,
  };
  return {
    ...base,
    pinned: Boolean(r.pinned),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    ...(r.content_hash !== null && r.content_hash !== undefined ? { contentHash: String(r.content_hash) } : {}),
  } as MemoryRow;
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 记忆存储管理器 v2（SQLite + FTS5，实现 MemoryStoreV2 契约）。
 *
 * 用法与 v1 相同：new MemoryStore([storePath]) / getMemoryStore()。
 * save/remove 保持同步（node:sqlite 本身同步）；契约方法为 async。
 */
export class MemoryStore implements MemoryStoreV2 {
  private db: import('node:sqlite').DatabaseSync | null = null;
  /** node:sqlite 不可用 / 打开失败时的内存降级存储。 */
  private fallback: MemoryRow[] | null = null;
  private readonly storePath: string;

  constructor(storePath?: string) {
    this.storePath = storePath ?? defaultStorePath();
    this.open();
  }

  // ===== 内部：打开 / 降级 =====

  private open(): void {
    try {
      // 延迟 require：Node < 22.5 没有 node:sqlite，静态 import 会在模块加载期
      // 崩掉整个宿主，这里兜底为内存存储。
      const require = createRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(this.storePath);
      db.exec(SCHEMA_SQL);
      this.db = db;
      this.migrateLegacyJson(db);
    } catch (e) {
      console.warn(
        '[memory] sqlite unavailable, degraded to in-memory store:',
        e instanceof Error ? e.message : String(e),
      );
      this.db = null;
      this.fallback = [];
      this.loadLegacyJsonIntoFallback();
    }
  }

  /**
   * 暴露内部 SQLite 连接句柄（v0.26 聊天室数据层复用同一连接，避免两个连接锁同一文件）。
   * 降级模式（node:sqlite 不可用）返回 null。
   */
  getDb(): import('node:sqlite').DatabaseSync | null {
    return this.db;
  }

  /** 当前是否处于内存降级模式（getDb() 返回 null 时为真）。 */
  isInMemoryFallback(): boolean {
    return this.db === null;
  }

  /** 旧 memories.json 一次性导入（仅在 DB 表为空时，保留原文件作备份）。 */
  private migrateLegacyJson(db: import('node:sqlite').DatabaseSync): void {
    const legacy = legacyJsonPath(this.storePath);
    if (legacy === this.storePath || !fs.existsSync(legacy)) return;
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n as number) ?? 0;
      if (count > 0) return;
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const ins = db.prepare(
        `INSERT OR REPLACE INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json, content_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ftsIns = db.prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)');
      let imported = 0;
      for (const raw of parsed) {
        if (!raw || typeof raw.id !== 'string') continue;
        const now = Date.now();
        const tags = Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string') : [];
        const type = raw.type === 'project' ? 'project' : 'user';
        const content = String(raw.content ?? '');
        const name = String(raw.name ?? '');
        ins.run(
          raw.id, type, name, content, JSON.stringify(tags), raw.pinned ? 1 : 0,
          'import', null, '[]', contentHash(type, name, content), null,
          Number(raw.createdAt ?? now), Number(raw.updatedAt ?? now),
        );
        const rid = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get(raw.id)?.rowid as number) ?? 0;
        ftsIns.run(rid, name, content, tags.join(' '));
        imported += 1;
      }
      if (imported > 0) {
        console.warn(`[memory] migrated ${imported} memories from ${legacy} (file kept as backup)`);
      }
    } catch (e) {
      console.warn('[memory] legacy json migration failed:', e instanceof Error ? e.message : String(e));
    }
  }

  private loadLegacyJsonIntoFallback(): void {
    const legacy = legacyJsonPath(this.storePath);
    if (legacy === this.storePath || !fs.existsSync(legacy)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const raw of parsed) {
        if (!raw || typeof raw.id !== 'string') continue;
        this.fallback!.push({
          id: raw.id,
          type: raw.type === 'project' ? 'project' : 'user',
          name: String(raw.name ?? ''),
          content: String(raw.content ?? ''),
          tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string') : [],
          source: 'import',
          personaTags: [],
          invalidAt: null,
          pinned: Boolean(raw.pinned),
          createdAt: Number(raw.createdAt ?? now),
          updatedAt: Number(raw.updatedAt ?? now),
        });
      }
    } catch {
      /* 降级路径下迁移失败不阻塞 */
    }
  }

  // ===== v1 兼容 API（同步）=====

  /** 保存一条记忆（同 type + name 已存在则更新；内容完全一致则空操作）。 */
  save(params: SaveMemoryParams): SaveMemoryResult {
    if (!isValidMemoryType(params.type)) {
      return { ok: false, error: `invalid memory type: ${params.type} (expected 'user' or 'project')` };
    }
    if (!params.name || !params.content) {
      return { ok: false, error: 'name and content are required' };
    }
    if (params.confidence !== undefined && (typeof params.confidence !== 'number' || Number.isNaN(params.confidence) || params.confidence < 0 || params.confidence > 1)) {
      return { ok: false, error: 'confidence must be a number in [0, 1]' };
    }

    const now = Date.now();
    const tags = params.tags ?? [];
    const personaTags = params.personaTags ?? [];
    const hash = contentHash(params.type, params.name, params.content);

    if (this.db) {
      // M10-5：同名行分「有效 / 已失效」两种命中。有效 → 原地更新；已失效 → 复活原行
      // （invalid_at 归零）而不是另起一行有效记录，否则账本会出现「作废 + 同名有效」
      // 两行、stats().total 单调顶高，而面板因为只看 list() 看不出重复。
      // 排序取「有效优先，其次最近更新」，两条命中共用下面同一段 UPDATE。
      const existing = this.db
        .prepare(
          `SELECT rowid AS rid, * FROM memories
           WHERE type = ? AND lower(name) = lower(?)
           ORDER BY (invalid_at IS NULL) DESC, updated_at DESC
           LIMIT 1`,
        )
        .get(params.type, params.name) as Record<string, unknown> | undefined;

      if (existing) {
        const valid = existing.invalid_at === null || existing.invalid_at === undefined;
        const existingHash = typeof existing.content_hash === 'string' ? existing.content_hash : '';
        const existingTags = parseJsonArray(existing.tags_json);
        if (valid && existingHash === hash && sameStringArray(existingTags, tags)) {
          return { ok: true, id: String(existing.id) }; // 无变化，不搅动 updatedAt
        }
        const rid = existing.rid as number;
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rid);
        this.db.prepare(
          `UPDATE memories SET content = ?, tags_json = ?, pinned = ?, source = ?, confidence = ?,
           persona_tags_json = ?, content_hash = ?, invalid_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(
          params.content, JSON.stringify(tags), (params.pinned ?? false) ? 1 : 0,
          params.source ?? null, params.confidence ?? null, JSON.stringify(personaTags), hash, now,
          String(existing.id),
        );
        this.db.prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)')
          .run(rid, params.name, params.content, tags.join(' '));
        return { ok: true, id: String(existing.id) };
      }

      const id = genId();
      this.db.prepare(
        `INSERT INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json, content_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, params.type, params.name, params.content, JSON.stringify(tags), (params.pinned ?? false) ? 1 : 0,
        params.source ?? null, params.confidence ?? null, JSON.stringify(personaTags), hash, null, now, now,
      );
      const rid = (this.db.prepare('SELECT last_insert_rowid() AS rid').get()?.rid as number) ?? 0;
      this.db.prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)')
        .run(rid, params.name, params.content, tags.join(' '));
      return { ok: true, id };
    }

    // 降级路径：内存数组
    const sameName = this.fallback!.filter(
      (m) => m.type === params.type && m.name.toLowerCase() === params.name.toLowerCase(),
    );
    // M10-5：同 SQL 路径——有效行优先，否则复活最近一条同名作废行。
    const target = sameName.find((m) => m.invalidAt === null) ?? sameName[sameName.length - 1];
    if (target) {
      const idx = this.fallback!.indexOf(target);
      this.fallback![idx] = {
        ...target, content: params.content, tags, pinned: params.pinned ?? target.pinned,
        source: params.source, confidence: params.confidence, personaTags, invalidAt: null, updatedAt: now,
      } as MemoryRow;
      return { ok: true, id: target.id };
    }
    const id = genId();
    this.fallback!.push({
      id, type: params.type as MemoryType, name: params.name, content: params.content, tags,
      pinned: params.pinned ?? false, source: params.source, confidence: params.confidence,
      personaTags, invalidAt: null, createdAt: now, updatedAt: now,
    } as MemoryRow);
    return { ok: true, id };
  }

  /** 硬删除一条记忆（返回是否命中）。注意：治理场景请用 invalidate()。 */
  remove(id: string): boolean {
    if (this.db) {
      const row = this.db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return false;
      this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rid as number);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return true;
    }
    const idx = this.fallback!.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    this.fallback!.splice(idx, 1);
    return true;
  }

  // ===== MemoryStoreV2 契约 API（async）=====

  /** 列出全部有效记忆（置顶优先，然后按更新时间倒序 —— 同 v1 排序）。 */
  async list(): Promise<Memory[]> {
    return this.sortRows(this.validRows());
  }

  /** 混合检索：FTS5(trigram) bm25 → LIKE 兜底 → 标签精确命中加权。 */
  async search(query: string, opts?: { personaTag?: string; limit?: number }): Promise<Memory[]> {
    const q = (query ?? '').trim();
    const limit = Math.max(1, opts?.limit ?? 20);
    if (!q) {
      return this.sortRows(this.applyPersonaFilter(this.validRows(), opts?.personaTag)).slice(0, limit);
    }

    let rows: MemoryRow[];
    if (this.db) {
      rows = [];
      // trigram 要求查询 >= 3 字符；不足走 LIKE
      if ([...q].length >= 3) {
        const fts = toFtsQuery(q);
        if (fts) {
          try {
            const found = this.db.prepare(
              `SELECT m.* FROM memories m
               JOIN memories_fts f ON f.rowid = m.rowid
               WHERE memories_fts MATCH ? AND m.invalid_at IS NULL
               ORDER BY bm25(memories_fts)
               LIMIT ?`,
            ).all(fts, limit * 4) as Record<string, unknown>[];
            rows = found.map(rowToMemory);
          } catch {
            rows = []; // MATCH 语法异常 → LIKE 兜底
          }
        }
      }
      if (rows.length === 0) {
        const pat = likePattern(q);
        const found = this.db.prepare(
          `SELECT * FROM memories
           WHERE invalid_at IS NULL AND (name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        ).all(pat, pat, pat, limit * 4) as Record<string, unknown>[];
        rows = found.map(rowToMemory);
      }
    } else {
      const needle = q.toLowerCase();
      rows = this.fallback!.filter(
        (m) => m.invalidAt === null &&
          (m.name.toLowerCase().includes(needle) ||
            m.content.toLowerCase().includes(needle) ||
            m.tags.some((t) => t.toLowerCase().includes(needle))),
      );
      rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
    }

    // 标签精确命中加权（稳定排序：精确标签 → 置顶 → 原相关序）
    const needle = q.toLowerCase();
    const tagged = new Set(rows.filter((m) => m.tags.some((t) => t.toLowerCase() === needle)).map((m) => m.id));
    if (tagged.size > 0) {
      rows = [
        ...rows.filter((m) => tagged.has(m.id)),
        ...rows.filter((m) => !tagged.has(m.id)),
      ];
    }
    return this.applyPersonaFilter(rows, opts?.personaTag).slice(0, limit);
  }

  /** 失效一条记忆（标记 invalidAt，数据保留；幂等，重复调用无操作）。 */
  async invalidate(id: string): Promise<void> {
    const now = Date.now();
    if (this.db) {
      this.db.prepare('UPDATE memories SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(now, now, id);
      return;
    }
    const m = this.fallback!.find((x) => x.id === id);
    if (m && m.invalidAt === null) {
      (m as { invalidAt: number | null }).invalidAt = now;
      (m as { updatedAt: number }).updatedAt = now;
    }
  }

  /** 撤销失效（回滚，供 Curator / 人工纠误）。 */
  async restore(id: string): Promise<void> {
    const now = Date.now();
    if (this.db) {
      this.db.prepare('UPDATE memories SET invalid_at = NULL, updated_at = ? WHERE id = ? AND invalid_at IS NOT NULL')
        .run(now, id);
      return;
    }
    const m = this.fallback!.find((x) => x.id === id);
    if (m && m.invalidAt !== null) {
      (m as { invalidAt: number | null }).invalidAt = null;
      (m as { updatedAt: number }).updatedAt = now;
    }
  }

  /** 按人设标签列出有效记忆（置顶优先，更新时间倒序）。 */
  async listByPersona(tag: string): Promise<Memory[]> {
    const rows = this.validRows().filter((m) => m.personaTags.includes(tag));
    return this.sortRows(rows);
  }

  /** 格式化注入系统提示词（格式与 v1 一致：- #id [type] name: content）。 */
  formatForPrompt(memories: readonly Memory[], limit = MEMORY_INJECT_LIMIT): string {
    const list = memories.slice(0, Math.max(0, limit));
    if (list.length === 0) return '';
    return list
      .map((m) => {
        const scope = m.type === 'project' ? 'project ' : '';
        return `- #${m.id} [${scope}${m.type}] ${m.name}: ${m.content}`;
      })
      .join('\n');
  }

  // ===== 辅助 API（契约外，供 UI / 诊断 / Curator）=====

  /** 按 id 取有效记忆。 */
  async get(id: string): Promise<MemoryRow | undefined> {
    if (this.db) {
      const r = this.db.prepare('SELECT * FROM memories WHERE id = ? AND invalid_at IS NULL').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToMemory(r) : undefined;
    }
    const m = this.fallback!.find((x) => x.id === id && x.invalidAt === null);
    return m ? { ...m } : undefined;
  }

  /** 列出已失效记忆（审计/回滚入口）。 */
  async listInvalidated(): Promise<MemoryRow[]> {
    const rows = this.allRows().filter((m) => m.invalidAt !== null);
    return rows.sort((a, b) => (b.invalidAt ?? 0) - (a.invalidAt ?? 0));
  }

  /** 存储统计（诊断）。 */
  stats(): { backend: 'sqlite' | 'memory'; total: number; valid: number; invalidated: number; storePath: string } {
    const all = this.allRows();
    return {
      backend: this.db ? 'sqlite' : 'memory',
      total: all.length,
      valid: all.filter((m) => m.invalidAt === null).length,
      invalidated: all.filter((m) => m.invalidAt !== null).length,
      storePath: this.storePath,
    };
  }

  /** 关闭库连接（测试 / 宿主退出）。 */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* 忽略关闭异常 */
      }
      this.db = null;
    }
    this.fallback = null;
  }

  // ===== 内部 helpers =====

  private allRows(): MemoryRow[] {
    if (this.db) {
      const found = this.db.prepare('SELECT * FROM memories').all() as Record<string, unknown>[];
      return found.map(rowToMemory);
    }
    return this.fallback ? this.fallback.map((m) => ({ ...m })) : [];
  }

  /** 仅有效记忆行（invalidAt === null）。 */
  private validRows(): MemoryRow[] {
    return this.allRows().filter((m) => m.invalidAt === null);
  }

  private sortRows(rows: MemoryRow[]): MemoryRow[] {
    return [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      // M10-7a：第二级是「个人记忆优先」——否则新写入的 project 记忆会把
      // user 档（身份/偏好）挤出注入窗口。
      if (a.type !== b.type) return a.type === 'user' ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  private applyPersonaFilter(rows: MemoryRow[], personaTag?: string): MemoryRow[] {
    if (!personaTag) return rows;
    return rows.filter((m) => m.personaTags.includes(personaTag));
  }
}

/** 全局单例（v1 兼容）。 */
let globalStore: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!globalStore) {
    globalStore = new MemoryStore();
  }
  return globalStore;
}
