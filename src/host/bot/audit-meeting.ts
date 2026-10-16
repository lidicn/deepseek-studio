/**
 * 审计会议（v0.30 · Claude 主开发）
 *
 * 命令检测 + 调度编排。复用 meeting-commands.ts 的显式命令检测模式 +
 * strategy-generator 的调度风格。
 *
 * 触发：`@main 审计 <target> 维度 <d1,d2,d3>` 或 `/审计 <target>`。
 * 语义：主 bot 召唤多个 audit-expert 实例（同人设不同维度），各自离线审计 →
 * SubBotReport → 主 bot 汇总出综合审计报告。
 *
 * dispatch 流程：
 *   1. ensureBatchDir
 *   2. 每个 dimension：scheduler.assign({ persona:'audit-expert', task:{dimension,target,
 *      batchId,roomId,text} })——Scheduler 的 runner 参数已注入 offlineRunExecutor，
 *      assign 调 runner（副作用写 reportStore）+ 自动 release slot
 *   3. Promise.allSettled——N bot 并行（各独立 loop/engine，不互阻）
 *   4. readSubReports 拉所有报告
 *   5. mergeReports → writeMergedReport
 *   6. 推 report-ready 事件
 *
 * 关键：Scheduler 不返 runner 结果（:49 注释"对齐在 G1-P4"），SubBotReport 由 runner
 * 副作用写 reportStore，dispatch 事后 readSubReports 读。不改 scheduler.ts 契约。
 *
 * 边界：不 import desktop-host / 不触碰 CB 文件。
 */

import type { Scheduler } from './scheduler';
import type {
  ChatRoomReportReadyEvent,
  ChatRoomTaskCompleteEvent,
  ChatRoomTaskProgressEvent,
  ReportStore,
} from './types';
import { buildAuditTaskPrompt } from './report-protocol';
import { DEFAULT_AUDIT_DIMENSIONS } from './report-protocol';
import { mergeReports } from './report-merge';

/** 任务进度/完成/报告就绪推送口（dispatch 注入，转 emitChatRoomEvent）。 */
export type TaskProgressSink = (event: ChatRoomTaskProgressEvent) => void;
export type TaskCompleteSink = (event: ChatRoomTaskCompleteEvent) => void;
export type ReportReadySink = (event: ChatRoomReportReadyEvent) => void;

/** 审计命令解析结果。 */
export interface AuditCommand {
  readonly kind: 'audit' | 'none';
  /** 审计目标（路径/仓库名/模块名）。 */
  readonly target: string;
  /** 维度列表（显式提供则用，否则用 DEFAULT_AUDIT_DIMENSIONS）。 */
  readonly dimensions: string[];
}

/** 审计调度器（注入 chat-room-runtime options）。 */
export interface AuditDispatcher {
  dispatch(roomId: string, batchId: string, target: string, dimensions: readonly string[]): Promise<void>;
}

/** 空白分隔。 */
const WS = /[^\S\n]*/;

/** 显式审计命令：`/审计 <target>` 或 `@main 审计 <target>`。 */
const EXP_AUDIT: readonly RegExp[] = [
  new RegExp(`^/+审计${WS.source}`, 'i'),
  new RegExp(`^@main${WS.source}审计${WS.source}`, 'i'),
];

/** 显式维度标记：`维度` / `dim` / `dimension`。 */
const EXP_DIM = /\s(?:维度|维|dim|dimension)\s*[:：]?\s*(.+)$/i;

/**
 * 检测一条聊天室消息是否含审计意图。
 *
 * 形态：
 *   - `@main 审计 E:/NAS/AutoForge 维度 并发安全,内存泄漏,越权风险`
 *   - `/审计 E:/NAS/AutoForge`
 *   - `@main 审计 src/db.ts 维度 安全,性能`
 *
 * 维度缺省 → DEFAULT_AUDIT_DIMENSIONS。维度用中英文逗号/顿号分隔。
 * target 是审计关键词之后、维度标记之前的部分（trim）。
 */
export function detectAuditCommand(text: string): AuditCommand {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return { kind: 'none', target: '', dimensions: [] };

  let matched: string | null = null;
  for (const re of EXP_AUDIT) {
    const m = re.exec(trimmed);
    if (m) {
      matched = m[0];
      break;
    }
  }
  if (!matched) return { kind: 'none', target: '', dimensions: [] };

  const rest = trimmed.slice(matched.length).trim();
  if (!rest) return { kind: 'none', target: '', dimensions: [] };

  // 拆出维度部分（若有）。
  const dimMatch = EXP_DIM.exec(rest);
  let target = rest;
  let dimsRaw = '';
  if (dimMatch) {
    target = rest.slice(0, dimMatch.index).trim();
    dimsRaw = dimMatch[1].trim();
  }

  if (!target) return { kind: 'none', target: '', dimensions: [] };

  const dimensions = dimsRaw
    ? dimsRaw
        .split(/[,，、]/)
        .map((d) => d.trim())
        .filter(Boolean)
    : [...DEFAULT_AUDIT_DIMENSIONS];

  if (dimensions.length === 0) dimensions.push(...DEFAULT_AUDIT_DIMENSIONS);

  return { kind: 'audit', target, dimensions };
}

export interface AuditDispatcherDeps {
  readonly scheduler: Scheduler;
  readonly reportStore: ReportStore;
  readonly onTaskProgress?: TaskProgressSink;
  readonly onTaskComplete?: TaskCompleteSink;
  readonly onReportReady?: ReportReadySink;
}

/**
 * 建 AuditDispatcher。dispatch 走 ensureBatchDir → N 维度 scheduler.assign（runner 副作用
 * 写 reportStore）→ Promise.allSettled → readSubReports → mergeReports → writeMergedReport
 * → 推 report-ready。
 */
export function createAuditDispatcher(deps: AuditDispatcherDeps): AuditDispatcher {
  const { scheduler, reportStore } = deps;

  return {
    async dispatch(
      roomId: string,
      batchId: string,
      target: string,
      dimensions: readonly string[],
    ): Promise<void> {
      reportStore.ensureBatchDir(batchId);

      // 每个维度一个 assign：runner（offlineRunExecutor）已注入 scheduler，副作用写 reportStore。
      const assigns = dimensions.map((dimension) =>
        scheduler.assign({
          persona: 'audit-expert',
          task: {
            dimension,
            target,
            batchId,
            roomId,
            text: buildAuditTaskPrompt(dimension, target),
          },
        }),
      );

      // N bot 并行；allSettled 吞单维度失败（失败已在 task-complete(ok=false) 里报告）。
      await Promise.allSettled(assigns);

      // 拉所有报告（含失败维度的降级报告）。
      const reports = reportStore.readSubReports(batchId);
      const merged = mergeReports(reports);
      const summaryPath = reportStore.writeMergedReport(batchId, merged.content);

      deps.onReportReady?.({
        kind: 'report-ready',
        roomId,
        batchId,
        summaryPath,
        subReports: reports.map((r) => ({
          slotId: r.slotId,
          dimension: r.dimension,
          findingCount: r.findings.length,
          summary: r.summary,
        })),
        timestamp: Date.now(),
      });
    },
  };
}

export { DEFAULT_AUDIT_DIMENSIONS } from './report-protocol';
