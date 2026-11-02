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
import { isAuditDecryptFailed } from '../audit-crypto';

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

/**
 * C1 墨鉴 BUG-013：**严格**版审计写入 —— 失败**抛错**，不再只 warn。
 *
 * 只在**事务内**使用（`storage.save` / `storage.remove`）。
 * 原实现 `recordLog` 内部自带 try/catch 只 warn → 事务里审计写失败被吞掉，
 * 事务照样 COMMIT → **主记录已改、审计缺失**的中间态，且无任何补偿。
 * 现在失败直接抛 → 调用方 ROLLBACK → 整笔不成（要么全成、要么全不成）。
 *
 * 事务**外**的行为不变（仍走宽松版 `recordLog`），不扩大影响面。
 */
export function recordLogStrict(ctx: StoreContext, op: string, memoryId: string | null, before: MemoryRow | null, after: MemoryRow | null, actor?: string | null, note?: string | null): void {
    const ts = Date.now();
    const beforeJson = before ? ctx.audit.seal(before) : null;
    const afterJson = after ? ctx.audit.seal(after) : null;
    const sealedNote = note ? ctx.audit.seal(note) : null;
    if (ctx.db) {
      // **不吞异常**：失败即抛出，由外层事务回滚。
      ctx.db
        .prepare(
          `INSERT INTO memory_log (ts, op, memory_id, actor, before_json, after_json, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ts, op, memoryId, actor ?? null, beforeJson, afterJson, sealedNote);
      return;
    }
    // 降级路径（内存数组）：push 不会失败，直接写。
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

/**
 * C1 墨鉴 BUG-013：严格版「彻底删除」—— 抹审计快照失败**抛错**。
 *
 * `forgetAudit`（宽松版）在事务外保持既有「非致命」语义；事务内用严格版，
 * 保证「彻底删除」要么全成（行删了 + 快照抹了 + 审计留痕），要么全不成。
 */
export function forgetAuditStrict(ctx: StoreContext, memoryId: string): void {
  if (!ctx.db) return;
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
        // C1 P0-1 / BUG-017：解密失败返回哨兵 → 显式标记，rollback 据此拒绝操作。
        const beforeRaw = ctx.audit.open(r.before_json);
        const afterRaw = ctx.audit.open(r.after_json);
        const beforeUndecryptable = isAuditDecryptFailed(beforeRaw);
        const afterUndecryptable = isAuditDecryptFailed(afterRaw);
        return {
          id: Number(r.id),
          ts: Number(r.ts ?? 0),
          op: String(r.op ?? ''),
          memoryId: typeof r.memory_id === 'string' ? r.memory_id : null,
          actor: typeof r.actor === 'string' ? r.actor : null,
          before: beforeUndecryptable ? null : parseSnapshot(beforeRaw),
          after: afterUndecryptable ? null : parseSnapshot(afterRaw),
          ...(beforeUndecryptable ? { beforeUndecryptable: true } : {}),
          ...(afterUndecryptable ? { afterUndecryptable: true } : {}),
          note:
            noteValue === null || noteValue === undefined || isAuditDecryptFailed(noteValue)
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

    // C1 P0-1 / BUG-017：**before 存在但解不开 → 必须拒绝，禁止走删除分支**。
    // 原实现：解密失败返回 null → `entry.before` 为 null → 落到 `deleteMemoryRow` 分支
    // → **本该恢复的操作变成静默删除**，还返回 `{ok:true}`，用户毫不知情。
    // 现在：显式拒绝并报错，数据原地不动。
    if (entry.beforeUndecryptable) {
      return {
        ok: false,
        error:
          'audit snapshot cannot be decrypted (key mismatch or corrupted ciphertext) — ' +
          'refusing to roll back because the previous state is unknown; the memory row was left untouched',
      };
    }

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
