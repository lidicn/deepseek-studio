/**
 * report-merge 单测（v0.30 · Claude 主开发）
 *
 * 覆盖：3 report 合并、title+location 去重、severity 排序、空 report 合并 0 findings、
 * markdown 结构、bySeverity 统计、evidenceRefs 附录去重。
 */
import { describe, it, expect } from 'vitest';
import { mergeReports } from '../../src/host/bot/report-merge';
import type { SubBotReport } from '../../src/host/bot/types';

function mkReport(
  dimension: string,
  findings: Array<{ id: string; severity: 'critical' | 'high' | 'medium' | 'low'; title: string; location: string }>,
  evidenceRefs: string[] = [],
): SubBotReport {
  return {
    slotId: dimension,
    dimension,
    summary: `${dimension} 摘要`,
    findings: findings.map((f) => ({ ...f, description: 'd', evidenceRef: f.location })),
    evidenceRefs,
    transcriptPath: `runs/b/${dimension}.jsonl`,
  };
}

describe('mergeReports', () => {
  it('空数组 → 0 findings + 空报告 markdown', () => {
    const r = mergeReports([]);
    expect(r.totalFindings).toBe(0);
    expect(r.bySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(r.content).toContain('无子报告');
  });

  it('3 report 合并 findings 数累加', () => {
    const reports = [
      mkReport('security', [{ id: 'F1', severity: 'high', title: 'A', location: 'a.ts' }]),
      mkReport('performance', [{ id: 'F2', severity: 'low', title: 'B', location: 'b.ts' }]),
      mkReport('maintainability', [{ id: 'F3', severity: 'critical', title: 'C', location: 'c.ts' }]),
    ];
    const r = mergeReports(reports);
    expect(r.totalFindings).toBe(3);
    expect(r.bySeverity.critical).toBe(1);
    expect(r.bySeverity.high).toBe(1);
    expect(r.bySeverity.low).toBe(1);
  });

  it('severity 排序：critical 在 high 之前', () => {
    const reports = [
      mkReport('a', [{ id: 'F1', severity: 'low', title: 'L', location: 'l.ts' }]),
      mkReport('b', [{ id: 'F2', severity: 'critical', title: 'C', location: 'c.ts' }]),
      mkReport('c', [{ id: 'F3', severity: 'high', title: 'H', location: 'h.ts' }]),
    ];
    const r = mergeReports(reports);
    // markdown 里 critical 标记在 high 之前
    const cIdx = r.content.indexOf('🔴');
    const hIdx = r.content.indexOf('🟠');
    expect(cIdx).toBeGreaterThan(-1);
    expect(hIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeLessThan(hIdx);
  });

  it('title+location 去重（保留首次）', () => {
    const reports = [
      mkReport('a', [{ id: 'F1', severity: 'high', title: '重复', location: 'dup.ts' }]),
      mkReport('b', [{ id: 'F2', severity: 'high', title: '重复', location: 'dup.ts' }]),
      mkReport('c', [{ id: 'F3', severity: 'low', title: '唯一', location: 'uniq.ts' }]),
    ];
    const r = mergeReports(reports);
    expect(r.totalFindings).toBe(3); // 去重前
    // 去重后只有 2 条（重复的合并）
    expect(r.bySeverity.high + r.bySeverity.low).toBe(2);
    expect(r.content).toContain('去重前 3');
  });

  it('markdown 含维度分节 + findings 列表 + 证据附录', () => {
    const reports = [
      mkReport('security', [{ id: 'F1', severity: 'high', title: 'A', location: 'a.ts' }], ['a.ts:10']),
      mkReport('perf', [{ id: 'F2', severity: 'low', title: 'B', location: 'b.ts' }], ['b.ts:20']),
    ];
    const r = mergeReports(reports);
    expect(r.content).toContain('# 综合审计报告');
    expect(r.content).toContain('## 各维度摘要');
    expect(r.content).toContain('### security');
    expect(r.content).toContain('### perf');
    expect(r.content).toContain('## 发现列表');
    expect(r.content).toContain('## 证据引用');
    expect(r.content).toContain('a.ts:10');
    expect(r.content).toContain('b.ts:20');
  });

  it('evidenceRefs 跨报告去重', () => {
    const reports = [
      mkReport('a', [], ['ref1', 'ref2']),
      mkReport('b', [], ['ref2', 'ref3']),
    ];
    const r = mergeReports(reports);
    expect(r.content).toContain('ref1');
    expect(r.content).toContain('ref3');
    // ref2 去重后只出现一次（在附录里）
    const matches = r.content.match(/ref2/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('含转录路径附录', () => {
    const reports = [mkReport('a', [], [])];
    const r = mergeReports(reports);
    expect(r.content).toContain('## 子 bot 转录');
    expect(r.content).toContain('runs/b/a.jsonl');
  });

  it('无 findings 时输出"无结构化发现"', () => {
    const reports = [mkReport('a', [], [])];
    const r = mergeReports(reports);
    expect(r.content).toContain('无结构化发现');
  });

  it('审计维度数 = report 数', () => {
    const reports = [
      mkReport('a', [{ id: 'F1', severity: 'low', title: 't', location: 'l' }]),
      mkReport('b', [{ id: 'F2', severity: 'low', title: 't2', location: 'l2' }]),
    ];
    const r = mergeReports(reports);
    expect(r.content).toContain('审计维度数：2');
  });
});
