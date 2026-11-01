/**
 * 记忆域 · candidates
 *
 * 由 src/host/memory-store.ts 机械拆分而来（MemoryStore 巨石重构，设计稿
 * docs/设计稿/MemoryStore-巨石文件重构-20261101.md）。
 * 搬运规则：方法体逐字搬运，仅两类改动——this. → ctx.，同域调用改为域内直接调用 foo(ctx, …)。
 * SQL 语义、表结构、加密前缀、公开导出名一律不变。
 */
import type { MemoryCandidate } from './types';
import type { StoreContext } from './types';
import { genId, isValidMemoryType, rowToCandidate } from './core';

// ── 域方法 ──────────────────────────────────────────────────────────────

export function addCandidate(ctx: StoreContext, input: {
    type: string;
    name: string;
    content: string;
    tags?: string[];
    reason?: string;
    source?: string;
  }): { ok: boolean; id?: string; error?: string } {
    if (!isValidMemoryType(input.type)) {
      return { ok: false, error: `invalid memory type: ${input.type} (expected 'user' or 'project')` };
    }
    if (!input.name || !input.content) {
      return { ok: false, error: 'name and content are required' };
    }
    const now = Date.now();
    const candidate: MemoryCandidate = {
      id: genId().replace(/^mem-/, 'cand-'),
      type: input.type,
      name: input.name,
      content: input.content,
      tags: input.tags ?? [],
      reason: input.reason ?? null,
      source: input.source ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (ctx.db) {
      ctx.db.prepare(
        `INSERT INTO memory_candidates
         (id, type, name, content, tags_json, reason, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.id, candidate.type, candidate.name, candidate.content,
        JSON.stringify(candidate.tags), candidate.reason, candidate.source, now, now,
      );
    } else {
      ctx.fallbackCandidates.push(candidate);
    }
    return { ok: true, id: candidate.id };
  }

export async function listCandidates(ctx: StoreContext): Promise<MemoryCandidate[]> {
    if (ctx.db) {
      const rows = ctx.db
        .prepare('SELECT * FROM memory_candidates ORDER BY created_at DESC')
        .all() as Record<string, unknown>[];
      return rows.map(rowToCandidate);
    }
    return [...ctx.fallbackCandidates]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({ ...c, tags: [...c.tags] }));
  }

export async function getCandidate(ctx: StoreContext, id: string): Promise<MemoryCandidate | undefined> {
    if (ctx.db) {
      const r = ctx.db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToCandidate(r) : undefined;
    }
    const c = ctx.fallbackCandidates.find((x) => x.id === id);
    return c ? { ...c, tags: [...c.tags] } : undefined;
  }

export async function promoteCandidate(ctx: StoreContext, id: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    const candidate = await getCandidate(ctx, id);
    if (!candidate) return { ok: false, error: 'candidate not found' };
    const res = ctx.save({
      type: candidate.type,
      name: candidate.name,
      content: candidate.content,
      tags: candidate.tags,
      source: candidate.source ?? 'candidate',
    });
    if (!res.ok || !res.id) return { ok: false, error: res.error ?? 'save failed' };
    deleteCandidateRow(ctx, id);
    ctx.recordLog('candidate-promote', res.id, null, ctx.snapshotById(res.id), null, JSON.stringify(candidate));
    return { ok: true, id: res.id };
  }

export async function rejectCandidate(ctx: StoreContext, id: string, note?: string): Promise<boolean> {
    const candidate = await getCandidate(ctx, id);
    if (!candidate) return false;
    deleteCandidateRow(ctx, id);
    ctx.recordLog(
      'candidate-reject',
      id,
      null,
      null,
      null,
      JSON.stringify({ ...candidate, __note: note ?? null }),
    );
    return true;
  }

export function deleteCandidateRow(ctx: StoreContext, id: string): void {
    if (ctx.db) {
      ctx.db.prepare('DELETE FROM memory_candidates WHERE id = ?').run(id);
      return;
    }
    const idx = ctx.fallbackCandidates.findIndex((c) => c.id === id);
    if (idx >= 0) ctx.fallbackCandidates.splice(idx, 1);
  }

export function insertCandidateRow(ctx: StoreContext, c: MemoryCandidate): void {
    if (ctx.db) {
      ctx.db.prepare(
        `INSERT OR REPLACE INTO memory_candidates
         (id, type, name, content, tags_json, reason, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c.id, c.type, c.name, c.content, JSON.stringify(c.tags),
        c.reason, c.source, c.createdAt, c.updatedAt,
      );
      return;
    }
    const idx = ctx.fallbackCandidates.findIndex((x) => x.id === c.id);
    if (idx >= 0) ctx.fallbackCandidates[idx] = { ...c, tags: [...c.tags] };
    else ctx.fallbackCandidates.push({ ...c, tags: [...c.tags] });
  }
