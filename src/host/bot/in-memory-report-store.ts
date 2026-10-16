/**
 * InMemoryReportStore（v0.30 · Claude 主开发 — 测试桩）
 *
 * Map-based 实现 ReportStore 接口。让 Claude 不等 CB 的 FS 版也能跑全部新文件 +
 * 单测/集成测。照抄 chat-room-runtime.ts:602-618 的 InMemoryNoMeetingStateStore 模式。
 *
 * 真机用 CB 的 FS 版（report-store.ts）；Claude 在 desktop-host.ts 一行换即可。
 * 不做持久化：进程结束即丢。transcript 用数组按序存（模拟 jsonl 逐行追加）。
 */

import type { SubBotReport } from './types';
import type { ReportStore } from './types';

export class InMemoryReportStore implements ReportStore {
  /** batchId → 该批次目录（桩里仅模拟存在性）。 */
  private readonly batches = new Set<string>();
  /** batchId → slotId → 逐条 event（模拟 jsonl 行）。 */
  private readonly transcripts = new Map<string, Map<string, unknown[]>>();
  /** batchId → slotId → SubBotReport。 */
  private readonly subReports = new Map<string, Map<string, SubBotReport>>();
  /** batchId → merged summary.md 内容。 */
  private readonly merged = new Map<string, string>();

  ensureBatchDir(batchId: string): string {
    this.batches.add(batchId);
    return `memory://runs/${batchId}`;
  }

  appendTranscript(batchId: string, slotId: string, event: unknown): void {
    let batch = this.transcripts.get(batchId);
    if (!batch) {
      batch = new Map();
      this.transcripts.set(batchId, batch);
    }
    let lines = batch.get(slotId);
    if (!lines) {
      lines = [];
      batch.set(slotId, lines);
    }
    lines.push(event);
  }

  writeSubReport(batchId: string, slotId: string, report: SubBotReport): void {
    let batch = this.subReports.get(batchId);
    if (!batch) {
      batch = new Map();
      this.subReports.set(batchId, batch);
    }
    batch.set(slotId, report);
  }

  readSubReports(batchId: string): SubBotReport[] {
    const batch = this.subReports.get(batchId);
    if (!batch) return [];
    return Array.from(batch.values());
  }

  writeMergedReport(batchId: string, content: string): string {
    this.merged.set(batchId, content);
    return `memory://runs/${batchId}/summary.md`;
  }

  getMergedReportPath(batchId: string): string {
    return this.merged.has(batchId) ? `memory://runs/${batchId}/summary.md` : '';
  }

  // —— 测试辅助（不属 ReportStore 契约，仅供断言用）——

  /** 读某槽 transcript 全量事件（测试断言按序）。 */
  getTranscript(batchId: string, slotId: string): readonly unknown[] {
    return this.transcripts.get(batchId)?.get(slotId) ?? [];
  }

  /** 读某槽 SubBotReport（测试断言单报告）。 */
  getSubReport(batchId: string, slotId: string): SubBotReport | undefined {
    return this.subReports.get(batchId)?.get(slotId);
  }
}
