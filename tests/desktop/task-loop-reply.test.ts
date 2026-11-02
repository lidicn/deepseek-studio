import { describe, expect, it } from 'vitest';
import { requireTaskLoopReply, TaskLoopReplyError } from '../../src/host/kernel/task-loop';

/**
 * TaskLoop 成功回复校验（契约锁）。
 *
 * M1-C 变更（20261102）：终态集合新增 `'interrupted'`。
 *
 * **为什么必须改这个契约锁**：本文件是「哪些终态不得伪装成成功回复」的**唯一权威锁**。
 * `interrupted` 的语义是「页面侧确认流被截断、模型自己没答完」——
 * 它的**内容可能非空**（模型答了一半），所以它**绝不能**靠「content 为空」那条老规则被发现。
 * 漏掉它 = 「回答没说完」会作为成功回复返回给用户，正是 M1-C 要根治的缺陷。
 */
describe('TaskLoop 成功回复校验', () => {
  it('有正文且非失败终态时原样返回', () => {
    expect(requireTaskLoopReply({ round: 1, content: '结论', toolCalls: 0, stopReason: 'no-tool-calls' })).toBe('结论');
  });

  it.each(['empty-response', 'timeout', 'aborted', 'max-rounds'] as const)(
    '%s 即使带部分正文也不能伪装成成功',
    (stopReason) => {
      expect(() => requireTaskLoopReply({ round: 1, content: '半截正文', toolCalls: 0, stopReason }))
        .toThrow(TaskLoopReplyError);
    },
  );

  // M1-C 新增：interrupted 进入失败终态清单。
  // 关键断言：**带非空正文也必须抛错**（模型可能已答了一半，内容非空不代表答完）。
  it.each(['interrupted'] as const)(
    '%s 即使带非空正文也不能伪装成成功（内容非空 ≠ 答完）',
    (stopReason) => {
      expect(() => requireTaskLoopReply({ round: 1, content: '模型答了一半就断了', toolCalls: 0, stopReason }))
        .toThrow(TaskLoopReplyError);
    },
  );

  it('interrupted 的错误详情带上终态名（便于排障区分 timeout / interrupted）', () => {
    expect(() => requireTaskLoopReply({ round: 1, content: '半截', toolCalls: 0, stopReason: 'interrupted' }))
      .toThrow(/interrupted/);
  });

  it('空正文明确抛错', () => {
    expect(() => requireTaskLoopReply({ round: 1, content: '   ', toolCalls: 0 })).toThrow(/empty-response/);
  });
});
