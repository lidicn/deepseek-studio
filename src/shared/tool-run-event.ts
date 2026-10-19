/**
 * 结构化工具运行事件（Workbench UI 投影）
 *
 * 与既有事件的关系：
 * - agent-loop-event.ts：agent 对话/步数/计数事件，保持原契约
 * - tool-event-bus.ts：进程内工具生命周期总线，供 metrics/harness 消费
 * - tool-record.ts：完整调用/结果记录，含参数和 detail，适合审计
 * - ToolRunEvent 是脱敏 UI 投影，不广播完整 params/stdout
 */

import type { ToolRunPhase } from '../ui/ui-contract';

export interface ToolRunEvent {
  type: 'tool-run';
  runId: string;
  tool: string;
  phase: ToolRunPhase;
  step?: number;
  summary?: string;
  durationMs?: number;
  exitCode?: number | null;
  errorCode?: string;
  artifactPaths?: string[];
  details?: {
    path?: string;
    replacements?: number;
    bytesBefore?: number;
    bytesAfter?: number;
    sha256Before?: string;
    sha256After?: string;
  };
  botId?: string;
  roomId?: string;
}

/** 终态集合：每个 runId 只允许一条 */
export const TERMINAL_PHASES: ReadonlySet<ToolRunPhase> = new Set(['succeeded', 'failed', 'denied', 'cancelled']);
