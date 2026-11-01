/**
 * 宿主侧 trace 落盘（C1-F3）
 *
 * 背景：`memory.select` 的耗时/轮次原来只能从**内存审计环**（重启即丢）和页内钩子取证，
 * 落盘通道里查不到 → 验收只能靠页内探针，不可复现。
 *
 * 约定：与页端 trace 写**同一个文件**——`logs/trace/trace-<UTC日期>.jsonl`
 * （页端写入点见 `src/host/page-runtime.ts` 的 `trace` 分支）。
 * 一行一条 JSON；每行强制单行化并截断，避免超长载荷拖垮落盘。
 *
 * 失败语义：落盘失败**不影响主链路**（只影响事后取证），一律静默吞掉。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import nodePath from 'node:path';

/** 单行最大字符数（JSONL 一行必须是一行，且不能无限长）。 */
const TRACE_LINE_MAX_CHARS = 4_000;

export function appendTraceLine(line: string): void {
  try {
    const dir = nodePath.resolve(process.cwd(), 'logs', 'trace');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const safe = (line.length > TRACE_LINE_MAX_CHARS ? line.slice(0, TRACE_LINE_MAX_CHARS) : line).replace(
      /[\r\n]+/g,
      ' ',
    );
    appendFileSync(nodePath.join(dir, `trace-${day}.jsonl`), `${safe}\n`, 'utf8');
  } catch {
    // 落盘失败不影响主链路。
  }
}
