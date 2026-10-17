import { describe, expect, it } from 'vitest';

import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import type { EngineSendResult, ModelEngine, ToolCallRecord } from '../../src/host/engine/model-engine';

/**
 * S6 端到端：模拟一个 shell_exec 工具回合全程不需要页端 nudge。
 * 序列：
 *   轮1：用户问 → 引擎回「要跑 shell_exec」(toolCalls=1, record)
 *   轮2：引擎给最终答案（task_complete）
 * 断言：history 增长正确、stopReason=completed、全程无 nudge 中间态。
 */
function rec(tool: string, ok: boolean): ToolCallRecord {
  return { tool, ok };
}

describe('S6 端到端：无 nudge 完成一个工具回合', () => {
  it('完整回合：用户问 → 工具执行 → 回填 → 最终答案，stopReason=completed', async () => {
    const history = createMessageHistory();
    const calls: string[] = [];
    let n = 0;
    const engine: ModelEngine = {
      name: 'web',
      async health() {
        return { ok: true };
      },
      async send(_text: string): Promise<EngineSendResult> {
        n += 1;
        calls.push(_text);
        if (n === 1) {
          // 模型决定调用工具
          return {
            content: '让我先跑一下 ls',
            toolCalls: 1,
            toolCallRecords: [rec('shell_exec', true)],
          };
        }
        // 模型给最终答案
        return {
          content: '<task_complete>{"summary":"ls 结果如下…"}</task_complete>',
          toolCalls: 0,
        };
      },
    };

    const loop = createTaskLoop({ engine, history, maxRounds: 3 });
    const r = await loop.run('列一下当前目录');

    // 终态
    expect(r.stopReason).toBe('completed');
    expect(r.round).toBe(2);

    // history：user → assistant → tool → assistant
    const roles = history.all().map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // tool 记录被回填
    const toolMsgs = history.byRole('tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].toolCallId).toBe('shell_exec');

    // 关键 D1 证据：全程只发了 2 次 send（一轮工具 + 一轮收尾），
    // 中间没有任何「发提示词逼模型继续」的 nudge 步骤。
    expect(calls).toHaveLength(2);
  });

  it('工具失败也能闭环（不卡死在 nudge）', async () => {
    const history = createMessageHistory();
    let n = 0;
    const engine: ModelEngine = {
      name: 'web',
      async health() {
        return { ok: true };
      },
      async send(): Promise<EngineSendResult> {
        n += 1;
        if (n === 1) {
          return {
            content: '跑一下',
            toolCalls: 1,
            toolCallRecords: [rec('shell_exec', false)],
          };
        }
        return { content: '<task_complete>{"summary":"失败但收尾了"}</task_complete>', toolCalls: 0 };
      },
    };

    const loop = createTaskLoop({ engine, history, maxRounds: 3 });
    const r = await loop.run('跑个命令');

    expect(r.stopReason).toBe('completed');
    expect(history.byRole('tool')).toHaveLength(1);
    expect(history.byRole('tool')[0].content).toContain('failed');
  });
});
