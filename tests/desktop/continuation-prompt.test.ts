/**
 * continuation-prompt.test.ts — 续跑/nudge prompt 构建器单测（v1.6）
 *
 * 纯函数测试，无 DOM / 运行时依赖。验证移植自 deepseek-pp prompt.ts 的核心逻辑。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildContinuationPrompt,
  buildProtocolRepairPrompt,
  shouldAttemptProtocolRepair,
  shouldNudge,
  extractTaskCompleteSignal,
  renderWindowedToolResults,
  clampText,
  MAX_LOOP,
  FULL_TOOL_RESULT_WINDOW,
  type PendingResult,
} from '../../src/shared/continuation-prompt';

describe('continuation-prompt —— 常量', () => {
  it('MAX_LOOP 对齐 deepseek-pp 的 25 步', () => {
    expect(MAX_LOOP).toBe(25);
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

describe('shouldAttemptProtocolRepair', () => {
  const executions: PendingResult[] = [
    { invocationName: 'shell_exec', ok: true, result: { stdout: 'out' } },
  ];

  it('有工具结果且回复不完整时允许修复', () => {
    expect(shouldAttemptProtocolRepair('我接下来要调用 shell_exec 列出目录', executions, false)).toBe(true);
  });

  it('已经修复过时不再允许', () => {
    expect(shouldAttemptProtocolRepair('我接下来要调用 shell_exec 列出目录', executions, true)).toBe(false);
  });

  it('含 task_complete 时不再允许', () => {
    expect(
      shouldAttemptProtocolRepair(
        '<task_complete>{"summary":"done"}</task_complete>',
        executions,
        false,
      ),
    ).toBe(false);
  });

  it('没有工具执行结果时不允许', () => {
    expect(shouldAttemptProtocolRepair('我接下来要调用 shell_exec 列出目录', [], false)).toBe(false);
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

describe('buildProtocolRepairPrompt', () => {
  const executions: PendingResult[] = [
    { invocationName: 'shell_exec', ok: true, result: { stdout: 'out-123' } },
  ];

  it('包含原始任务、工具结果、XML 语法与完成信号', () => {
    const p = buildProtocolRepairPrompt('审计 main.ts', executions, '## 可用工具\n- shell_exec');
    expect(p).toContain('<original_task>');
    expect(p).toContain('审计 main.ts');
    expect(p).toContain('<tool_results>');
    expect(p).toContain('out-123');
    expect(p).toContain('XML 工具标签');
    expect(p).toContain('<task_complete>');
    expect(p).toContain('shell_exec');
  });

  it('明确禁止伪 JSON 与 Markdown 包裹工具标签', () => {
    const p = buildProtocolRepairPrompt('task', executions);
    expect(p).toContain('禁止输出伪工具调用 JSON');
    expect(p).toContain('Markdown 代码块包裹的工具标签');
  });

  it('提示文案直接写正确，不依赖运行时替换', () => {
    const p = buildProtocolRepairPrompt('task', executions);
    expect(p).toContain('或“点击继续”之类要求用户操作的文本。');
    expect(p).not.toContain('或“继续操作”之类要求用户操作的文本。');
    expect(p).toContain('请现在继续操作。');
  });
});

// ---------------------------------------------------------------- R4-N6 移植（2026-11-14）
/**
 * 上游 `core/inline-agent/prompt.ts` 两项移植，由 drift 定性卡判「缺上游修复」：
 *   ① 围栏**奇偶**（上游 L149-153）：`includes('```')` 会把「写到一半被截断的未闭合
 *      代码块」（``` 奇数次）也判成"有交付物 ⇒ 完成"，于是不 nudge、用户拿到半截代码；
 *   ② 英文动词表补齐（上游 L6）：examine/explore/scan/find/grep/cat/diff/trace/dump/
 *      print/view/see/display —— 本地一个都没有，这些动词的"承诺后未执行"抓不到。
 *
 * 判别力设计（重要，别改成"看起来更顺"的写法）：
 *   - 围栏用例：偶数 → false，**奇数 → true**（旧实现一律 false ⇒ 奇数这条红）；
 *   - 动词用例一律带**句末标点**（`'I will grep the logs.'`）：有动词命中 → pending 先命中 →
 *     true；没有动词 → 落到句末标点 → false。**这才是能分辨"动词表补没补"的形态**；
 *     写成不带标点的句子会走默认真值分支，前后都 true，等于假绿。
 *   - 词边界用例：`indicate` 里含 `cat` 子串，裸写 `cat` 会误命中 ⇒ 必须 false。
 */
describe('R4-N6 围栏奇偶：未闭合代码块不许判完成', () => {
  it('偶数围栏（已闭合交付物）→ 不续跑', () => {
    expect(shouldNudge('结论如下：\n```ts\nconst a = 1;\n```')).toBe(false);
    // 两段闭合 = 4 个围栏
    expect(shouldNudge('先看第一段：\n```a```\n再看第二段：\n```b```')).toBe(false);
  });

  it('奇数围栏（写到一半被截断）→ 继续判定，最终续跑', () => {
    expect(shouldNudge('我来写：\n```ts\nconst a = 1;')).toBe(true);
  });

  it('未闭合围栏 + 句末标点 → 仍判完成（与上游同构，不越界收紧）', () => {
    // 上游同样只在"偶数"时 return false；奇数交给后面的 pending/完成判定。
    expect(shouldNudge('```ts\n// 半截。')).toBe(false);
  });

  it('围栏落在决策窗口（尾 600 字符）之外 → 不参与判定', () => {
    // 决策窗口只看 `getNudgeDecisionText` 的尾部 600 字符：把已闭合围栏推到窗口外，
    // 它就不该再把整段判成"交付物完成"。这条锁的是"窗口边界"，不是"围栏位置好看"。
    const text = '```ts\nconst a = 1;\n```\n' + '继续排查的细节说明'.repeat(120);
    expect(text.slice(-600).includes('```')).toBe(false);
    expect(shouldNudge(text)).toBe(true);
  });
});

describe('R4-N6 英文动词表补齐（保持 \\b 词边界）', () => {
  const verbs = ['examine', 'explore', 'scan', 'find', 'grep', 'cat', 'diff', 'trace', 'dump', 'print', 'view', 'see', 'display'];
  for (const verb of verbs) {
    it(`I will ${verb} … → 承诺后未执行 ⇒ 续跑`, () => {
      // 带句末标点：只有"动词命中"才能把它从 false 拉回 true（见测试头注释的判别力设计）
      expect(shouldNudge(`I will ${verb} the logs.`)).toBe(true);
    });
  }

  it('词边界：`indicate` 里的 cat 子串不许误命中', () => {
    expect(shouldNudge('I will indicate the reason.')).toBe(false);
  });

  it('源码锁：新动词必须带 \\b…\\b，不许裸写 cat/find', () => {
    const src = readFileSync('src/shared/continuation-prompt.ts', 'utf8');
    for (const verb of ['examine', 'explore', 'scan', 'find', 'grep', 'cat', 'diff', 'trace', 'dump', 'print', 'view', 'see', 'display']) {
      // 末尾动词后面跟的是 `)` 而不是 `|`，所以只断言 \bverb\b 本身
      expect(src).toContain(`\\b${verb}\\b`);
    }
    // 裸写形态（前后无 \b）不允许出现
    expect(src).not.toContain('|cat|');
    expect(src).not.toContain('|find|');
  });
});
