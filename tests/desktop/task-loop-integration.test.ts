/**
 * TaskLoop 集成测试（M4-B 前置）
 *
 * 用假引擎跑完整工具回合，确认内核链路通。
 * 不碰生产主路径（agent-loop.ts / desktop-host.ts）。
 */

import { describe, expect, it } from 'vitest';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import type { ModelEngine, EngineSendResult, ToolCallRecord } from '../../src/host/engine/model-engine';

/** 假引擎：按脚本依次返回预设结果。 */
function scriptedEngine(script: EngineSendResult[]): ModelEngine {
  let calls = 0;
  return {
    name: 'web',
    async send(): Promise<EngineSendResult> {
      const i = calls++;
      return script[Math.min(i, script.length - 1)];
    },
    health: async () => ({ ok: true }),
  };
}

function makeResult(content: string, toolCallRecords?: ToolCallRecord[]): EngineSendResult {
  return { content, toolCalls: toolCallRecords?.length ?? 0, toolCallRecords } as EngineSendResult;
}

describe('TaskLoop 集成', () => {
  it('场景1：单轮无工具调用 → stopReason=no-tool-calls', async () => {
    const engine = scriptedEngine([makeResult('你好，有什么可以帮你？')]);
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine, history, maxRounds: 5 });

    const result = await loop.run('你好');
    expect(result.stopReason).toBe('no-tool-calls');
    expect(result.round).toBe(1);
  });

  it('场景2：工具调用 + task_complete → stopReason=completed', async () => {
    const engine = scriptedEngine([
      makeResult('让我先读个文件', [{ tool: 'file.read', ok: true }]),
      makeResult('好的，文件读完了<task_complete>done</task_complete>'),
    ]);
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine, history, maxRounds: 5 });

    const result = await loop.run('读一下文件');
    expect(result.stopReason).toBe('completed');
  });

  it('场景3：跑满 maxRounds → stopReason=max-rounds', async () => {
    const engine = scriptedEngine([
      makeResult('继续调工具', [{ tool: 'shell.exec', ok: true }]),
      makeResult('继续调工具', [{ tool: 'shell.exec', ok: true }]),
      makeResult('继续调工具', [{ tool: 'shell.exec', ok: true }]),
    ]);
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    const result = await loop.run('跑个命令');
    expect(result.stopReason).toBe('max-rounds');
    expect(result.round).toBe(2);
  });
});
