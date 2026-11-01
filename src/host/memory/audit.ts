/**
 * 记忆域 · audit
 *
 * 由 src/host/memory-store.ts 机械拆分而来（MemoryStore 巨石重构，设计稿
 * docs/设计稿/MemoryStore-巨石文件重构-20261101.md）。
 * 搬运规则：方法体逐字搬运，仅两类改动——this. → ctx.，同域调用改为域内直接调用 foo(ctx, …)。
 * SQL 语义、表结构、加密前缀、公开导出名一律不变。
 */
import type { MemoryLogEntry, MemoryRow } from './types';
import type { StoreContext } from './types';
import { parseCandidate, parseSnapshot, snapshotFingerprint, snapshotOf } from './core';

// ── 域方法 ──────────────────────────────────────────────────────────────

export function recordLog(ctx: StoreContext, op: string, memoryId: string | null, before: MemoryRow | null, after: MemoryRow | null, actor?: string | null, note?: string | null): void {
    const ts = Date.now();
    // 快照含正文明文 —— 一律加密落盘（.db 文件里只剩密文）。
    const beforeJson = before ? ctx.audit.seal(before) : null;
    const afterJson = after ? ctx.audit.seal(after) : null;
    const sealedNote = note ? ctx.audit.seal(note) : null;
    if (ctx.db) {
      try {
        ctx.db
          .prepare(
            `INSERT INTO memory_log (ts, op, memory_id, actor, before_json, after_json, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(ts, op, memoryId, actor ?? null, beforeJson, afterJson, sealedNote);
      } catch (e) {
        console.warn(
          '[memory] audit log write failed (non-fatal):',
          e instanceof Error ? e.message : String(e),
        );
      }
      return;
    }
    ctx.fallbackLog.push({
      id: ctx.fallbackLog.length + 1,
      ts,
      op,
      memoryId,
      actor: actor ?? null,
      before: before ? snapshotOf(before) : null,
      after: after ? snapshotOf(after) : null,
      note: note ?? null,
    });
  }

export async function listLog(ctx: StoreContext, opts?: { limit?: number; memoryId?: string }): Promise<MemoryLogEntry[]> {
    const limit = Math.max(1, opts?.limit ?? 50);
    let entries: MemoryLogEntry[];
    if (ctx.db) {
      const rows = (opts?.memoryId
        ? ctx.db
            .prepare('SELECT * FROM memory_log WHERE memory_id = ? ORDER BY id DESC LIMIT ?')
            .all(opts.memoryId, limit)
        : ctx.db.prepare('SELECT * FROM memory_log ORDER BY id DESC LIMIT ?').all(limit)) as Record<
        string,
        unknown
      >[];
      entries = rows.map((r) => {
        const noteValue = ctx.audit.open(r.note);
        return {
          id: Number(r.id),
          ts: Number(r.ts ?? 0),
          op: String(r.op ?? ''),
          memoryId: typeof r.memory_id === 'string' ? r.memory_id : null,
          actor: typeof r.actor === 'string' ? r.actor : null,
          before: parseSnapshot(ctx.audit.open(r.before_json)),
          after: parseSnapshot(ctx.audit.open(r.after_json)),
          note:
            noteValue === null || noteValue === undefined
              ? null
              : typeof noteValue === 'string'
                ? noteValue
                : JSON.stringify(noteValue),
        };
      });
    } else {
      entries = [...ctx.fallbackLog]
        .filter((e) => (opts?.memoryId ? e.memoryId === opts.memoryId : true))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    }
    return entries;
  }

export async function rollback(ctx: StoreContext, logId: number): Promise<{ ok: boolean; error?: string }> {
    const all = await listLog(ctx, { limit: 100000 });
    const entry = all.find((e) => e.id === logId);
    if (!entry) return { ok: false, error: 'log entry not found' };

    if (entry.op === 'candidate-promote') {
      if (entry.memoryId) ctx.deleteMemoryRow(entry.memoryId);
      const c = parseCandidate(entry.note);
      if (c) ctx.insertCandidateRow(c);
      recordLog(ctx, 'rollback', entry.memoryId, entry.after, entry.before, null, `rollback ${entry.id}`);
      return { ok: true };
    }
    if (entry.op === 'candidate-reject') {
      const c = parseCandidate(entry.note);
      if (c) ctx.insertCandidateRow(c);
      recordLog(ctx, 'rollback', entry.memoryId, null, null, null, `rollback ${entry.id}`);
      return { ok: true };
    }

    if (entry.before) {
      ctx.writeSnapshotRow(entry.before);
    } else if (entry.memoryId) {
      ctx.deleteMemoryRow(entry.memoryId);
    }
    recordLog(ctx, 'rollback', entry.memoryId, entry.after, entry.before, null, `rollback ${entry.id}`);
    return { ok: true };
  }

export function forgetAudit(ctx: StoreContext, memoryId: string): void {
    if (!ctx.db) return;
    try {
      const rows = ctx.db
        .prepare('SELECT id, before_json, after_json FROM memory_log WHERE memory_id = ?')
        .all(memoryId) as Array<{
        id: number;
        before_json: string | null;
        after_json: string | null;
      }>;
      const upd = ctx.db.prepare('UPDATE memory_log SET before_json = NULL, after_json = NULL, note = ? WHERE id = ?');
      for (const row of rows) {
        // snapshotFingerprint 自带 "sha256:" 前缀，这里不要再补一个。
        const fingerprint = `forgotten ${snapshotFingerprint(ctx.audit.open(row.before_json))}`;
        upd.run(fingerprint, row.id);
      }
    } catch (e) {
      console.warn(
        '[memory] forget audit failed (non-fatal):',
        e instanceof Error ? e.message : String(e),
      );
    }
  }
