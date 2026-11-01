/**
 * 记忆域 · storage
 *
 * 由 src/host/memory-store.ts 机械拆分而来（MemoryStore 巨石重构，设计稿
 * docs/设计稿/MemoryStore-巨石文件重构-20261101.md）。
 * 搬运规则：方法体逐字搬运，仅两类改动——this. → ctx.，同域调用改为域内直接调用 foo(ctx, …)。
 * SQL 语义、表结构、加密前缀、公开导出名一律不变。
 */
import type { ExistingGovernanceFields, MemoryRow, MemorySaveWarning, MemoryType, SaveMemoryParams, SaveMemoryResult } from './types';
import type { StoreContext } from './types';
import { MAX_MEMORIES } from './types';
import { mergeUpdateGovernance } from '../memory-store';
import { contentHash, dedupeHash, genId, isValidMemoryType, parseJsonArray, pickEviction, rowToMemory, sameStringArray, sha256Hex, snapshotFingerprint, snapshotOf } from './core';

// ── 域方法 ──────────────────────────────────────────────────────────────

export function save(ctx: StoreContext, params: SaveMemoryParams): SaveMemoryResult {
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
    // M10-7.2：名称无关去重指纹（同名之外，跨名同内容也靠它命中既有行）。
    const dedupe = dedupeHash(params.type, params.content);

    if (ctx.db) {
      // M10-5：同名行分「有效 / 已失效」两种命中。有效 → 原地更新；已失效 → 复活原行
      // （invalid_at 归零）而不是另起一行有效记录，否则账本会出现「作废 + 同名有效」
      // 两行、stats().total 单调顶高，而面板因为只看 list() 看不出重复。
      // 排序取「有效优先，其次最近更新」，两条命中共用下面同一段 UPDATE。
      const existing = ctx.db
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
        const existingGov: ExistingGovernanceFields = {
          pinned: existing.pinned === 1,
          tags: parseJsonArray(existing.tags_json),
          personaTags: parseJsonArray(existing.persona_tags_json),
          source: typeof existing.source === 'string' ? existing.source : undefined,
          confidence: typeof existing.confidence === 'number' ? existing.confidence : undefined,
        };
        // M10-7.1：未传治理字段保留原值，显式传值（含 false/[]）才覆盖。
        const merged = mergeUpdateGovernance(existingGov, params);
        // 无变化判断必须覆盖全部治理字段：内容或任一治理字段有变都要落库；
        // 只比 contentHash+tags 会吞掉“同内容、仅改 pinned/personaTags/source/confidence”的更新。
        const unchanged =
          valid &&
          existingHash === hash &&
          merged.pinned === existingGov.pinned &&
          sameStringArray(merged.tags, existingGov.tags) &&
          sameStringArray(merged.personaTags, existingGov.personaTags) &&
          (merged.source ?? undefined) === existingGov.source &&
          (merged.confidence ?? undefined) === existingGov.confidence;
        if (unchanged) {
          return { ok: true, id: String(existing.id) }; // 无变化，不搅动 updatedAt
        }
        // M10-7.3 P1-1：归档行复活 delta=1，须先做容量预算；全 pinned 时拒绝，归档行保持 invalid。
        const deltaValid: 0 | 1 = valid ? 0 : 1;
        const budget = prepareEviction(ctx, deltaValid);
        if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-archive-at-capacity-all-pinned' };
        const rid = existing.rid as number;
        const beforeRow = rowToMemory(existing);
        ctx.db.prepare(
          `UPDATE memories SET content = ?, tags_json = ?, pinned = ?, source = ?, confidence = ?,
           persona_tags_json = ?, content_hash = ?, dedupe_hash = ?, invalid_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(
          params.content, JSON.stringify(merged.tags), merged.pinned ? 1 : 0,
          merged.source ?? null, merged.confidence ?? null, JSON.stringify(merged.personaTags), hash, dedupe, now,
          String(existing.id),
        );
        // M10-10：审计埋点（记录变更前后完整行快照，可按日志回滚）。
        ctx.recordLog('save', String(existing.id), beforeRow, snapshotById(ctx, String(existing.id)));
        // C1-F2：FTS 同步 + 容量淘汰（附属失败收集为 warnings，不阻断主保存）。
        const ftsWarn = syncFts(ctx, rid, params.name, params.content, merged.tags);
        const evictWarn = applyEviction(ctx, budget.evict, now);
        const warnings = [...ftsWarn, ...evictWarn];
        return warnings.length > 0
          ? { ok: true, id: String(existing.id), partial: true, warnings }
          : { ok: true, id: String(existing.id) };
      }

      // M10-7.2：同名未命中 → 同 type + dedupe_hash 跨名去重。有效行优先、否则最近更新；
      // 不改原 name（跨名去重保留首个名称），content_hash 用原 name 重算以保留旧语义。
      const cross = ctx.db
        .prepare(
          `SELECT rowid AS rid, * FROM memories
           WHERE type = ? AND dedupe_hash = ?
           ORDER BY (invalid_at IS NULL) DESC, updated_at DESC
           LIMIT 1`,
        )
        .get(params.type, dedupe) as Record<string, unknown> | undefined;
      if (cross) {
        const crossId = String(cross.id);
        const valid = cross.invalid_at === null || cross.invalid_at === undefined;
        const crossName = String(cross.name);
        const crossHash = contentHash(params.type, crossName, params.content);
        const crossGov: ExistingGovernanceFields = {
          pinned: cross.pinned === 1,
          tags: parseJsonArray(cross.tags_json),
          personaTags: parseJsonArray(cross.persona_tags_json),
          source: typeof cross.source === 'string' ? cross.source : undefined,
          confidence: typeof cross.confidence === 'number' ? cross.confidence : undefined,
        };
        const merged = mergeUpdateGovernance(crossGov, params);
        // 跨名同内容时若治理字段也未变 → no-op，直接复用既有 id，不搅动 updatedAt。
        const unchanged =
          valid &&
          merged.pinned === crossGov.pinned &&
          sameStringArray(merged.tags, crossGov.tags) &&
          sameStringArray(merged.personaTags, crossGov.personaTags) &&
          (merged.source ?? undefined) === crossGov.source &&
          (merged.confidence ?? undefined) === crossGov.confidence;
        if (unchanged) {
          return { ok: true, id: crossId };
        }
        // M10-7.3 P1-1：跨名归档行复活 delta=1，须先做容量预算。
        const deltaValid: 0 | 1 = valid ? 0 : 1;
        const budget = prepareEviction(ctx, deltaValid);
        if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-cross-at-capacity-all-pinned' };
        const rid = cross.rid as number;
        const crossBefore = rowToMemory(cross);
        ctx.db.prepare(
          `UPDATE memories SET content = ?, tags_json = ?, pinned = ?, source = ?, confidence = ?,
           persona_tags_json = ?, content_hash = ?, dedupe_hash = ?, invalid_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(
          params.content, JSON.stringify(merged.tags), merged.pinned ? 1 : 0,
          merged.source ?? null, merged.confidence ?? null, JSON.stringify(merged.personaTags),
          crossHash, dedupe, now, crossId,
        );
        // M10-10：审计埋点（跨名去重命中同样留痕）。
        ctx.recordLog('save', crossId, crossBefore, snapshotById(ctx, crossId));
        // C1-F2：name 保留原值，FTS 仍按原 name 索引；同步降级处理防 rowid 冲突。
        const ftsWarn = syncFts(ctx, rid, crossName, params.content, merged.tags);
        const evictWarn = applyEviction(ctx, budget.evict, now);
        const warnings = [...ftsWarn, ...evictWarn];
        return warnings.length > 0
          ? { ok: true, id: crossId, partial: true, warnings }
          : { ok: true, id: crossId };
      }

      // M10-7.3：写前容量预算。全 pinned 无法腾容量时拒绝本次写入，不落地、不部分改动。
      const budget = prepareEviction(ctx, 1);
      if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'valid-memories-at-capacity-and-all-pinned' };
      const id = genId();
      ctx.db.prepare(
        `INSERT INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json, content_hash, dedupe_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, params.type, params.name, params.content, JSON.stringify(tags), (params.pinned ?? false) ? 1 : 0,
        params.source ?? null, params.confidence ?? null, JSON.stringify(personaTags), hash, dedupe, null, now, now,
      );
      const rid = (ctx.db.prepare('SELECT last_insert_rowid() AS rid').get()?.rid as number) ?? 0;
      // M10-10：新建（before = null）与更新区分开，rollback 据此决定「删行」还是「回写」。
      ctx.recordLog('save', id, null, snapshotById(ctx, id));
      // C1-F2：FTS 同步 + 容量淘汰（附属失败收集为 warnings，不阻断主保存）。
      const ftsWarn = syncFts(ctx, rid, params.name, params.content, tags);
      const evictWarn = applyEviction(ctx, budget.evict, now);
      const warnings = [...ftsWarn, ...evictWarn];
      return warnings.length > 0
        ? { ok: true, id, partial: true, warnings }
        : { ok: true, id };
    }

    // 降级路径：内存数组
    const sameName = ctx.fallback!.filter(
      (m) => m.type === params.type && m.name.toLowerCase() === params.name.toLowerCase(),
    );
    // M10-5：同 SQL 路径——有效行优先，否则复活最近一条同名作废行。
    const target = sameName.find((m) => m.invalidAt === null) ?? sameName[sameName.length - 1];
    if (target) {
      // M10-7.1：与 SQL 路径同一合并语义——未传治理字段保留原值。
      const merged = mergeUpdateGovernance(target, params);
      // 与 SQL 对齐的 true no-op：行仍有效、content 与全部治理字段均未变 → 直接返回，不改 updatedAt。
      // 内容口径必须与 SQL 一致：走规范化 contentHash（压缩连续空白），不用精确字符串比较。
      const unchanged =
        target.invalidAt === null &&
        contentHash(target.type, target.name, target.content) === hash &&
        merged.pinned === target.pinned &&
        sameStringArray(merged.tags, target.tags) &&
        sameStringArray(merged.personaTags, target.personaTags) &&
        (merged.source ?? undefined) === target.source &&
        (merged.confidence ?? undefined) === target.confidence;
      if (unchanged) {
        return { ok: true, id: target.id };
      }
      // M10-7.3 P1-1：fallback 同名归档行复活 delta=1，须先做容量预算。
      const deltaValid: 0 | 1 = target.invalidAt === null ? 0 : 1;
      const budget = prepareEviction(ctx, deltaValid);
      if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-archive-at-capacity-all-pinned' };
      const idx = ctx.fallback!.indexOf(target);
      const fbBefore = snapshotOf(target);
      ctx.fallback![idx] = {
        ...target, content: params.content, tags: merged.tags, pinned: merged.pinned,
        source: merged.source, confidence: merged.confidence, personaTags: merged.personaTags,
        invalidAt: null, updatedAt: now,
      } as MemoryRow;
      // M10-10：降级路径同样留痕。
      ctx.recordLog('save', target.id, fbBefore, snapshotById(ctx, target.id));
      const evictWarn = applyEviction(ctx, budget.evict, now);
      return evictWarn.length > 0
        ? { ok: true, id: target.id, partial: true, warnings: evictWarn }
        : { ok: true, id: target.id };
    }

    // M10-7.2：同名未命中 → 同 type + dedupeHash 跨名去重。有效行优先、否则最近更新。
    const sameDedupe = ctx.fallback!.filter(
      (m) => m.type === params.type && dedupeHash(m.type, m.content) === dedupe,
    );
    const crossTarget =
      sameDedupe.find((m) => m.invalidAt === null) ??
      [...sameDedupe].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (crossTarget) {
      const merged = mergeUpdateGovernance(crossTarget, params);
      const unchanged =
        crossTarget.invalidAt === null &&
        merged.pinned === crossTarget.pinned &&
        sameStringArray(merged.tags, crossTarget.tags) &&
        sameStringArray(merged.personaTags, crossTarget.personaTags) &&
        (merged.source ?? undefined) === crossTarget.source &&
        (merged.confidence ?? undefined) === crossTarget.confidence;
      if (unchanged) {
        return { ok: true, id: crossTarget.id };
      }
      // M10-7.3 P1-1：fallback 跨名归档行复活 delta=1，须先做容量预算。
      const deltaValid: 0 | 1 = crossTarget.invalidAt === null ? 0 : 1;
      const budget = prepareEviction(ctx, deltaValid);
      if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'resurrect-cross-at-capacity-all-pinned' };
      const idx = ctx.fallback!.indexOf(crossTarget);
      const fbCrossBefore = snapshotOf(crossTarget);
      ctx.fallback![idx] = {
        ...crossTarget, content: params.content, tags: merged.tags, pinned: merged.pinned,
        source: merged.source, confidence: merged.confidence, personaTags: merged.personaTags,
        invalidAt: null, updatedAt: now,
      } as MemoryRow;
      // M10-10：降级路径同样留痕。
      ctx.recordLog('save', crossTarget.id, fbCrossBefore, snapshotById(ctx, crossTarget.id));
      const evictWarn = applyEviction(ctx, budget.evict, now);
      return evictWarn.length > 0
        ? { ok: true, id: crossTarget.id, partial: true, warnings: evictWarn }
        : { ok: true, id: crossTarget.id };
    }

    // M10-7.3：写前容量预算，与 SQL 路径同一淘汰排序语义。全 pinned 无法腾容量则拒绝。
    const budget = prepareEviction(ctx, 1);
    if (!budget.ok) return { ok: false, error: 'memory-capacity', reason: 'valid-memories-at-capacity-and-all-pinned' };
    const id = genId();
    ctx.fallback!.push({
      id, type: params.type as MemoryType, name: params.name, content: params.content, tags,
      pinned: params.pinned ?? false, source: params.source, confidence: params.confidence,
      personaTags, invalidAt: null, createdAt: now, updatedAt: now,
    } as MemoryRow);
    // M10-10：降级路径新建留痕。
    ctx.recordLog('save', id, null, snapshotById(ctx, id));
    const evictWarn = applyEviction(ctx, budget.evict, now);
    return evictWarn.length > 0
      ? { ok: true, id, partial: true, warnings: evictWarn }
      : { ok: true, id };
  }

export function remove(ctx: StoreContext, id: string, opts?: { forget?: boolean }): boolean {
    if (ctx.db) {
      // 必须取整行：审计快照（M10-10）要靠这一行的 name/content 等字段，
      // 只 SELECT rowid 会让 purge 的 before 快照变成空行，rollback 写回后内容全丢。
      const row = ctx.db.prepare('SELECT *, rowid AS rid FROM memories WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return false;
      const before = rowToMemory(row);
      ctx.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rid as number);
      ctx.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      if (opts?.forget) {
        // 连审计快照一起抹掉：只留指纹，不可回滚。
        ctx.forgetAudit(id);
        ctx.recordLog('purge', id, null, null, null, `forgotten ${snapshotFingerprint(before)}`);
      } else {
        // M10-10：彻底删除留痕，rollback 可据快照还原该行。
        ctx.recordLog('purge', id, before, null);
      }
      return true;
    }
    const idx = ctx.fallback!.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    const before = snapshotOf(ctx.fallback![idx]);
    ctx.fallback!.splice(idx, 1);
    if (opts?.forget) {
      ctx.fallbackLog = ctx.fallbackLog.map((e) =>
        e.memoryId === id
          ? { ...e, before: null, after: null, note: `forgotten sha256:${sha256Hex(before.content)}` }
          : e,
      );
      ctx.recordLog('purge', id, null, null, null, `forgotten sha256:${sha256Hex(before.content)}`);
    } else {
      // M10-10：彻底删除留痕（降级路径）。
      ctx.recordLog('purge', id, before, null);
    }
    return true;
  }

export function compact(ctx: StoreContext): void {
    if (!ctx.db) return;
    try {
      ctx.db.exec('VACUUM');
    } catch (e) {
      console.warn('[memory] vacuum failed:', e instanceof Error ? e.message : String(e));
    }
  }

export async function invalidate(ctx: StoreContext, id: string): Promise<void> {
    const now = Date.now();
    if (ctx.db) {
      const before = snapshotById(ctx, id);
      ctx.db.prepare('UPDATE memories SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(now, now, id);
      // M10-10：归档留痕（软归档，rollback 可复活）。
      if (before) ctx.recordLog('archive', id, before, snapshotById(ctx, id));
      return;
    }
    const m = ctx.fallback!.find((x) => x.id === id);
    if (m && m.invalidAt === null) {
      const before = snapshotOf(m);
      (m as { invalidAt: number | null }).invalidAt = now;
      (m as { updatedAt: number }).updatedAt = now;
      // M10-10：归档留痕（降级路径）。
      ctx.recordLog('archive', id, before, snapshotById(ctx, id));
    }
  }

export async function restore(ctx: StoreContext, id: string): Promise<void> {
    const now = Date.now();
    if (ctx.db) {
      const before = snapshotById(ctx, id);
      ctx.db.prepare('UPDATE memories SET invalid_at = NULL, updated_at = ? WHERE id = ? AND invalid_at IS NOT NULL')
        .run(now, id);
      // M10-10：复活留痕。
      if (before) ctx.recordLog('restore', id, before, snapshotById(ctx, id));
      return;
    }
    const m = ctx.fallback!.find((x) => x.id === id);
    if (m && m.invalidAt !== null) {
      const before = snapshotOf(m);
      (m as { invalidAt: number | null }).invalidAt = null;
      (m as { updatedAt: number }).updatedAt = now;
      // M10-10：复活留痕（降级路径）。
      ctx.recordLog('restore', id, before, snapshotById(ctx, id));
    }
  }

export function snapshotById(ctx: StoreContext, id: string): MemoryRow | null {
    if (ctx.db) {
      const r = ctx.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return r ? rowToMemory(r) : null;
    }
    const m = ctx.fallback?.find((x) => x.id === id);
    return m ? snapshotOf(m) : null;
  }

export function deleteMemoryRow(ctx: StoreContext, id: string): void {
    if (ctx.db) {
      const row = ctx.db.prepare('SELECT rowid AS rid FROM memories WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (row) ctx.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(row.rid as number);
      ctx.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return;
    }
    if (!ctx.fallback) return;
    const idx = ctx.fallback.findIndex((m) => m.id === id);
    if (idx >= 0) ctx.fallback.splice(idx, 1);
  }

export function writeSnapshotRow(ctx: StoreContext, row: MemoryRow): void {
    if (ctx.db) {
      const hash = contentHash(row.type, row.name, row.content);
      const dedupe = dedupeHash(row.type, row.content);
      ctx.db.prepare(
        `INSERT OR REPLACE INTO memories
         (id, type, name, content, tags_json, pinned, source, confidence, persona_tags_json,
          content_hash, dedupe_hash, invalid_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id, row.type, row.name, row.content, JSON.stringify(row.tags), row.pinned ? 1 : 0,
        row.source ?? null, row.confidence ?? null, JSON.stringify(row.personaTags),
        hash, dedupe, row.invalidAt ?? null, row.createdAt, row.updatedAt,
      );
      const rid = (ctx.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(row.id)?.rowid as number) ?? 0;
      try {
        ctx.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rid);
        ctx.db
          .prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)')
          .run(rid, row.name, row.content, row.tags.join(' '));
      } catch {
        /* FTS 失败不影响主记录 */
      }
      return;
    }
    if (!ctx.fallback) return;
    const idx = ctx.fallback.findIndex((m) => m.id === row.id);
    const snap = snapshotOf(row);
    if (idx >= 0) ctx.fallback[idx] = snap;
    else ctx.fallback.push(snap);
  }

export function prepareEviction(ctx: StoreContext, deltaValid: 0 | 1): { ok: true; evict: MemoryRow[] } | { ok: false } {
    if (deltaValid === 0) return { ok: true, evict: [] };
      const valid = ctx.validRows();
      const projected = valid.length + deltaValid;
      if (projected <= MAX_MEMORIES) return { ok: true, evict: [] };
      const need = projected - MAX_MEMORIES;
      const evict = pickEviction(valid, need);
      if (!evict) return { ok: false };
      return { ok: true, evict };
  }

export function applyEviction(ctx: StoreContext, evict: MemoryRow[], now: number): MemorySaveWarning[] {
    if (evict.length === 0) return [];
    const warnings: MemorySaveWarning[] = [];
    if (ctx.db) {
      const upd = ctx.db.prepare(
        'UPDATE memories SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL',
      );
      for (const r of evict) {
        try {
          upd.run(now, now, r.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn('[memory] eviction failed (non-fatal, main record intact):', msg);
          warnings.push({ code: 'eviction-failed', message: '容量淘汰软归档失败', detail: `${r.id}: ${msg}` });
        }
      }
    } else if (ctx.fallback) {
      for (const r of evict) {
        const idx = ctx.fallback.findIndex((m) => m.id === r.id);
        if (idx >= 0) {
          const old = ctx.fallback[idx];
          ctx.fallback[idx] = { ...old, invalidAt: now, updatedAt: now };
        }
      }
    }
    return warnings;
  }

export function syncFts(ctx: StoreContext, rid: number, name: string, content: string, tags: string[]): MemorySaveWarning[] {
    if (!ctx.db) return [];
    try {
      ctx.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(rid);
      ctx.db.prepare('INSERT INTO memories_fts(rowid, name, content, tags) VALUES (?, ?, ?, ?)')
        .run(rid, name, content, tags.join(' '));
      return [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[memory] FTS sync failed (non-fatal, main record intact):', msg);
      return [{ code: 'fts-sync-failed', message: 'FTS 全文索引同步失败', detail: msg }];
    }
  }
