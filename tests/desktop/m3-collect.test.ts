// @vitest-environment node
/**
 * M3-2 采集流水线回归断言（只读采集 + 每日分布 + 样本不足纪律）。
 *
 * 守四件事，任何一条被改坏都必须红：
 *   ① 采集**只读**：源 trace 文件跑完前后字节完全一致（sha256 + mtime 不变）；
 *   ② 归档**逐字节一致**：副本与原文件 sha256 相同，且命名是 `YYYY-MM-DD`；
 *   ③ **断档必可见**：连续日期缺一天时，manifest 的 `gaps` 必须点名那一天（不许补零、不许静默）；
 *   ④ **样本不足必须明说**：任务数 < 阈值时报告里必须出现「样本不足」，且不许编出结论。
 *
 * 负控：把 collectAll 的 gaps 计算换成 `return []`，用例 ③ 必红；
 *       把 renderDailyMarkdown 的「样本不足」块删掉，用例 ④ 必红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  collectAll,
  dateRange,
  findGaps,
  isSampleSufficient,
  renderDailyMarkdown,
  renderTotalsMarkdown,
  retryTotalsLine,
} from '../../tools/metrics/m3-collect';

function sha(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 造一份极小的 trace：两个 turn.end（同 turnId）→ 1 个任务、2 轮。 */
function traceLines(day: string, turnId: string): string {
  const base = Date.parse(`${day}T01:00:00Z`);
  return [
    JSON.stringify({ t: 'turn.start', turnId, ts: base }),
    JSON.stringify({ t: 'turn.end', turnId, stopReason: 'completed', ts: base + 1000 }),
    JSON.stringify({ t: 'turn.end', turnId, stopReason: 'completed', ts: base + 2000 }),
  ].join('\n');
}

function mkSource(days: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-src-'));
  for (const d of days) {
    fs.writeFileSync(path.join(dir, `trace-${d}.jsonl`), `${traceLines(d, `t-${d}`)}\n`, 'utf8');
  }
  return dir;
}

describe('M3 采集：只读与归档', () => {
  it('采集前后源文件字节不变（sha256 + mtime 都不动）', () => {
    const src = mkSource(['2026-11-01', '2026-11-02']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const before = fs.readdirSync(src).map((f) => {
      const p = path.join(src, f);
      return { f, sha: sha(p), mtime: fs.statSync(p).mtimeMs };
    });

    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: true });

    const after = fs.readdirSync(src).map((f) => {
      const p = path.join(src, f);
      return { f, sha: sha(p), mtime: fs.statSync(p).mtimeMs };
    });
    expect(after).toEqual(before); // 只读：一个字节、一个时间戳都没变
    expect(r.totals.days).toBe(2);
  });

  it('归档副本逐字节一致，命名 = <archive>/<YYYY-MM-DD>/trace-<YYYY-MM-DD>.jsonl', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: true });

    const day = r.days[0];
    expect(day.archiveMode).toBe('copy');
    expect(day.byteIdentical).toBe(true);
    const expected = path.join(archive, '2026-11-01', 'trace-2026-11-01.jsonl');
    expect(day.archivedTo).toBe(expected);
    expect(sha(expected)).toBe(day.sha256);
    expect(sha(expected)).toBe(sha(path.join(src, 'trace-2026-11-01.jsonl')));
  });
});

describe('M3 采集：断档必须可见', () => {
  it('findGaps 点名中间缺的那一天', () => {
    expect(findGaps(['2026-11-01', '2026-11-03'])).toEqual(['2026-11-02']);
    expect(findGaps(['2026-11-01', '2026-11-02', '2026-11-03'])).toEqual([]);
    expect(findGaps(['2026-11-01'])).toEqual([]); // 单日不产生断档
  });

  it('dateRange 两端闭区间，跨月正确', () => {
    expect(dateRange('2026-10-31', '2026-11-02')).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('collectAll 在实测数据形状上给出 gaps（不许补零混过去）', () => {
    const src = mkSource(['2026-11-01', '2026-11-03']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: true });
    expect(r.gaps).toEqual(['2026-11-02']);
    expect(renderTotalsMarkdown(r, 1)).toContain('2026-11-02');
  });

  it('源目录不存在时显式列出（不静默当 0）', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const missing = path.join(os.tmpdir(), 'm3-definitely-missing-dir-xyz');
    const r = collectAll({ sources: [src, missing], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    const st = r.sourceStatus.find((s) => s.dir === path.resolve(missing));
    expect(st?.exists).toBe(false);
    expect(renderTotalsMarkdown(r, 1)).toContain('**不存在**');
  });
});

describe('M3 采集：样本不足必须明说', () => {
  it('isSampleSufficient 按任务数阈值判定', () => {
    expect(isSampleSufficient(19, 20)).toBe(false);
    expect(isSampleSufficient(20, 20)).toBe(true);
  });

  it('小样本报告里出现「样本不足」，且不编结论', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 20, write: false });
    const day = r.days[0];
    expect(day.sampleSufficient).toBe(false);
    const md = renderDailyMarkdown(day, 20);
    expect(md).toContain('**样本不足**');
    expect(md).toContain('未观测 ≠ 不存在');
    // 数字仍照列（1 任务 2 轮），但不许出现「因此/所以」类合成结论
    expect(md).toContain('| 任务数 / 有归属轮总数 | 1 / 2 |');
    expect(md).not.toMatch(/因此|所以被限流/);
  });

  it('阈值放宽后同一样本转为「充足」——证明判定咬的是真任务数', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    expect(r.days[0].sampleSufficient).toBe(true);
    expect(renderDailyMarkdown(r.days[0], 1)).not.toContain('**样本不足**');
  });
});

describe('M3 采集：表头口径对齐 baseline（不另起一套）', () => {
  it('每日报告包含 E1/E2/E3 三节与 baseline 同名字段', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    const md = renderDailyMarkdown(r.days[0], 1);
    for (const key of ['E1. 每任务请求数', 'E2. 同任务相邻请求间隔', 'E3. 重试占比', '同轮双事件', '截断重发轮数']) {
      expect(md, `missing baseline-aligned section: ${key}`).toContain(key);
    }
  });

  // 20261105 PM 口径①：空值不是零。没有 request.sent / continuation.decision 打点时，
  // E3 必须写「未采集（无打点）」，**绝不出现 0% / 0**，也不许写成「没有重试」。
  it('retry 未采集时 E3 明确写未采集，绝不出 0', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    expect(r.days[0].frequency.retry).toBeNull();
    const md = renderDailyMarkdown(r.days[0], 1);
    const retryRow = md.split('\n').find((l) => l.includes('retryable 重试占比（**分母 A')) ?? '';
    expect(retryRow).toContain('未采集（无打点）');
    expect(retryRow).not.toMatch(/\d%|\|\s*0\s*\|/);
    // 汇总侧同样不许把空值写成 0
    expect(retryTotalsLine(r)).toContain('未采集（无打点）');
  });

  // 20261105 PM 口径②：「同轮双事件」必须与「独立请求间隔」分开命名，不得叫「快速重发对」。
  it('E2 用「同轮双事件」命名并注明 ≠ 独立请求间隔', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    const md = renderDailyMarkdown(r.days[0], 1);
    expect(md).toContain('同轮双事件');
    expect(md).toContain('不是独立请求风暴');
    expect(md).not.toContain('快速重发对」');
  });

  // 有打点时回填真值（不是恒为「未采集」），且分母 A 用 request.sent 条数。
  it('有 continuation.decision / request.sent 打点时 retry 被真实回填', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-src-'));
    const lines = [
      JSON.stringify({ t: 'request.sent', turnId: 't1', bytes: 100, ts: 1 }),
      JSON.stringify({ t: 'request.sent', turnId: 't1', bytes: 100, ts: 2 }),
      JSON.stringify({ t: 'continuation.decision', turnId: 't1', reason: 'first-attempt-retry', triggered: true, ts: 3 }),
      JSON.stringify({ t: 'turn.end', turnId: 't1', stopReason: 'completed', ts: 4 }),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'trace-2026-11-04.jsonl'), `${lines}\n`, 'utf8');
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [dir], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    const retry = r.days[0].frequency.retry;
    expect(retry).not.toBeNull();
    expect(retry?.requestsSent).toBe(2);
    expect(retry?.firstAttemptRetry).toBe(1);
    expect(renderDailyMarkdown(r.days[0], 1)).toContain('分母 A = 实际发出请求 2');
  });

  // 20261105 PM 裁定：同一件事（retry 未落盘）在一个表里不许出现两种说法。
  it('未采集态两行措辞统一为「未采集（无打点）」，不出现「不可测」', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const r = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    const md = renderDailyMarkdown(r.days[0], 1);
    const rows = md.split('\n').filter((l) => l.includes('retryable 重试占比'));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row).toContain('未采集（无打点）');
    expect(md).not.toContain('不可测');
  });

  // 版本标记：retry 待打点时 TOTALS 必须自报「口径定稿版，retry 待打点」，不许冒充终值。
  it('TOTALS 在 retry 待打点时标版本，采集到后改标「retry 已采集」', () => {
    const src = mkSource(['2026-11-01']);
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-arc-'));
    const pending = collectAll({ sources: [src], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    expect(renderTotalsMarkdown(pending, 1)).toContain('retry 待打点');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-src-'));
    const lines = [
      JSON.stringify({ t: 'request.sent', turnId: 't1', bytes: 10, ts: 1 }),
      JSON.stringify({ t: 'continuation.decision', turnId: 't1', reason: 'first-attempt-retry', triggered: true, ts: 2 }),
      JSON.stringify({ t: 'turn.end', turnId: 't1', stopReason: 'completed', ts: 3 }),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'trace-2026-11-01.jsonl'), `${lines}\n`, 'utf8');
    const got = collectAll({ sources: [dir], archiveDir: archive, outDir: archive, sampleMin: 1, write: false });
    expect(renderTotalsMarkdown(got, 1)).toContain('retry 已采集');
  });
});