/**
 * continuation-prompt.test.ts — 续跑/nudge prompt 构建器单测（v1.6）
 *
 * 纯函数测试，无 DOM / 运行时依赖。验证移植自 deepseek-pp prompt.ts 的核心逻辑。
 */
import { describe, it, expect } from 'vitest';
import {
  buildContinuationPrompt,
  buildNudgePrompt,
  shouldNudge,
  extractTaskCompleteSignal,
  renderWindowedToolResults,
  clampText,
  MAX_LOOP,
  MAX_NUDGES,
  FULL_TOOL_RESULT_WINDOW,
  type PendingResult,
} from '../../src/shared/continuation-prompt';

describe('continuation-prompt —— 常量', () => {
  it('MAX_LOOP 对齐 deepseek-pp 的 25 步', () => {
    expect(MAX_LOOP).toBe(25);
  });
  it('MAX_NUDGES 对齐 deepseek-pp 的 8 次', () => {
    expect(MAX_NUDGES).toBe(8);
  });
  it('FULL_TOOL_RESULT_WINDOW = 4', () => {
    expect(FULL_TOOL_RESULT_WINDOW).toBe(4);
  });
});

describe('clampText', () => {
  it('未超限原样返回', () => {
    expect(clampText('短文本', 100)).toBe('短文本');
  });
  it('超限加 ...[truncated]', () => {
    const s = 'a'.repeat(100);
    const r = clampText(s, 10);
    expect(r).toBe('a'.repeat(10) + '\n...[truncated]');
  });
  it('undefined 透传', () => {
    expect(clampText(undefined, 100)).toBeUndefined();
  });
  it('空字符串透传（非 undefined）', () => {
    expect(clampText('', 100)).toBe('');
  });
});

describe('extractTaskCompleteSignal', () => {
  it('合法 JSON body 取 summary', () => {
    const r = extractTaskCompleteSignal('done <task_complete>{"summary":"任务完成"}</task_complete>');
    expect(r).not.toBeNull();
    expect(r!.summary).toBe('任务完成');
  });
  it('非法 JSON body 取 trim 原文', () => {
    const r = extractTaskCompleteSignal('<task_complete>纯文本总结</task_complete>');
    expect(r).not.toBeNull();
    expect(r!.summary).toBe('纯文本总结');
  });
  it('无标签返回 null', () => {
    expect(extractTaskCompleteSignal('普通回复')).toBeNull();
  });
});

describe('shouldNudge', () => {
  it('空文本 → true（nudge）', () => {
    expect(shouldNudge('')).toBe(true);
  });
  it('含 task_complete → false（已完成）', () => {
    expect(shouldNudge('<task_complete>{"summary":"done"}</task_complete>')).toBe(false);
  });
  it('末尾有句末标点 → false（完整句）', () => {
    expect(shouldNudge('根据结果，文件共有 3 个。')).toBe(false);
  });
  it('末尾有 fenced 代码块 → false（交付物）', () => {
    expect(shouldNudge('结果如下：\n```\nfile1\nfile2\n```')).toBe(false);
  });
  it('承诺句（我接下来要调用...）→ true', () => {
    expect(shouldNudge('我接下来要调用 shell_exec 列出目录')).toBe(true);
  });
  it('完成标记（已创建）→ false', () => {
    expect(shouldNudge('已经创建了文件。')).toBe(false);
  });
  it('半句截断（无标点无承诺无交付）→ true', () => {
    expect(shouldNudge('正在读取文件内容然后')).toBe(true);
  });
});

describe('renderWindowedToolResults', () => {
  function mk(n: number, ok = true): PendingResult {
    return {
      invocationName: `tool_${n}`,
      ok,
      result: ok ? { stdout: `output ${n}` } : undefined,
      error: ok ? undefined : `err ${n}`,
    };
  }

  it('≤4 条全完整（含 detail/output）', () => {
    const r = renderWindowedToolResults([mk(1), mk(2)]);
    expect(r).toHaveLength(2);
    expect(r[0]).toHaveProperty('detail');
    expect(r[0]).toHaveProperty('output');
    expect(r[0].windowed).toBeFalsy();
  });

  it('>4 条：老的压缩（windowed:true，无 detail/output），最近 4 完整', () => {
    const execs = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)];
    const r = renderWindowedToolResults(execs);
    expect(r).toHaveLength(6);
    // 前 2 条压缩
    expect(r[0].windowed).toBe(true);
    expect(r[0].detail).toBeUndefined();
    expect(r[0].output).toBeUndefined();
    expect(r[1].windowed).toBe(true);
    // 最近 4 完整
    expect(r[2].windowed).toBeFalsy();
    expect(r[2]).toHaveProperty('detail');
    expect(r[5]).toHaveProperty('detail');
  });

  it('失败结果带 error 对象', () => {
    const r = renderWindowedToolResults([mk(1, false)]);
    expect(r[0].ok).toBe(false);
    expect(r[0].error).toBeDefined();
    expect(r[0].error!.message).toBe('err 1');
  });
});

describe('buildContinuationPrompt', () => {
  it('含 <original_task>、<tool_results>、工具目录', () => {
    const p = buildContinuationPrompt('审计 main.ts', [
      { invocationName: 'shell_exec', ok: true, result: { stdout: 'out' } },
    ], '## 可用工具\n- shell_exec');
    expect(p).toContain('<original_task>');
    expect(p).toContain('审计 main.ts');
    expect(p).toContain('</original_task>');
    expect(p).toContain('<tool_results>');
    expect(p).toContain('</tool_results>');
    expect(p).toContain('## 可用工具');
    expect(p).toContain('shell_exec');
  });

  it('有失败结果含 failureRecovery', () => {
    const p = buildContinuationPrompt('task', [
      { invocationName: 'shell_exec', ok: false, error: 'boom' },
    ]);
    expect(p).toContain('至少一个工具执行失败');
  });

  it('无失败结果不含 failureRecovery', () => {
    const p = buildContinuationPrompt('task', [
      { invocationName: 'shell_exec', ok: true, result: { stdout: 'ok' } },
    ]);
    expect(p).not.toContain('至少一个工具执行失败');
  });

  it('originalTask 超 8KB 被截断', () => {
    const big = 'x'.repeat(10_000);
    const p = buildContinuationPrompt(big, []);
    expect(p).toContain('...[truncated]');
    // 截断后 original_task 块内的 x 数量 ≤ 8000
    const block = p.slice(p.indexOf('<original_task>'), p.indexOf('</original_task>'));
    const xs = block.match(/x/g)?.length ?? 0;
    expect(xs).toBeLessThanOrEqual(8000);
  });
});

describe('buildNudgePrompt', () => {
  it('含 <original_task>、<previous_assistant_text>、<tool_results_so_far>、nudge 计数', () => {
    const p = buildNudgePrompt('原始任务', '上一轮回复', [
      { invocationName: 'shell_exec', ok: true, result: { stdout: 'out' } },
    ], 2);
    expect(p).toContain('<original_task>');
    expect(p).toContain('原始任务');
    expect(p).toContain('<previous_assistant_text>');
    expect(p).toContain('上一轮回复');
    expect(p).toContain('<tool_results_so_far>');
    expect(p).toContain('第 2 次无工具调用纠偏');
  });
});
