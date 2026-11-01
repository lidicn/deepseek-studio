/**
 * 记忆域 · 内核（打开 / PRAGMA / 建表与迁移 / enc1 加解密 / 行映射 / 事务）
 *
 * 由 src/host/memory-store.ts 机械拆分而来（MemoryStore 巨石重构，设计稿
 * docs/设计稿/MemoryStore-巨石文件重构-20261101.md）。
 * 搬运规则：方法体逐字搬运，仅两类改动——this. → ctx.，同域调用改为域内直接调用 foo(ctx, …)。
 *
 * helper 导出说明：这些纯函数被多个域与门面共用（无状态、不碰 this），
 * 故以具名 export 供域模块与门面 import；不进入门面的对外导出面。
 */
import type { MemoryCandidate, MemoryRow, MemoryType } from './types';
import type { StoreContext } from './types';
import type { Memory } from '../bot/types';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { loadAuditCrypto, AUDIT_SEAL_PREFIX } from '../audit-crypto';

// ── 内部 helper（自 src/host/memory-store.ts 原样搬运） ─────────────────────

export const SCHEMA_SQL = `
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
  dedupe_hash TEXT,
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
-- M10-9：候选池。独立表 —— 候选不参与正式注入，也不进 memories 主表。
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_created ON memory_candidates(created_at);
-- M10-10：审计日志。before_json / after_json 为完整行快照，rollback 据此回写。
CREATE TABLE IF NOT EXISTS memory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  op TEXT NOT NULL,
  memory_id TEXT,
  actor TEXT,
  before_json TEXT,
  after_json TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_log_ts ON memory_log(ts);
CREATE INDEX IF NOT EXISTS idx_memory_log_memory ON memory_log(memory_id);
`;

export function toFtsQuery(query: string): string | null {
  const toks = query.split(/\s+/).map((t) => t.replace(/"/g, '')).filter(Boolean);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t}"`).join(' OR ');
}

export function likePattern(q: string): string {
  const esc = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${esc}%`;
}

export function legacyJsonPath(storePath: string): string {
  return path.join(path.dirname(storePath), 'memories.json');
}

export function genId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isValidMemoryType(t: string): t is MemoryType {
  return t === 'user' || t === 'project';
}

export function contentHash(type: string, name: string, content: string): string {
  const norm = content.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(`${type}\n${name.toLowerCase()}\n${norm}`).digest('hex');
}

export function dedupeHash(type: string, content: string): string {
  const norm = content.replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('sha1').update(`${type}\n${norm}`).digest('hex');
}

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function pickEviction(rows: MemoryRow[], need: number): MemoryRow[] | null {
  if (need <= 0) return [];
  const candidates = rows
    .filter((r) => r.invalidAt === null && !r.pinned)
    .sort((a, b) => {
      // project=0 先于 user=1
      const ta = a.type === 'project' ? 0 : 1;
      const tb = b.type === 'project' ? 0 : 1;
      if (ta !== tb) return ta - tb;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  if (candidates.length < need) return null;
  return candidates.slice(0, need);
}

export function rowToMemory(r: Record<string, unknown>): MemoryRow {
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

export function parseJsonArray(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function snapshotOf(row: MemoryRow): MemoryRow {
  return {
    ...row,
    tags: [...row.tags],
    personaTags: [...row.personaTags],
  } as MemoryRow;
}

export function rowToCandidate(r: Record<string, unknown>): MemoryCandidate {
  return {
    id: String(r.id),
    type: (r.type === 'project' ? 'project' : 'user') as MemoryType,
    name: String(r.name ?? ''),
    content: String(r.content ?? ''),
    tags: parseJsonArray(r.tags_json),
    reason: typeof r.reason === 'string' ? r.reason : null,
    source: typeof r.source === 'string' ? r.source : null,
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

export function parseSnapshot(v: unknown): MemoryRow | null {
  if (v && typeof v === 'object') return parseSnapshotObject(v as Record<string, unknown>);
  if (typeof v !== 'string' || !v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object') return null;
    return parseSnapshotObject(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function parseSnapshotObject(o: Record<string, unknown>): MemoryRow {
  return {
    id: String(o.id),
    type: (o.type === 'project' ? 'project' : 'user') as MemoryType,
    name: String(o.name ?? ''),
    content: String(o.content ?? ''),
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    personaTags: Array.isArray(o.personaTags)
      ? o.personaTags.filter((t): t is string => typeof t === 'string')
      : [],
    pinned: Boolean(o.pinned),
    source: typeof o.source === 'string' ? o.source : undefined,
    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    invalidAt: typeof o.invalidAt === 'number' ? o.invalidAt : null,
    createdAt: Number(o.createdAt ?? 0),
    updatedAt: Number(o.updatedAt ?? 0),
  } as MemoryRow;
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export function snapshotFingerprint(v: unknown): string {
  const row = parseSnapshot(v);
  return row ? `sha256:${sha256Hex(`${row.id}\u0000${row.content}`)}` : 'sha256:unknown';
}

export function parseCandidate(v: unknown): MemoryCandidate | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const parsed = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.id !== 'string') return null;
    return {
      id: o.id,
      type: (o.type === 'project' ? 'project' : 'user') as MemoryType,
      name: String(o.name ?? ''),
      content: String(o.content ?? ''),
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
      reason: typeof o.reason === 'string' ? o.reason : null,
      source: typeof o.source === 'string' ? o.source : null,
      createdAt: Number(o.createdAt ?? 0),
      updatedAt: Number(o.updatedAt ?? 0),
    };
  } catch {
    return null;
  }
}

// ── 内核方法 ────────────────────────────────────────────────────────────

export function open(ctx: StoreContext): void {
    try {
      // 延迟 require：Node < 22.5 没有 node:sqlite，静态 import 会在模块加载期
      // 崩掉整个宿主，这里兜底为内存存储。
      const require = createRequire(import.meta.url);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const dir = path.dirname(ctx.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      ctx.audit = loadAuditCrypto(ctx.storePath);
      const db = new DatabaseSync(ctx.storePath);
      // 「彻底删除」必须真的抹掉内容：secure_delete 让 SQLite 在释放页前清零，
      // 否则 DELETE 只是把页挂到 freelist，原文仍能从 .db 文件里恢复出来。
      db.exec('PRAGMA secure_delete = ON');
      db.exec(SCHEMA_SQL);
      // 旧库是在 secure_delete=0 下删过记录的，历史内容仍留在 freelist 页里。
      // 首次升级做一次 VACUUM 重写整库，user_version 记录迁移，避免每次启动都跑。
      const version = Number(
        (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
      );
      if (version < 1) {
        db.exec('VACUUM');
        db.exec('PRAGMA user_version = 1');
      }
      ctx.db = db;
      // M10-7.2：先加列/回填，再导入旧 JSON（导入 INSERT 已自带 dedupe_hash）。
      // 顺序反了会在「旧 DB 空表缺列 + memories.json」时导入失败漏数据。
      migrateDedupeHash(ctx, db);
      migrateAuditEncryption(ctx, db);
      migrateLegacyJson(ctx, db);
    } catch (e) {
      console.warn(
        '[memory] sqlite unavailable, degraded to in-memory store:',
        e instanceof Error ? e.message : String(e),
      );
      ctx.audit = loadAuditCrypto(ctx.storePath);
      ctx.db = null;
      ctx.fallback = [];
      loadLegacyJsonIntoFallback(ctx);
    }
  }

export function getDb(ctx: StoreContext): import('node:sqlite').DatabaseSync | null {
    return ctx.db;
  }

export function isInMemoryFallback(ctx: StoreContext): boolean {
    return ctx.db === null;
  }

export function migrateDedupeHash(_ctx: StoreContext, db: import('node:sqlite').DatabaseSync): void {
    try {
      const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'dedupe_hash')) {
        db.exec('ALTER TABLE memories ADD COLUMN dedupe_hash TEXT');
      }
      const rows = db.prepare('SELECT id, type, content FROM memories WHERE dedupe_hash IS NULL').all() as Array<{ id: string; type: string; content: string }>;
      const backfill = db.prepare('UPDATE memories SET dedupe_hash = ? WHERE id = ?');
      for (const row of rows) {
        backfill.run(dedupeHash(row.type, String(row.content ?? '')), row.id);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_dedupe ON memories(type, dedupe_hash)');
    } catch (e) {
      console.warn('[memory] dedupe_hash migration failed:', e instanceof Error ? e.message : String(e));
    }
  }

export function migrateAuditEncryption(ctx: StoreContext, db: import('node:sqlite').DatabaseSync): void {
    try {
      const rows = db
        .prepare('SELECT id, before_json, after_json, note FROM memory_log')
        .all() as Array<{
        id: number;
        before_json: string | null;
        after_json: string | null;
        note: string | null;
      }>;
      if (!rows.length) return;
      const upd = db.prepare('UPDATE memory_log SET before_json = ?, after_json = ?, note = ? WHERE id = ?');
      let changed = 0;
      for (const row of rows) {
        const seal = (v: string | null, asJson: boolean): string | null => {
          if (typeof v !== 'string' || !v) return v;
          if (v.startsWith(AUDIT_SEAL_PREFIX)) return v;
          let value: unknown = v;
          if (asJson) {
            try {
              value = JSON.parse(v);
            } catch {
              return v;
            }
          }
          return ctx.audit.seal(value);
        };
        const before = seal(row.before_json, true);
        const after = seal(row.after_json, true);
        const note = seal(row.note, false);
        if (before === row.before_json && after === row.after_json && note === row.note) continue;
        upd.run(before, after, note, row.id);
        changed += 1;
      }
      if (changed > 0) {
        db.exec('VACUUM');
        console.warn(`[memory] audit snapshots re-sealed: ${changed} row(s)`);
      }
    } catch (e) {
      console.warn(
        '[memory] audit encryption migration failed (non-fatal):',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

export function migrateLegacyJson(ctx: StoreContext, db: import('node:sqlite').DatabaseSync): void {
    const legacy = legacyJsonPath(ctx.storePath);
    if (legacy === ctx.storePath || !fs.existsSync(legacy)) return;
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get()?.n as number) ?? 0;
      if (count > 0) return;
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const ins = db.prepare(
        `INSERT OR REPLACE INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json, content_hash, dedupe_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          'import', null, '[]', contentHash(type, name, content), dedupeHash(type, content), null,
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

export function loadLegacyJsonIntoFallback(ctx: StoreContext): void {
    const legacy = legacyJsonPath(ctx.storePath);
    if (legacy === ctx.storePath || !fs.existsSync(legacy)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const raw of parsed) {
        if (!raw || typeof raw.id !== 'string') continue;
        ctx.fallback!.push({
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

export function close(ctx: StoreContext): void {
    if (ctx.db) {
      try {
        ctx.db.close();
      } catch {
        /* 忽略关闭异常 */
      }
      ctx.db = null;
    }
    ctx.fallback = null;
  }
