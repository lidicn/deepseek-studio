import { describe, expect, it } from 'vitest';

import { createTaskLoop } from '../../src/host/kernel/task-loop';
import type { TaskLoopRoundResult } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import type { EngineSendResult, ModelEngine, ToolCallRecord } from '../../src/host/engine/model-engine';

/** 假引擎：按脚本依次返回结果，不碰真 WebEngine；calls 记录 send 次数。 */
function fakeEngine(scripted: EngineSendResult[]): ModelEngine & { calls: number } {
  let i = 0;
  const engine = {
    name: 'web' as const,
    calls: 0,
    async health() {
      return { ok: true };
    },
    async send(_text: string): Promise<EngineSendResult> {
      const r = scripted[Math.min(i, scripted.length - 1)];
      i += 1;
      engine.calls += 1;
      return r;
    },
  };
  return engine;
}

function rec(tool: string, ok: boolean, error?: string): ToolCallRecord {
  return { tool, ok, ...(error !== undefined ? { error } : {}) };
}

describe('TaskLoop 自驱（M2-3）', () => {
  it('1. toolCalls:3 + toolCallRecords:[3条] → history 多 1 assistant + 3 tool', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      {
        content: '已读文件',
        toolCalls: 3,
        toolCallRecords: [rec('local_file_read', true), rec('shell_exec', true), rec('local_file_write', false, 'denied')],
      },
    ]);
    const loop = createTaskLoop({ engine, history });

    await loop.run('读一下配置');

    expect(history.byRole('assistant')).toHaveLength(1);
    expect(history.byRole('tool')).toHaveLength(3);
    expect(history.byRole('tool').map((m) => m.toolCallId)).toEqual([
      'local_file_read',
      'shell_exec',
      'local_file_write',
    ]);
  });

  it('2. toolCalls:0 → stopReason === no-tool-calls', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '你好，有什么可以帮你？', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });

    const r = await loop.run('hi');
    expect(r.stopReason).toBe('no-tool-calls');
  });

  it('3. timedOut:true → stopReason === timeout', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '半截…', toolCalls: 1, timedOut: true }]);
    const loop = createTaskLoop({ engine, history });

    const r = await loop.run('做个长任务');
    expect(r.stopReason).toBe('timeout');
  });

  it('4. toolCallRecords 为 undefined 但 toolCalls:2 → 不崩', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '跑了两个工具', toolCalls: 2 }]);
    const loop = createTaskLoop({ engine, history });

    const r = await loop.run('跑两个');
    expect(r.toolCalls).toBe(2);
    expect(r.toolCallRecords).toBeUndefined();
    expect(history.byRole('tool')).toHaveLength(0);
  });

  it('5. 连续两次 run() → history 累积（不覆盖）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '第一轮答', toolCalls: 0 },
      { content: '第二轮答', toolCalls: 0 },
    ]);
    const loop = createTaskLoop({ engine, history });

    await loop.run('第一条');
    await loop.run('第二条');

    expect(history.byRole('user')).toHaveLength(2);
    expect(history.byRole('assistant')).toHaveLength(2);
  });

  it('6. history.snapshot() 能取到回填后的完整状态', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      {
        content: '干完了',
        toolCalls: 1,
        toolCallRecords: [rec('shell_exec', true)],
      },
    ]);
    const loop = createTaskLoop({ engine, history });

    await loop.run('列目录');

    const snap = history.snapshot();
    expect(snap.version).toBe(1);
    // user + assistant + tool
    expect(snap.messages).toHaveLength(3);
    expect(snap.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('7. run() 返回形状：round/content/toolCalls/stopReason 齐全', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '最终回答', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });

    const r: TaskLoopRoundResult = await loop.run('Q');
    expect(r.round).toBe(1);
    expect(r.content).toBe('最终回答');
    expect(r.toolCalls).toBe(0);
    expect(r.stopReason).toBe('no-tool-calls');
  });

  it('8. 工具失败记录回填 error 文案', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '试了', toolCalls: 1, toolCallRecords: [rec('shell_exec', false, 'exit 1')] },
    ]);
    const loop = createTaskLoop({ engine, history });

    await loop.run('跑命令');
    const toolMsgs = history.byRole('tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain('shell_exec');
    expect(toolMsgs[0].content).toContain('exit 1');
  });

  it('9. maxRounds:2 跑两轮，第二轮 toolCalls:0 终停', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '先调工具', toolCalls: 1, toolCallRecords: [rec('shell_exec', true)] },
      { content: '收尾', toolCalls: 0 },
    ]);
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    const r = await loop.run('多步任务');
    expect(r.round).toBe(2);
    expect(r.stopReason).toBe('no-tool-calls');
    expect(history.byRole('assistant')).toHaveLength(2);
  });

  it('10. 内容含 <task_complete> → stopReason === completed（复用 extractTaskCompleteSignal）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '<task_complete>{"summary":"全做完了"}</task_complete>', toolCalls: 0 },
    ]);
    const loop = createTaskLoop({ engine, history });

    const r = await loop.run('收工');
    expect(r.stopReason).toBe('completed');
  });

  it('11. 跑满 maxRounds 仍有工具调用 → 终态 max-rounds', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '还要继续调工具', toolCalls: 1, toolCallRecords: [rec('a', true)] },
      { content: '还在调', toolCalls: 1, toolCallRecords: [rec('b', true)] },
    ]);
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    const r = await loop.run('死循环任务');
    expect(r.round).toBe(2);
    expect(r.stopReason).toBe('max-rounds');
  });

  it('12. 每轮都把 user 落库后再 send', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '答', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });

    await loop.run('用户原话');
    const users = history.byRole('user');
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe('用户原话');
  });

  it('13. S2：第 2 轮命中 no-tool-calls 立刻停，不跑第 3 轮', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '第一轮调工具', toolCalls: 1, toolCallRecords: [rec('a', true)] },
      { content: '第二轮收尾', toolCalls: 0 },
    ]);
    const loop = createTaskLoop({ engine, history, maxRounds: 3 });

    const r = await loop.run('多步');
    expect(r.round).toBe(2);
    expect(r.stopReason).toBe('no-tool-calls');
    expect(engine.calls).toBe(2); // 没跑第 3 轮
  });

  it('14. S2：默认 maxRounds=1 只发一次', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '答', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });

    await loop.run('hi');
    expect(engine.calls).toBe(1);
    expect(history.byRole('assistant')).toHaveLength(1);
  });

  it('15. S2：跨轮工具记录累积（第 1、2 轮的 tool 都落库）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '轮1', toolCalls: 1, toolCallRecords: [rec('shell_exec', true)] },
      { content: '轮2', toolCalls: 1, toolCallRecords: [rec('local_file_read', true)] },
    ]);
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    await loop.run('多步');
    expect(history.byRole('tool')).toHaveLength(2);
    expect(history.byRole('tool').map((m) => m.toolCallId)).toEqual(['shell_exec', 'local_file_read']);
  });

  it('16. S2：每轮 assistant 都落库（轮数 = assistant 数）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: 'a1', toolCalls: 1, toolCallRecords: [rec('a', true)] },
      { content: 'a2', toolCalls: 0 },
    ]);
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    await loop.run('x');
    expect(history.byRole('assistant')).toHaveLength(2);
  });

  it('17. S2：连续工具调用跑满 maxRounds=3，终态 max-rounds、round=3', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: 'r1', toolCalls: 1, toolCallRecords: [rec('a', true)] },
      { content: 'r2', toolCalls: 1, toolCallRecords: [rec('b', true)] },
      { content: 'r3', toolCalls: 1, toolCallRecords: [rec('c', true)] },
    ]);
    const loop = createTaskLoop({ engine, history, maxRounds: 3 });

    const r = await loop.run('死循环');
    expect(r.round).toBe(3);
    expect(r.stopReason).toBe('max-rounds');
    expect(engine.calls).toBe(3);
  });

  it('18. S2：第 1 轮就 completed，循环立即退出', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '<task_complete>{"summary":"done"}</task_complete>', toolCalls: 0 },
      { content: '不该被调用', toolCalls: 0 },
    ]);
    const loop = createTaskLoop({ engine, history, maxRounds: 3 });

    const r = await loop.run('收工');
    expect(r.round).toBe(1);
    expect(r.stopReason).toBe('completed');
    expect(engine.calls).toBe(1);
  });

  it('19. S4：content 为空 + toolCalls:0 → empty-response', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });
    const r = await loop.run('空回复');
    expect(r.stopReason).toBe('empty-response');
  });

  it('20. S4：空白字符串 content + toolCalls:0 → empty-response', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '   \n  ', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });
    const r = await loop.run('空白');
    expect(r.stopReason).toBe('empty-response');
  });

  it('21. S4：content 非空 + toolCalls:0 → no-tool-calls（不被误判 empty）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '你好', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });
    const r = await loop.run('hi');
    expect(r.stopReason).toBe('no-tool-calls');
  });

  it('22. S4：empty-response 不崩 history 回填', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });
    await loop.run('x');
    expect(history.byRole('user')).toHaveLength(1);
    expect(history.byRole('assistant')).toHaveLength(1);
    expect(history.byRole('assistant')[0].content).toBe('');
  });

  it('23. S4：timeout 优先级最高（即使 content 空且 toolCalls:0）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: '', toolCalls: 0, timedOut: true }]);
    const loop = createTaskLoop({ engine, history });
    const r = await loop.run('t');
    expect(r.stopReason).toBe('timeout');
  });

  it('24. S4：completed 优先于 empty-response（content 空但含 task_complete）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([
      { content: '<task_complete>{"summary":"x"}</task_complete>', toolCalls: 0 },
    ]);
    const loop = createTaskLoop({ engine, history });
    const r = await loop.run('c');
    expect(r.stopReason).toBe('completed');
  });

  it('25. S5：引擎抛错 → run() reject，user 已落库、assistant 未落', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([]);
    (engine as unknown as { send: () => Promise<never> }).send = async () => {
      throw new Error('network down');
    };
    const loop = createTaskLoop({ engine, history });

    await expect(loop.run('x')).rejects.toThrow(/round 1/);
    expect(history.byRole('user')).toHaveLength(1);
    expect(history.byRole('assistant')).toHaveLength(0);
  });

  it('26. S5：抛出的错带 round 号（TaskLoopError.round）', async () => {
    const history = createMessageHistory();
    let n = 0;
    const engine: ModelEngine = {
      name: 'web',
      async health() { return { ok: true }; },
      async send(): Promise<EngineSendResult> {
        n += 1;
        if (n === 1) return { content: '轮1', toolCalls: 1, toolCallRecords: [rec('a', true)] };
        throw new Error('boom');
      },
    };
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    const err = await loop.run('multi').catch((e) => e);
    expect(err.round).toBe(2);
    expect(err.name).toBe('TaskLoopError');
  });

  it('27. S5：抛错前成功的轮次记录保留', async () => {
    const history = createMessageHistory();
    let n = 0;
    const engine: ModelEngine = {
      name: 'web',
      async health() { return { ok: true }; },
      async send(): Promise<EngineSendResult> {
        n += 1;
        if (n === 1) return { content: '轮1答', toolCalls: 1, toolCallRecords: [rec('shell_exec', true)] };
        throw new Error('boom');
      },
    };
    const loop = createTaskLoop({ engine, history, maxRounds: 2 });

    await loop.run('multi').catch(() => {});
    // 轮1 的 assistant 与 tool 都应在
    expect(history.byRole('assistant')).toHaveLength(1);
    expect(history.byRole('tool')).toHaveLength(1);
    // 轮2 没落 assistant
    expect(history.byRole('assistant').map((m) => m.content)).toEqual(['轮1答']);
  });

  it('28. S5：抛错后重 run() 不崩溃（可重试）', async () => {
    const history = createMessageHistory();
    let failOnce = true;
    const engine = fakeEngine([{ content: '最终答', toolCalls: 0 }]);
    (engine as unknown as { send: () => Promise<unknown> }).send = async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      return { content: '最终答', toolCalls: 0 };
    };
    const loop = createTaskLoop({ engine, history });

    await expect(loop.run('first')).rejects.toThrow();
    const r = await loop.run('retry');
    expect(r.stopReason).toBe('no-tool-calls');
  });

  it('29. S5：TaskLoopError 带 cause', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([]);
    const cause = new Error('underlying');
    (engine as unknown as { send: () => Promise<never> }).send = async () => {
      throw cause;
    };
    const loop = createTaskLoop({ engine, history });

    const err = await loop.run('x').catch((e) => e);
    expect(err.cause).toBe(cause);
  });

  it('30. S5：正常路径不受影响（回归）', async () => {
    const history = createMessageHistory();
    const engine = fakeEngine([{ content: 'ok', toolCalls: 0 }]);
    const loop = createTaskLoop({ engine, history });
    const r = await loop.run('hi');
    expect(r.stopReason).toBe('no-tool-calls');
    expect(history.size()).toBe(2);
  });
});
