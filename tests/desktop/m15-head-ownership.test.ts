// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  __prepareOutgoingBodyForTesting,
  __setCapabilityPromptForTesting,
  interceptorTraceSnapshot,
  capabilityPromptText,
  catalogText,
} from '../../src/inject/main-world-interceptor';

/**
 * M1.5 护栏：head 归属唯一（契约 §4 的 I5′）。
 *
 * head-A 只由 `prepareOutgoingBody` 拼一次；续跑轮只能是 tail。
 * 一旦有人把二次注入改掉、或让续跑轮自带 head，护栏必须立刻暴露：
 *   - `m15.head_duplicated` trace 计数 > 0（入参 prompt 已含能力块标记）；
 *   - 最终 body 的 prompt 里「## 可用工具」段出现次数 != 1。
 */

const CAP_MARKER = '[studio-tool-capability]';
const CAP_END_MARKER = '[studio-tool-capability-end]';
const MCP_HEADER = '## 已配置的 MCP 工具';
const TOOL_HEADER = '## 可用工具';

/**
 * 数 M1.5 观测事件。
 * trace 的事件类型是 shared 里的封闭 union（`m15.*` 由本卡用窄 cast 记进去），
 * 这里同样窄 cast 一下再按 t 过滤。
 */
function countM15(type: string): number {
  return interceptorTraceSnapshot().filter((e) => (e as unknown as { t: string }).t === type).length;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return n;
    n += 1;
    from = at + needle.length;
  }
}

/** 造一条「续跑轮」的原始 body（prompt = tail）。 */
function continuationBody(tail: string): string {
  return JSON.stringify({ prompt: tail, chat_session_id: 's-m15' });
}

function promptOfAssembled(rawBody: string, taskText = '帮我跑个命令'): string {
  const out = __prepareOutgoingBodyForTesting(rawBody, [], taskText);
  expect(out).not.toBeNull();
  return (JSON.parse(out!) as { prompt: string }).prompt;
}

beforeEach(() => {
  __setCapabilityPromptForTesting(null);
});

afterEach(() => {
  __setCapabilityPromptForTesting(null);
  vi.useRealTimers();
});

describe('M1.5 护栏：head 归属唯一（I5′）', () => {
  it('正常路径：最终 body 里 head 各段只出现一次，且 head_duplicated 计数为 0', () => {
    const tail = '继续跑：<original_task>帮我跑个命令</original_task>\n[TOOL_RESULTS]\n{}\n[/TOOL_RESULTS]';
    const prompt = promptOfAssembled(continuationBody(tail));

    expect(prompt).toContain(CAP_MARKER);
    expect(countOccurrences(prompt, TOOL_HEADER)).toBe(1);
    expect(countOccurrences(prompt, MCP_HEADER)).toBeLessThanOrEqual(1);

    expect(countM15('m15.head_duplicated')).toBe(0);
  });

  it('负控：入参 prompt 自带完整 head → head_duplicated 计数必须变 1（护栏不是摆设）', () => {
    // 构造一个「自带 head 的续跑轮」：prompt 里已经有**完整**的能力块
    // （标记 + 结束标记，缺了结束标记 strip 认不出来，那是另一回事）。
    const tailWithHead = `${capabilityPromptText()}\n${CAP_END_MARKER}\n\n继续跑：<original_task>帮我跑个命令</original_task>`;
    const prompt = promptOfAssembled(continuationBody(tailWithHead));

    expect(countM15('m15.head_duplicated')).toBe(1);
    // 护栏只观测、不改字节：strip 之后最终 body 里仍只有一份能力块
    expect(countOccurrences(prompt, CAP_MARKER)).toBe(1);
  });

  it('工具目录文本与能力块工具段逐字节相同（M1.5 删冗余的依据）', () => {
    const cap = capabilityPromptText();
    const catalog = catalogText();
    const capLines = cap.slice(cap.indexOf(TOOL_HEADER)).split('\n').filter((l) => l.startsWith('- '));
    const catLines = catalog.split('\n').filter((l) => l.startsWith('- '));
    expect(capLines.length).toBe(10);
    expect(capLines).toEqual(catLines);
  });
});
