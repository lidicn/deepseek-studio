/**
 * ToolBridge（S8）：TaskLoop → 工具执行器的桥。
 *
 * 定位：只定义接口与一条「跑记录→回填」的纯函数，不绑真注册表（S13 再接 tool-registry）。
 *   - ToolExecutor.execute(name, args) → { ok, result?, error? }
 *   - 未注入 executor 时 TaskLoop 退化为只回填、不真执行。
 */

import type { ToolCallRecord } from '../engine/model-engine';
import { failureTextFor } from '../../shared/tool-result-format';

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
 * 失败文案：三态两分支（2026-11-13 PM 批的口径统一）。
 *
 * 空串是**真可达**的：`real-tool-executor.ts:27` 是 `error: r.stderr ?? \`exit ${code}\``——
 * 非零退出但 stderr 为空时 `error` 就是 `''`，而 `''` 不是 nullish，`??` 兜不住它。
 * 「根本没给」（`undefined`/`null`）同样可达：`host-tools-adapter` 的 `String(e)` 之外的
 * `{ ok:false }` 形态、`createFakeExecutor` 的 no-such-tool 都会走到。
 *
 * 两种都必须给出**可行动**的文本：
 *   - 非空 → 原样返回（逐字节不变，不 trim 不改写）；
 *   - 其余（空串 / 纯空白 / undefined / null）→ `failureTextFor(tool)`，含工具名，
 *     并且带「请勿重复相同调用」——那句正是 91858 字节重放事故的止损提示。
 *
 * 历史上这里对 `undefined` 吐过 `'unknown error'`（零可动作信息、也不含工具名），
 * 该字面已按统一口径删除；旧断言 `kernel-tool-bridge.test.ts #11` 已同步**加强**改期望。
 */
export function toolFailureDetail(tool: string, raw: string | undefined | null): string {
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  return failureTextFor(tool);
}

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
    // 原实现 `...(r.error ? { error: r.error } : {})` 是**空串→无字段**的丢弃点：
    // 空串被当成"没给"，下游只能退化成 `unknown error`。这里统一走 toolFailureDetail。
    const errorDetail = ok ? undefined : toolFailureDetail(rec.tool, r.error);
    const record: ToolCallRecord = {
      tool: rec.tool,
      ok,
      ...(errorDetail !== undefined ? { error: errorDetail } : {}),
    };
    const content = ok
      ? `[${rec.tool}] ${r.result ?? 'ok'}`
      : `[${rec.tool}] failed: ${errorDetail}`;
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
