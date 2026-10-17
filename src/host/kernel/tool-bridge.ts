/**
 * ToolBridge（S8）：TaskLoop → 工具执行器的桥。
 *
 * 定位：只定义接口与一条「跑记录→回填」的纯函数，不绑真注册表（S13 再接 tool-registry）。
 *   - ToolExecutor.execute(name, args) → { ok, result?, error? }
 *   - 未注入 executor 时 TaskLoop 退化为只回填、不真执行。
 */

import type { ToolCallRecord } from '../engine/model-engine';

// ---------------------------------------------------------------- 类型

export interface ToolExecutorResult {
  readonly ok: boolean;
  readonly result?: string;
  readonly error?: string;
}

export interface ToolExecutor {
  execute(name: string, args?: unknown): Promise<ToolExecutorResult>;
}

export interface ExecutedToolRecord {
  readonly record: ToolCallRecord;
  readonly content: string;
}

// ---------------------------------------------------------------- 纯函数

/**
 * 跑一条工具记录：调 executor，把结果格式化成 role:'tool' 消息内容。
 * executor 抛错 → 记为 failed，不向上炸（一轮里某个工具挂掉不该断整个循环）。
 */
export async function executeToolRecord(
  executor: ToolExecutor,
  rec: ToolCallRecord,
): Promise<ExecutedToolRecord> {
  try {
    const r = await executor.execute(rec.tool);
    const ok = r.ok;
    const record: ToolCallRecord = {
      tool: rec.tool,
      ok,
      ...(r.error ? { error: r.error } : {}),
    };
    const content = ok
      ? `[${rec.tool}] ${r.result ?? 'ok'}`
      : `[${rec.tool}] failed: ${r.error ?? 'unknown error'}`;
    return { record, content };
  } catch (e) {
    return {
      record: { tool: rec.tool, ok: false, error: String(e) },
      content: `[${rec.tool}] failed: ${String(e)}`,
    };
  }
}

/** 假执行器：按 name 返回固定结果，便于测试。 */
export function createFakeExecutor(
  table: Record<string, ToolExecutorResult>,
): ToolExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async execute(name: string) {
      calls.push(name);
      return table[name] ?? { ok: false, error: `no such tool: ${name}` };
    },
  };
}
