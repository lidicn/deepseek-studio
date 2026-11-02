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
import { likePattern, rowToMemory, toFtsQueryFromTokens } from './core';
import { tokenizeRetrievalQuery } from './retrieval-tokens';

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
    // F5：查询分词口径。中文长句按空白切会粘成整段 → trigram 短语与 LIKE 都失配；
    // 现在统一走 retrieval-tokens 的口径（CJK bigram + 拉丁整段 + 引号点名短语），
    // FTS / LIKE / 无库降级三条分支**同源**（既有纪律：两分支必须同口径）。
    // 回退：`STUDIO_MEMORY_TOKENIZER=legacy` → 旧的空白切分口径。
    const tokens = tokenizeRetrievalQuery(q);
    if (ctx.db) {
      rows = [];
      // C1 墨鉴 BUG-011：FTS 与 LIKE 做**并集**，不再「FTS 有命中就跳过 LIKE」。
      //
      // 原实现：`if (rows.length === 0) { LIKE 兜底 }` —— 只要 FTS 命中 1 条就不再走 LIKE。
      // trigram 分词下 **2 字符 token 必然失配**（实测：`MATCH "AI"` / `MATCH "助手"` 均返回 0 行，
      // 而 `"会议纪"`（3 字符）命中），所以查询「AI 助手」时：
      //   - FTS 侧只有 3+ 字符 token 可能命中；
      //   - 纯靠「AI」匹配的记录**永远召不回来**（漏召回）。
      //
      // 现在：两分支**各自独立取数**（FTS 按 bm25，LIKE 取子串命中），
      // 按 id **去重合并**。取数上限从 limit*4 放宽到 limit*8，
      // 保证并集在截断前尽量完整（去重后仍可能超过 limit，最终统一排序后截断）。
      const cap = limit * 8;
      const seen = new Set<string>();
      // trigram 要求查询 >= 3 字符；不足走 LIKE（下方统一覆盖）
      if ([...q].length >= 3) {
        const fts = toFtsQueryFromTokens(tokens.fts);
        if (fts) {
          try {
            const found = ctx.db.prepare(
              `SELECT m.* FROM memories m
               JOIN memories_fts f ON f.rowid = m.rowid
               WHERE memories_fts MATCH ? AND m.invalid_at IS NULL
               ORDER BY bm25(memories_fts)
               LIMIT ?`,
            ).all(fts, cap) as Record<string, unknown>[];
            for (const r of found) {
              const row = rowToMemory(r);
              seen.add(row.id);
              rows.push(row);
            }
          } catch {
            // MATCH 语法异常 → 交给 LIKE 分支兜底（不影响并集）
          }
        }
      }
      // LIKE 分支**独立执行**（不再受 FTS 是否命中影响）。
      //
      // 口径对齐（重要）：FTS 侧 `toFtsQuery` 是 **token 级 OR**
      // （`"AI" OR "助手"`），所以 LIKE 侧也必须**按 token OR** 匹配，
      // 否则两分支语义不一致、并集仍然召不回：
      //   - 原口径 `%整句%`：查询「AI 助手」要求正文**连续**含「AI 助手」，
      //     而 trigram 下 FTS 又必然召不回 2 字符 token → **两个分支都召不回**。
      //   - 现在：按空白拆 token，任一 token 命中 name/content/tags 即召回
      //     （单 token 查询时与原口径等价）。
      // F5：token 来源改为检索分词器（CJK bigram / 拉丁整段 / 引号点名短语），
      // 与 FTS 侧同源；口径说明见 src/host/memory/retrieval-tokens.ts。
      const likeTokens = tokens.like;
      if (likeTokens.length > 0) {
        const pats = likeTokens.map((t) => likePattern(t));
        // 每个 token 一组三列占位符（name / content / tags_json），组间 OR。
        // 用模板字面量避免引号转义歧义（ESCAPE '\' 里的反斜杠）。
        const oneToken = `(name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\')`;
        const orClauses = likeTokens.map(() => oneToken).join(' OR ');
        const likeFound = ctx.db.prepare(
          `SELECT * FROM memories
         WHERE invalid_at IS NULL AND (${orClauses})
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ?`,
        ).all(...pats.flatMap((p) => [p, p, p]), cap) as Record<string, unknown>[];
        for (const r of likeFound) {
          const row = rowToMemory(r);
          if (seen.has(row.id)) continue; // 已由 FTS 命中 → 去重
          seen.add(row.id);
          rows.push(row);
        }
      }
    } else {
      // 降级路径同样按 **token OR** 匹配（与 SQL 分支口径一致，F5：同一份分词结果）。
      const needles = tokens.like.map((t) => t.toLowerCase());
      rows = ctx.fallback!.filter(
        (m) => m.invalidAt === null &&
          needles.some((needle) =>
            m.name.toLowerCase().includes(needle) ||
            m.content.toLowerCase().includes(needle) ||
            m.tags.some((t) => t.toLowerCase().includes(needle))),
      );
      rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
    }

    // C1 墨鉴 BUG-011：两条分支排序语义不一致（原 FTS 分支走 bm25、LIKE 分支走
    // pinned/updated_at，且 FTS 分支**不经过 sortRows** → pinned / user 优先策略失效）。
    // 现在：**统一过 sortRows**（pinned → user 优先 → updated_at 倒序），
    // 标签精确命中加权放在其后，作为同等稳定的次级排序。
    rows = sortRows(ctx, rows);

    // 标签精确命中加权（稳定排序：精确标签 → 置顶 → 原相关序）
    const needle = q.toLowerCase();
    const tagged = new Set(rows.filter((m) => m.tags.some((t) => t.toLowerCase() === needle)).map((m) => m.id));
    if (tagged.size > 0) {
      rows = [
        ...rows.filter((m) => tagged.has(m.id)),
        ...rows.filter((m) => !tagged.has(m.id)),
      ];
    }
    // F5：显式点名片段（「…」等）命中的行，在**非置顶组内**排到最前。
    //
    // 为什么需要这一步：用户显式点名了某条记忆，它必须真的进到注入窗口
    // （memory.select 只取 related 的前 12 条，见 desktop-host.ts:821 的 limit: 12）。
    // 只靠"能被 LIKE/FTS 命中"不够——命中之后还要经过 sortRows（pinned→user→updated_at），
    // 一条较老的点名记忆可能被挤出窗口（这正是真机读数里"点名了却没被注入"的另一半原因）。
    //
    // 边界：**置顶组不动**（pinned 契约不改），组内其余顺序也不改；
    // 没有引号片段时本段完全不执行 → 既有排序断言零影响。
    if (tokens.quoted.length > 0) {
      const phrases = tokens.quoted.map((p) => p.toLowerCase());
      const isNamed = (m: MemoryRow): boolean =>
        phrases.some((p) =>
          m.name.toLowerCase().includes(p) ||
          m.content.toLowerCase().includes(p) ||
          m.tags.some((t) => t.toLowerCase().includes(p)),
        );
      const pinnedRows = rows.filter((m) => m.pinned);
      const rest = rows.filter((m) => !m.pinned);
      rows = [...pinnedRows, ...rest.filter(isNamed), ...rest.filter((m) => !isNamed(m))];
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
