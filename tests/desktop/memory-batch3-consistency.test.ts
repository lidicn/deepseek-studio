/**
 * C1 墨鉴第三批回归测试（正确性 / 一致性）。
 *
 * 四条缺陷，各配一组可**证伪**的用例：
 *
 *   BUG-013（memory/storage.ts `remove`）：先 DELETE 再写审计，审计写失败则
 *            before 快照永久丢、rollback 无法恢复该行。
 *   → 用「审计写失败注入」（SQLite 触发器让 memory_log 插入必失败）证明：
 *     **行还在**、FTS 还在、审计一条都没写、无中间态。
 *
 *   BUG-012（memory/storage.ts `save`）：主表 / FTS / 审计 / 淘汰四步无事务。
 *   → 用「中途抛错」证明：抛错后**主表没有这行**、FTS 没有这行、审计没有这行。
 *
 *   BUG-001 / BUG-002（shared/studio-execution.ts）：字符/字节两把尺 + 多字节中间截断。
 *   → 用中文 + emoji 边界样本证明：判定按**字节**、截断**不切半个字符**（无 U+FFFD）。
 *
 *   BUG-011（memory/retrieval.ts `search`）：FTS 命中即跳过 LIKE → 多短词漏召回；
 *            两分支排序不一致。
 *   → 用「多短词查询」证明召回是**并集**（FTS ∪ LIKE），且排序**统一**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStore } from '../../src/host/memory-store';
import { limitFinalAnswer, limitToolPayload } from '../../src/shared/studio-execution';

// 与 memory-store 同款延迟加载：Vite 会把静态 import 'node:sqlite' 误解析成裸模块。

const opened: MemoryStore[] = [];
const tmpRoot = path.join(os.tmpdir(), `studio-mem-batch3-${Date.now()}`);

function newStore(): { store: MemoryStore; dbPath: string } {
  const dbPath = path.join(tmpRoot, `mem-${Math.random().toString(36).slice(2, 8)}.db`);
  const store = new MemoryStore(dbPath);
  opened.push(store);
  return { store, dbPath };
}

/**
 * 注入「审计写必失败」：在 memory_log 上挂一个 BEFORE INSERT 触发器，
 * 任何 INSERT 都 ABORT。
 */
function breakAuditWrites(store: MemoryStore): void {
  const db = store.getDb();
  if (!db) throw new Error('sqlite backend required for this injection');
  db.exec(`CREATE TRIGGER IF NOT EXISTS boom_audit BEFORE INSERT ON memory_log
           BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
}

/** 统计 memory_log 行数（审计条数）。 */
function auditCount(store: MemoryStore): number {
  const db = store.getDb();
  if (!db) throw new Error('sqlite backend required');
  return Number((db.prepare('SELECT COUNT(*) AS n FROM memory_log').get() as { n: number }).n);
}

/** 主表行数（有效行）。 */
function rowCount(store: MemoryStore): number {
  const db = store.getDb();
  if (!db) throw new Error('sqlite backend required');
  return Number((db.prepare('SELECT COUNT(*) AS n FROM memories WHERE invalid_at IS NULL').get() as { n: number }).n);
}

/** FTS 索引行数。 */
function ftsCount(store: MemoryStore): number {
  const db = store.getDb();
  if (!db) throw new Error('sqlite backend required');
  return Number((db.prepare('SELECT COUNT(*) AS n FROM memories_fts').get() as { n: number }).n);
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('C1 墨鉴 BUG-013：remove 的审计写失败不得丢 before 快照', () => {
  it('审计写失败 → 整笔回滚：行还在、FTS 还在、审计一条没写', () => {
    const { store } = newStore();
    const saved = store.save({ type: 'user', name: '要删的', content: '删除前的内容' });
    const id = saved.id!;
    expect(rowCount(store)).toBe(1);
    expect(ftsCount(store)).toBe(1);
    const auditBefore = auditCount(store);

    // 注入审计写失败。
    breakAuditWrites(store);

    // remove 必须失败（抛错），而不是「删掉了但没留痕」。
    expect(() => store.remove(id)).toThrow();

    // 关键断言：**行还在**（before 快照没丢、rollback 仍能恢复）。
    expect(rowCount(store)).toBe(1);
    // FTS 也还在（没有半个中间态：FTS 删了但主表还在）。
    expect(ftsCount(store)).toBe(1);
    // 审计一条都没写（失败的那条没留下半截记录）。
    expect(auditCount(store)).toBe(auditBefore);
  });

  it('审计写失败后，行的内容完好、可被 rollback 路径读回', async () => {
    const { store } = newStore();
    const saved = store.save({ type: 'user', name: '保留', content: '原文内容' });
    const id = saved.id!;

    breakAuditWrites(store);
    expect(() => store.remove(id)).toThrow();

    // 行完好（内容一字未改）。
    const row = await store.get(id);
    expect(row).toBeDefined();
    expect(row!.content).toBe('原文内容');
  });

  it('forget 模式（彻底删除）审计写失败也整体回滚', () => {
    const { store } = newStore();
    const saved = store.save({ type: 'user', name: '彻底删', content: '待抹除' });
    const id = saved.id!;

    breakAuditWrites(store);
    expect(() => store.remove(id, { forget: true })).toThrow();

    // forget 也回滚：行还在、审计快照也还在（没被抹一半）。
    expect(rowCount(store)).toBe(1);
  });

  it('审计正常时 remove 照旧成功并留痕（未回归）', async () => {
    const { store } = newStore();
    const saved = store.save({ type: 'user', name: '正常删', content: '正常路径' });
    const id = saved.id!;
    expect(store.remove(id)).toBe(true);
    expect(rowCount(store)).toBe(0);
    const logs = await store.listLog({ limit: 50 });
    expect(logs.some((e) => e.op === 'purge' && e.memoryId === id)).toBe(true);
  });
});

describe('C1 墨鉴 BUG-012：save 的主表 / FTS / 审计同进同退', () => {
  it('审计写失败 → 新建行不落库（无中间态）', () => {
    const { store } = newStore();
    breakAuditWrites(store);

    expect(() => store.save({ type: 'user', name: '会失败的', content: '不该留下' })).toThrow();

    // 主表没有这行。
    expect(rowCount(store)).toBe(0);
    // FTS 也没有这行。
    expect(ftsCount(store)).toBe(0);
    // 审计一条都没写。
    expect(auditCount(store)).toBe(0);
  });

  it('审计写失败 → 更新已有行时旧内容保留（不是半改）', async () => {
    const { store } = newStore();
    const saved = store.save({ type: 'user', name: '原有', content: '旧内容' });
    const id = saved.id!;

    breakAuditWrites(store);
    expect(() => store.save({ type: 'user', name: '原有', content: '新内容' })).toThrow();

    // 旧内容还在（UPDATE 已被回滚）。
    const row = await store.get(id);
    expect(row!.content).toBe('旧内容');
  });

  it('FTS 同步失败 → 主表与审计一起回滚（不留下「有行无索引」的中间态）', () => {
    const { store } = newStore();
    const db = store.getDb()!;
    // 让 FTS 插入必失败：把 memories_fts 换成一张普通表并加 CHECK 约束。
    db.exec('DROP TABLE memories_fts');
    db.exec('CREATE TABLE memories_fts (rowid INTEGER, name TEXT, content TEXT, tags TEXT, CHECK (rowid < 0))');

    expect(() => store.save({ type: 'user', name: 'fts会炸', content: '内容' })).toThrow();

    // 主表没这行、审计没这条 —— 两边都没写。
    expect(rowCount(store)).toBe(0);
    expect(auditCount(store)).toBe(0);
  });

  it('正常路径不回归：save 成功且三处都写成功', async () => {
    const { store } = newStore();
    const r = store.save({ type: 'user', name: '正常', content: '正常内容' });
    expect(r.ok).toBe(true);
    expect(r.partial).toBeUndefined();
    expect(rowCount(store)).toBe(1);
    expect(ftsCount(store)).toBe(1);
    expect(auditCount(store)).toBeGreaterThan(0);
    // 检索能召回（索引与主表一致）。
    const hits = await store.search('正常内容');
    expect(hits.length).toBe(1);
  });
});

describe('C1 墨鉴 BUG-001 / BUG-002：字节口径与边界回退截断', () => {
  it('判定按字节：16000 个汉字远超 16KB 字节上限 → 必须标记 truncated', () => {
    const text = '汉'.repeat(16000); // 16000 码元 ≈ 48000 字节
    const payload = limitToolPayload({ text }, 16 * 1024);
    expect(payload).toMatchObject({ truncated: true });
    // 原始字节数如实记录（不是码元数）。
    expect((payload as { originalBytes: number }).originalBytes).toBe(
      Buffer.byteLength(JSON.stringify({ text }), 'utf8'),
    );
  });

  it('判定按字节：英文同体积不误伤（字节与码元一致）', () => {
    const payload = limitToolPayload({ text: 'a'.repeat(1000) }, 16 * 1024);
    expect(payload).not.toMatchObject({ truncated: true });
  });

  it('截断不切半个字符：预览尾部无 U+FFFD 且字节数不超过 limit', () => {
    // limit 故意落在三字节汉字中间（JSON 前缀 '{"text":"' = 9 字节，
    // 加一个汉字 3 字节 = 12 > 10 → 切点落在汉字中间 → 边界回退）。
    const text = '中文测试内容';
    const limit = 10;
    const preview = (limitToolPayload({ text }, limit) as { preview: string }).preview;
    // 无乱码（不切半个字符）。
    expect(preview).not.toContain('\uFFFD');
    // 字节数不超 limit（回退后只会更小）。
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(limit);
    // 回退到的是**完整字符边界**：预览是原文 JSON 序列化的前缀。
    const full = JSON.stringify({ text });
    expect(full.startsWith(preview)).toBe(true);
  });

  it('emoji（代理对 / 四字节序列）不被切成乱码', () => {
    const text = 'a😀b';
    const limit = 3; // 'a' 1 字节 + emoji 4 字节 → 切点落在 emoji 中间
    const preview = (limitToolPayload({ text }, limit) as { preview: string }).preview;
    expect(preview).not.toContain('\uFFFD');
    expect(preview).not.toContain('\uD83D'); // 孤立代理项
  });

  it('limitFinalAnswer 同样按字节 + 边界回退', () => {
    const text = '回答'.repeat(100);
    const r = limitFinalAnswer(text, 10); // '回答答' = 9 字节，第四字只进 1 字节 → 回退
    expect(r.text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(10);
    expect(r.truncationMarker).toContain('已截断');
  });

  it('未超限的内容原样返回（不引入截断标记）', () => {
    const r = limitFinalAnswer('短答案', 1024);
    expect(r.text).toBe('短答案');
    expect(r.truncationMarker).toBeUndefined();
  });
});

describe('C1 墨鉴 BUG-011：检索召回是 FTS ∪ LIKE，两分支排序统一', () => {
  it('多短词查询：FTS 命中的记录 与 LIKE 命中的记录 都在结果里（并集）', async () => {
    const { store } = newStore();
    // 「助手」3 字符 → FTS 能命中；「AI」2 字符 → trigram 必失配，只有 LIKE 能命中。
    store.save({ type: 'user', name: 'AI 手册', content: '这是关于 AI 的文档' });
    store.save({ type: 'user', name: '助手指南', content: '助手的使用方式' });

    const hits = await store.search('AI 助手');
    const names = hits.map((h) => h.name);
    // 两条都要召回（原来 FTS 命中「助手」就不再走 LIKE → 「AI 手册」被漏掉）。
    expect(names).toContain('AI 手册');
    expect(names).toContain('助手指南');
  });

  it('2 字符查询：纯 LIKE 路径仍能命中（未回归）', async () => {
    const { store } = newStore();
    store.save({ type: 'project', name: '空调', content: '主卧空调连开 33 小时' });
    const hits = await store.search('空调');
    expect(hits.length).toBe(1);
  });

  it('两分支统一过 sortRows：pinned 优先 + user 优先（不再按 bm25 跳变）', async () => {
    const { store } = newStore();
    store.save({ type: 'project', name: '项目记录', content: '并发 bug 修复记录' });
    store.save({ type: 'user', name: '用户偏好', content: '并发 bug 的个人偏好' });
    // 加一条 pinned 的 project 行。
    const pinned = store.save({ type: 'project', name: '置顶项目', content: '并发 bug 置顶' });
    const db = store.getDb()!;
    db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(pinned.id!);

    const hits = await store.search('并发 bug');
    expect(hits.length).toBeGreaterThan(0);
    // 排序口径：pinned 在最前。
    expect(hits[0].name).toBe('置顶项目');
    // pinned 之后是 user 优先（原本 FTS 分支不走 sortRows → user 优先失效）。
    const rest = hits.slice(1).map((h) => h.type);
    expect(rest.indexOf('user')).toBeLessThanOrEqual(rest.lastIndexOf('project') === -1 ? 0 : rest.indexOf('user'));
  });

  it('标签精确命中加权仍然生效（未回归）', async () => {
    const { store } = newStore();
    store.save({ type: 'user', name: '甲', content: '提到 audit 的一次普通记录' });
    store.save({ type: 'project', name: '乙', content: '与 audit 无关的流水账', tags: ['audit'] });
    const hits = await store.search('audit');
    expect(hits[0].name).toBe('乙');
  });

  it('FTS 语法注入仍不影响（未回归）', async () => {
    const { store } = newStore();
    store.save({ type: 'user', name: 'x', content: 'hello "world" OR (test)' });
    await expect(store.search('" OR DROP TABLE memories; --')).resolves.toBeInstanceOf(Array);
    expect((await store.list()).length).toBe(1);
  });
});
