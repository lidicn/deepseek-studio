import { describe, expect, it } from 'vitest';
import { requireTaskLoopReply, TaskLoopReplyError } from '../../src/host/kernel/task-loop';

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

  it('空正文明确抛错', () => {
    expect(() => requireTaskLoopReply({ round: 1, content: '   ', toolCalls: 0 })).toThrow(/empty-response/);
  });
});
