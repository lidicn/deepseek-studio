/**
 * TaskLoop 快照恢复测试（M4-C）
 *
 * 验证：跑一轮 → store.save → 新 loop 从 store.load → history 恢复。
 */

import { describe, expect, it } from 'vitest';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import type { ModelEngine, EngineSendResult } from '../../src/host/engine/model-engine';

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

function makeResult(content: string): EngineSendResult {
  return { content, toolCalls: 0, toolCallRecords: [] } as EngineSendResult;
}

import type { PersistedLoopState } from '../../src/host/kernel/history-store';

describe('TaskLoop 快照恢复', () => {
  it('跑一轮 → save → 新 loop load → history 恢复', async () => {
    // 内存 store
    let saved: PersistedLoopState | null = null;
    const memStore = {
      async load() { return saved; },
      async save(snap: typeof saved) { saved = snap; },
    };

    // 第一轮：用户说"你好"，模型回"你好！"
    const engine1 = scriptedEngine([makeResult('你好！')]);
    const history1 = createMessageHistory();
    const loop1 = createTaskLoop({ engine: engine1, history: history1, maxRounds: 1, store: memStore });
    await loop1.run('你好');

    expect(saved).not.toBeNull();
    expect(saved!.round).toBe(1);

    // 第二轮：新 loop，从 store 恢复 history，继续对话
    const engine2 = scriptedEngine([makeResult('再见！')]);
    const history2 = createMessageHistory();
    const loop2 = createTaskLoop({ engine: engine2, history: history2, maxRounds: 1, store: memStore });
    await loop2.run('拜拜');

    // history2 应该有：第一轮的 user+assistant + 第二轮的 user+assistant
    const all = history2.all();
    expect(all.length).toBeGreaterThanOrEqual(3); // 第一轮 user+assistant + 第二轮 user
  });
});
