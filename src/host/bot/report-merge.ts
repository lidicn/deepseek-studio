/**
 * 报告汇总（v0.30 · Claude 主开发 — 纯函数）
 *
 * 把多个维度的 SubBotReport 合并成一份综合审计报告 markdown。
 * 纯逻辑无 IO：收集 findings → severity 排序（critical>high>medium>low）→
 * title+location 去重 → 生成 markdown（批次头 + 总计 + 按维度分节 + findings 表 +
 * evidenceRefs 附录）。
 *
 * 设计稿 P5：汇总槽 merge 逻辑（去重/排序/证据链）。
 * 边界：纯函数，不 import desktop-host / 不触碰 CB 文件。
 */

import type { FindingSeverity, SubBotReport } from './types';

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: '🔴 阻断',
  high: '🟠 高危',
  medium: '🟡 中等',
  low: '🟢 轻微',
};

export interface MergeResult {
  /** 综合报告 markdown 全文。 */
  readonly content: string;
  /** 合并后（去重前总）finding 数。 */
  readonly totalFindings: number;
  /** 去重后各严重度计数。 */
  readonly bySeverity: SeverityCounts;
}

/**
 * 合并多份 SubBotReport 为综合审计 markdown。
 * findings 按 severity 排序，同 title+location 去重（保留首次出现）。
 */
export function mergeReports(reports: readonly SubBotReport[]): MergeResult {
  if (reports.length === 0) {
    return {
      content: buildEmptyReport(),
      totalFindings: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    };
  }

  const seen = new Set<string>();
  const deduped: Array<{ report: SubBotReport; finding: SubBotReport['findings'][number] }> = [];
  let total = 0;

  for (const report of reports) {
    for (const finding of report.findings) {
      total++;
      const key = `${finding.title}|${finding.location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ report, finding });
    }
  }

  // severity 升序（critical 在前），同级按维度稳定排序。
  deduped.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity];
    if (sev !== 0) return sev;
    return a.report.dimension.localeCompare(b.report.dimension);
  });

  const bySeverity: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const { finding } of deduped) bySeverity[finding.severity]++;

  const content = buildMarkdown(reports, deduped, bySeverity, total);
  return { content, totalFindings: total, bySeverity };
}

type SeverityCounts = { critical: number; high: number; medium: number; low: number };

function buildEmptyReport(): string {
  return [
    '# 综合审计报告',
    '',
    '> 本批次无子报告（所有维度均失败或未产出）。',
    '',
  ].join('\n');
}

function buildMarkdown(
  reports: readonly SubBotReport[],
  deduped: Array<{ report: SubBotReport; finding: SubBotReport['findings'][number] }>,
  bySeverity: SeverityCounts,
  totalBeforeDedup: number,
): string {
  const lines: string[] = [];
  lines.push('# 综合审计报告');
  lines.push('');
  lines.push(`- 审计维度数：${reports.length}`);
  lines.push(`- 发现总数：${deduped.length}（去重前 ${totalBeforeDedup}）`);
  lines.push(
    `- 严重度分布：阻断 ${bySeverity.critical} / 高危 ${bySeverity.high} / 中等 ${bySeverity.medium} / 轻微 ${bySeverity.low}`,
  );
  lines.push('');

  // 按维度分节：各子报告摘要。
  lines.push('## 各维度摘要');
  for (const r of reports) {
    lines.push(`### ${r.dimension}（槽 ${r.slotId}）`);
    lines.push(r.summary);
    lines.push('');
  }

  // findings 表（按 severity 排序）。
  lines.push('## 发现列表（按严重度）');
  if (deduped.length === 0) {
    lines.push('');
    lines.push('> 无结构化发现。');
    lines.push('');
  } else {
    for (const { report, finding } of deduped) {
      lines.push(`- ${SEVERITY_LABEL[finding.severity]} \`${finding.id}\` **${finding.title}**`);
      lines.push(`  - 维度：${report.dimension}`);
      lines.push(`  - 位置：\`${finding.location}\``);
      lines.push(`  - 描述：${finding.description}`);
      lines.push(`  - 证据：\`${finding.evidenceRef}\``);
    }
    lines.push('');
  }

  // evidenceRefs 附录（去重）。
  const allRefs = new Set<string>();
  for (const r of reports) for (const ref of r.evidenceRefs) allRefs.add(ref);
  lines.push('## 证据引用（指针，不内联全文）');
  if (allRefs.size === 0) {
    lines.push('> 无。');
  } else {
    for (const ref of allRefs) lines.push(`- \`${ref}\``);
  }
  lines.push('');

  // 转录路径附录（供按需拉取证据）。
  lines.push('## 子 bot 转录（按需追溯）');
  for (const r of reports) {
    lines.push(`- ${r.dimension}（槽 ${r.slotId}）：\`${r.transcriptPath}\``);
  }
  lines.push('');

  return lines.join('\n');
}
