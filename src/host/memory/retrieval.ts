/**
 * 记忆域 · retrieval
 *
 * 由 src/host/memory-store.ts 机械拆分而来（MemoryStore 巨石重构，设计稿
 * docs/设计稿/MemoryStore-巨石文件重构-20261101.md）。
 * 搬运规则：方法体逐字搬运，仅两类改动——this. → ctx.，同域调用改为域内直接调用 foo(ctx, …)。
 * SQL 语义、表结构、加密前缀、公开导出名一律不变。
 */
import type { MemoryRow } from './types';
import type { StoreContext } from './types';
import type { Memory } from '../bot/types';
import { MEMORY_INJECT_LIMIT, formatMemoryLine, selectMemoryInjectRows } from '../../inject/untrusted-memory';
import { likePattern, rowToMemory, toFtsQuery } from './core';

// ── 域方法 ──────────────────────────────────────────────────────────────

export async function list(ctx: StoreContext): Promise<Memory[]> {
    return sortRows(ctx, validRows(ctx));
  }

export async function search(ctx: StoreContext, query: string, opts?: { personaTag?: string; limit?: number }): Promise<Memory[]> {
    const q = (query ?? '').trim();
    const limit = Math.max(1, opts?.limit ?? 20);
    if (!q) {
      return sortRows(ctx, applyPersonaFilter(ctx, validRows(ctx), opts?.personaTag)).slice(0, limit);
    }

    let rows: MemoryRow[];
    if (ctx.db) {
      rows = [];
      // trigram 要求查询 >= 3 字符；不足走 LIKE
      if ([...q].length >= 3) {
        const fts = toFtsQuery(q);
        if (fts) {
          try {
            const found = ctx.db.prepare(
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
        const found = ctx.db.prepare(
          `SELECT * FROM memories
           WHERE invalid_at IS NULL AND (name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        ).all(pat, pat, pat, limit * 4) as Record<string, unknown>[];
        rows = found.map(rowToMemory);
      }
    } else {
      const needle = q.toLowerCase();
      rows = ctx.fallback!.filter(
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
    return applyPersonaFilter(ctx, rows, opts?.personaTag).slice(0, limit);
  }

export async function listByPersona(ctx: StoreContext, tag: string): Promise<Memory[]> {
    const rows = validRows(ctx).filter((m) => m.personaTags.includes(tag));
    return sortRows(ctx, rows);
  }

export function formatForPrompt(_ctx: StoreContext, memories: readonly Memory[], limit = MEMORY_INJECT_LIMIT): string {
    const selected = selectMemoryInjectRows(memories, { rowLimit: limit });
    if (selected.length === 0) return '';
    return selected.map(formatMemoryLine).join('\n');
  }

export async function get(ctx: StoreContext, id: string): Promise<MemoryRow | undefined> {
    if (ctx.db) {
      const r = ctx.db.prepare('SELECT * FROM memories WHERE id = ? AND invalid_at IS NULL').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToMemory(r) : undefined;
    }
    const m = ctx.fallback!.find((x) => x.id === id && x.invalidAt === null);
    return m ? { ...m } : undefined;
  }

export async function listInvalidated(ctx: StoreContext): Promise<MemoryRow[]> {
    const rows = allRows(ctx).filter((m) => m.invalidAt !== null);
    return rows.sort((a, b) => (b.invalidAt ?? 0) - (a.invalidAt ?? 0));
  }

export function stats(ctx: StoreContext): { backend: 'sqlite' | 'memory'; total: number; valid: number; invalidated: number; storePath: string } {
    const all = allRows(ctx);
    return {
      backend: ctx.db ? 'sqlite' : 'memory',
      total: all.length,
      valid: all.filter((m) => m.invalidAt === null).length,
      invalidated: all.filter((m) => m.invalidAt !== null).length,
      storePath: ctx.storePath,
    };
  }

export function allRows(ctx: StoreContext): MemoryRow[] {
    if (ctx.db) {
      const found = ctx.db.prepare('SELECT * FROM memories').all() as Record<string, unknown>[];
      return found.map(rowToMemory);
    }
    return ctx.fallback ? ctx.fallback.map((m) => ({ ...m })) : [];
  }

export function validRows(ctx: StoreContext): MemoryRow[] {
    return allRows(ctx).filter((m) => m.invalidAt === null);
  }

export function sortRows(_ctx: StoreContext, rows: MemoryRow[]): MemoryRow[] {
    return [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      // M10-7a：第二级是「个人记忆优先」——否则新写入的 project 记忆会把
      // user 档（身份/偏好）挤出注入窗口。
      if (a.type !== b.type) return a.type === 'user' ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

export function applyPersonaFilter(_ctx: StoreContext, rows: MemoryRow[], personaTag?: string): MemoryRow[] {
    if (!personaTag) return rows;
    return rows.filter((m) => m.personaTags.includes(personaTag));
  }
