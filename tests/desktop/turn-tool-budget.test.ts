// @vitest-environment node
/**
 * 2026-11-13 工具执行缺陷 **B：单轮工具结果累计预算（64 KB）**。
 *
 * 现场（`chat:ff7fc62f`）：一轮 11 次工具调用累计 **307,682 字节**原始结果进上下文。
 * `STUDIO_TOOL_PAYLOAD_LIMIT = 16 KB` 只封顶「一条」，封不住「一轮」——
 * 25 步 × 每次十几 KB 的画布就是 300 KB，模型注意力被淹。
 *
 * 判据（PM 卡）：
 *   1. 新增单轮累计上限 **64 KB**，与单次 16 KB **解耦**（单次口径一行不动）；
 *   2. 超限行为明确：**截断 + 一句可读提示**（告诉模型本轮已超预算、后续被截断），
 *      不得静默丢弃、不得让总量无限增长；
 *   3. 回归锁：构造超过 64 KB 的一轮，断言**总量被压到预算内**且**提示存在**。
 *
 * 「总量」的量法 = 真正写进 prompt 的那份 `<tool_results>` JSON（pretty-print，UTF-8 字节），
 * 不是紧凑 JSON——按紧凑量会系统性低估，预算当场失效。
 *
 * 负控（见交卷）：把 `renderBudgetedToolResults` 的预算判断改成恒 `true`（永远不裁剪）
 * ⇒ 第 2/3/5 条红；逐字节还原后复绿。
 */
import { describe, expect, it } from 'vitest';
import {
  TURN_TOOL_RESULT_BUDGET_BYTES,
  buildContinuationPrompt,
  buildProtocolRepairPrompt,
  renderBudgetedToolResults,
  renderWindowedToolResults,
  type PendingResult,
} from '../../src/shared/continuation-prompt';
import { STUDIO_TOOL_PAYLOAD_LIMIT } from '../../src/shared/studio-execution';

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 取出 prompt 里 `<tool_results>` 那段（模型真正读到的那块）并量字节。 */
function toolResultsBlock(prompt: string): string {
  const start = prompt.indexOf('<tool_results>');
  const end = prompt.indexOf('</tool_results>');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start + '<tool_results>'.length, end);
}

/** 造一条「结果很大」的执行：detail 走 stdout，output 走 result 的 JSON。 */
function bigResult(i: number, payloadChars: number): PendingResult {
  return {
    invocationName: `af_list_${i}`,
    ok: true,
    result: { stdout: `R${i}:` + '啊'.repeat(payloadChars / 3) },
  };
}

describe('B-1 预算常量与单次上限解耦', () => {
  it('单轮 64 KB / 单次 16 KB，两个口径各自独立存在', () => {
    expect(TURN_TOOL_RESULT_BUDGET_BYTES).toBe(64 * 1024);
    expect(STUDIO_TOOL_PAYLOAD_LIMIT).toBe(16 * 1024);
  });
});

describe('B-2 未超预算：逐字节不变（不许偷偷改小批次的输出）', () => {
  it('3 条小结果 → 与旧窗口化输出完全一致，且无预算提示', () => {
    const execs: PendingResult[] = [
      { invocationName: 'file.read', ok: true, result: 'a' },
      { invocationName: 'file.read', ok: true, result: 'b' },
      { invocationName: 'shell.exec', ok: false, error: 'nonzero-exit' },
    ];
    const view = renderBudgetedToolResults(execs);

    expect(view.notice).toBeUndefined();
    expect(view.omittedCount).toBe(0);
    expect(JSON.stringify(view.results, null, 2)).toBe(JSON.stringify(renderWindowedToolResults(execs), null, 2));

    const prompt = buildContinuationPrompt('任务', execs);
    expect(prompt).not.toContain('预算');
    expect(bytes(toolResultsBlock(prompt))).toBeLessThanOrEqual(TURN_TOOL_RESULT_BUDGET_BYTES);
  });
});

describe('B-3 超预算：总量压回预算内 + 提示存在', () => {
  it('12 条 × 约 8 KB（≈96 KB）→ 结果块 ≤ 64 KB，含可读提示，且保留最新一条', () => {
    const execs: PendingResult[] = Array.from({ length: 12 }, (_, i) => bigResult(i, 8_000));
    const prompt = buildContinuationPrompt('查设备', execs);
    const block = toolResultsBlock(prompt);

    expect(bytes(block)).toBeLessThanOrEqual(TURN_TOOL_RESULT_BUDGET_BYTES);
    // 提示必须可读、且在 <tool_results> 之外（不污染 JSON）
    expect(prompt).toContain('预算');
    expect(prompt).toContain('已省略');
    expect(prompt).toContain('截断');
    // 最新一条必须保住（保新弃旧），最早一条必须被省掉
    expect(block).toContain('af_list_11');
    expect(block).not.toContain('af_list_0"');
  });

  it('预算视图自报省略条数，且省略后仍 ≤ 预算', () => {
    const execs: PendingResult[] = Array.from({ length: 12 }, (_, i) => bigResult(i, 8_000));
    const view = renderBudgetedToolResults(execs);

    expect(view.omittedCount).toBeGreaterThan(0);
    expect(view.notice).toContain('64 KB');
    expect(bytes(JSON.stringify(view.results, null, 2))).toBeLessThanOrEqual(TURN_TOOL_RESULT_BUDGET_BYTES);
  });

  it('边界那条被截断（truncated 标记），不是整条静默丢弃', () => {
    const execs: PendingResult[] = Array.from({ length: 6 }, (_, i) => bigResult(i, 12_000));
    const view = renderBudgetedToolResults(execs);

    const truncatedEntries = view.results.filter((r) => r.truncated === true);
    expect(truncatedEntries.length).toBeGreaterThan(0);
    expect(bytes(JSON.stringify(view.results, null, 2))).toBeLessThanOrEqual(TURN_TOOL_RESULT_BUDGET_BYTES);
  });

  it('协议修复 prompt 同样过预算（不存在绕过预算的旁路）', () => {
    const execs: PendingResult[] = Array.from({ length: 12 }, (_, i) => bigResult(i, 8_000));
    const prompt = buildProtocolRepairPrompt('查设备', execs);

    expect(bytes(toolResultsBlock(prompt))).toBeLessThanOrEqual(TURN_TOOL_RESULT_BUDGET_BYTES);
    expect(prompt).toContain('预算');
  });
});
