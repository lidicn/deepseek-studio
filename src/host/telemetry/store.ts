/**
 * C-4: telemetry/store — 按天 JSONL 落盘 + 成功率查询。
 *
 * 复用 web-engine.ts:132 recordToolCall 既有埋点口，不另造第二套。
 * 落盘格式：每天一个 JSONL 文件，每行一条 JSON 记录。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 一条工具调用记录（与 ToolCallRecord 对齐） */
export interface ToolCallRecord {
  tool: string;
  ok: boolean;
  durationMs: number;
  timestamp: number;
  error?: string;
}

/** 一天的统计结果 */
export interface DayStats {
  date: string;
  total: number;
  success: number;
  failure: number;
  successRate: number;
  byTool: Record<string, { total: number; success: number; failure: number }>;
}

export interface TelemetryStoreOptions {
  /** 落盘根目录，默认 <userData>/telemetry */
  rootDir: string;
}

/** 按天 JSONL 落盘的 telemetry store */
export class TelemetryStore {
  private readonly rootDir: string;

  constructor(options: TelemetryStoreOptions) {
    this.rootDir = options.rootDir;
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true });
    }
  }

  /** 追加一条工具调用记录 */
  append(rec: ToolCallRecord): void {
    const date = new Date(rec.timestamp).toISOString().slice(0, 10);
    const file = this.fileForDate(date);
    const line = JSON.stringify(rec) + '\n';
    appendFileSync(file, line, 'utf-8');
  }

  /** 查询某一天的统计 */
  getDayStats(date: string): DayStats {
    const file = this.fileForDate(date);
    const stats: DayStats = {
      date,
      total: 0,
      success: 0,
      failure: 0,
      successRate: 0,
      byTool: {},
    };
    if (!existsSync(file)) return stats;

    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as ToolCallRecord;
        stats.total += 1;
        if (rec.ok) stats.success += 1; else stats.failure += 1;
        if (!stats.byTool[rec.tool]) stats.byTool[rec.tool] = { total: 0, success: 0, failure: 0 };
        stats.byTool[rec.tool].total += 1;
        if (rec.ok) stats.byTool[rec.tool].success += 1; else stats.byTool[rec.tool].failure += 1;
      } catch { /* ignore bad line */ }
    }
    stats.successRate = stats.total > 0 ? stats.success / stats.total : 0;
    return stats;
  }

  /** 查询最近 N 天的统计 */
  getRecentDays(n: number): DayStats[] {
    const files = readdirSync(this.rootDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .slice(-n);
    return files.map((f) => this.getDayStats(f.replace('.jsonl', '')));
  }

  /** 获取落盘目录下的 jsonl 文件数 */
  get fileCount(): number {
    return readdirSync(this.rootDir).filter((f) => f.endsWith('.jsonl')).length;
  }

  private fileForDate(date: string): string {
    return join(this.rootDir, `${date}.jsonl`);
  }
}

/** 创建 telemetry store 实例 */
export function createTelemetryStore(options: TelemetryStoreOptions): TelemetryStore {
  return new TelemetryStore(options);
}
