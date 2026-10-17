#!/usr/bin/env tsx
/**
 * tools/metrics/report.ts — D1 裁决取数 CLI
 *
 * 读取一份 JSONL 事件日志（harness-metrics 事件流的落盘形式），
 * 复用 createHarnessMetrics() 计算 nudgeRate，吐出 D1 判定报告。
 *
 * 用法：npx tsx tools/metrics/report.ts <file.jsonl>
 * 退出码：0=PASS(<5%)  1=FAIL(>=5%)  2=文件错误/全解析失败
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHarnessMetrics } from '../../src/shared/harness-metrics';
import { createToolEventBus } from '../../src/shared/tool-event-bus';
import type { AgentLoopEvent } from '../../src/host/agent-loop';

// ---------------------------------------------------------------- 类型

/** JSONL 一行的判别联合：bus 事件 或 loop 事件。 */
type LogLine =
  | { kind: 'bus'; event: 'before-call' | 'after-call' | 'call-error' | 'call-skip' }
  | { kind: 'loop'; type: string; text?: string };

export interface ReportResult {
  /** 总行数（非空行）。 */
  totalLines: number;
  /** 解析失败行数。 */
  parseErrors: number;
  /** 已结束的单次工具调用总数。 */
  toolCallsTotal: number;
  /** 工具回合数。 */
  toolRounds: number;
  /** 需 nudge 的回合数。 */
  nudgeRounds: number;
  /** nudge 率（0~1）。 */
  nudgeRate: number;
  /** D1 判定文本。 */
  d1Verdict: 'PASS' | 'FAIL';
  /** 样本量不足警告。 */
  sampleWarn: boolean;
}

// ---------------------------------------------------------------- 核心逻辑

/**
 * 吃一批 JSONL 文本行，喂给真实的 createHarnessMetrics()，返回报告。
 * 测试直接调这个函数，不 spawn 子进程。
 */
export function buildReport(lines: string[]): ReportResult {
  const bus = createToolEventBus();
  const harness = createHarnessMetrics(bus);

  let totalLines = 0;
  let parseErrors = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    totalLines++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parseErrors++;
      continue;
    }

    const obj = parsed as LogLine;
    if (typeof obj !== 'object' || obj === null || typeof obj.kind !== 'string') {
      parseErrors++;
      continue;
    }

    try {
      if (obj.kind === 'bus') {
        // 喂给真实 bus，harness 自动订阅 '*'
        bus.emit(obj.event, { toolName: 'unknown', params: {} });
      } else if (obj.kind === 'loop') {
        // 喂给 harness.onEvent
        const event = obj as unknown as AgentLoopEvent;
        harness.onEvent(event);
      } else {
        parseErrors++;
      }
    } catch {
      parseErrors++;
    }
  }

  const snap = harness.snapshot();
  harness.dispose();

  const rate = snap.nudgeRate;
  const d1Verdict: ReportResult['d1Verdict'] = rate < 0.05 ? 'PASS' : 'FAIL';
  const sampleWarn = snap.toolRounds < 20;

  return {
    totalLines,
    parseErrors,
    toolCallsTotal: snap.toolCallsTotal,
    toolRounds: snap.toolRounds,
    nudgeRounds: snap.nudgeRounds,
    nudgeRate: rate,
    d1Verdict,
    sampleWarn,
  };
}

// ---------------------------------------------------------------- 格式化

function formatReport(r: ReportResult): string {
  const pct = (r.nudgeRate * 100).toFixed(2) + '%';
  const out: string[] = [];
  out.push('=== Harness Metrics 报告 ===');
  out.push(`总事件行数:   ${r.totalLines}`);
  out.push(`解析失败行:   ${r.parseErrors}`);
  out.push(`工具调用总数: ${r.toolCallsTotal}`);
  out.push(`工具回合数:   ${r.toolRounds}`);
  out.push(`Nudge 回合:   ${r.nudgeRounds}`);
  out.push(`nudgeRate:    ${pct}`);
  out.push('');
  if (r.d1Verdict === 'PASS') {
    out.push('D1 = PASS (可直接做 M3)');
  } else {
    out.push('D1 = FAIL (先补 web-engine 完成检测)');
  }
  if (r.sampleWarn) {
    out.push('WARN: 样本量不足，结论仅供参考');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- CLI

function main(): void {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('用法: tsx tools/metrics/report.ts <file.jsonl>');
    process.exit(2);
  }
  if (!existsSync(filePath)) {
    console.error(`文件不存在: ${filePath}`);
    process.exit(2);
  }

  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');

  const report = buildReport(lines);

  // 全解析失败或没有任何有效事件 → exit 2
  if (report.totalLines === 0 || (report.parseErrors === report.totalLines && report.toolRounds === 0)) {
    console.error(formatReport(report));
    console.error('错误: 没有可解析的有效事件');
    process.exit(2);
  }

  console.log(formatReport(report));
  process.exit(report.d1Verdict === 'PASS' ? 0 : 1);
}

// 仅在直接执行时跑 main，被 import 时不触发（测试 import buildReport 用）
const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('report.ts');
if (isDirectRun) {
  main();
}
