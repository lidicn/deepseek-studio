/**
 * M1-C 回归测试：终态语义拆分 —— `interrupted`（页面侧截断） vs `timeout`（宿主侧砍）。
 *
 * 缺陷（M1 主线，用户已批）：原先把两件事混成一件：
 *   - `truncated` 是「宿主看门狗超时主动砍」的语义化别名；
 *   - 页面侧流提前结束（模型吐到一半断了、**没见到完成哨兵**）**没有任何终态**能表达
 *     → 宿主把「回答没说完」当成**正常完成**返回给用户。
 *
 * 本文件锁四件事：
 *   1. `decideCompletion`：`sawFinishSentinel === false` + 有可见输出 → `'interrupted'`；
 *   2. **三态严格性**：`undefined`（页面侧不知道）**绝不能**当 `false`；
 *   3. **回滚开关** `STUDIO_TERM_STRICT=0` → 不判 `interrupted`（回退到改动前行为）；
 *   4. 任务层：`completion='interrupted'` → 独立终态 `'interrupted'`，
 *      且**带非空正文也必须失败**（模型可能已答一半）。
 */
import { describe, it, expect } from 'vitest';
import { decideCompletion, readStrictTermFlag } from '../../src/host/engine/web-engine';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { requireTaskLoopReply, TaskLoopReplyError } from '../../src/host/kernel/task-loop';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';
import { createMessageHistory } from '../../src/host/kernel/message-history';

describe('M1-C：decideCompletion 的 interrupted 判据', () => {
  it('页面明确说「无哨兵」且有可见输出 → interrupted', () => {
    expect(
      decideCompletion({
        timedOut: false,
        dispatchFailed: false,
        stopped: false,
        sawFinishSentinel: false,
        hasVisibleOutput: true,
      }),
    ).toBe('interrupted');
  });

  it('页面说「有哨兵」→ complete（不判 interrupted）', () => {
    expect(
      decideCompletion({
        timedOut: false,
        dispatchFailed: false,
        stopped: false,
        sawFinishSentinel: true,
        hasVisibleOutput: true,
      }),
    ).toBe('complete');
  });

  it('页面「不知道」（undefined）→ 不判 interrupted（老页面兼容）', () => {
    expect(
      decideCompletion({
        timedOut: false,
        dispatchFailed: false,
        stopped: false,
        sawFinishSentinel: undefined,
        hasVisibleOutput: true,
      }),
    ).toBe('complete');
  });

  it('完全没传 sawFinishSentinel（缺省）→ 不判 interrupted', () => {
    expect(decideCompletion({ timedOut: false, dispatchFailed: false, stopped: false })).toBe('complete');
  });

  it('无哨兵但**空流**（无可见输出）→ 不判 interrupted（那是「什么都没拿到」）', () => {
    expect(
      decideCompletion({
        timedOut: false,
        dispatchFailed: false,
        stopped: false,
        sawFinishSentinel: false,
        hasVisibleOutput: false,
      }),
    ).toBe('complete');
  });

  it('优先级：dispatchFailed > timedOut > interrupted > stopped', () => {
    // 页不可达 → disconnected（哪怕也说无哨兵）
    expect(
      decideCompletion({
        timedOut: true,
        dispatchFailed: true,
        stopped: false,
        sawFinishSentinel: false,
        hasVisibleOutput: true,
      }),
    ).toBe('disconnected');
    // 宿主超时 → truncated（哪怕也说无哨兵）
    expect(
      decideCompletion({
        timedOut: true,
        dispatchFailed: false,
        stopped: false,
        sawFinishSentinel: false,
        hasVisibleOutput: true,
      }),
    ).toBe('truncated');
    // 用户主动停 → unknown（哪怕也说无哨兵）
    expect(
      decideCompletion({
        timedOut: false,
        dispatchFailed: false,
        stopped: true,
        sawFinishSentinel: false,
        hasVisibleOutput: true,
      }),
    ).toBe('unknown');
  });
});

describe('M1-C：回滚开关 STUDIO_TERM_STRICT', () => {
  it('未设置 → 严格（开）', () => {
    expect(readStrictTermFlag({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it('关闭值：0 / false / off / no（忽略大小写与空白）', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' False ', 'No']) {
      expect(readStrictTermFlag({ STUDIO_TERM_STRICT: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it('其它值（含 1 / 空串 / 乱值）→ 严格（缺省偏向严格）', () => {
    for (const v of ['1', '', '  ', 'yes', 'maybe']) {
      expect(readStrictTermFlag({ STUDIO_TERM_STRICT: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it('开关关闭 → decideCompletion 不判 interrupted（回退到改动前行为）', () => {
    expect(
      decideCompletion({
        timedOut: false,
        dispatchFailed: false,
        stopped: false,
        sawFinishSentinel: false,
        hasVisibleOutput: true,
        strictTerm: false,
      }),
    ).toBe('complete');
  });

  it('开关关闭时，timeout 优先级不受影响（回滚只关 interrupted 一项）', () => {
    expect(
      decideCompletion({
        timedOut: true,
        dispatchFailed: false,
        stopped: false,
        sawFinishSentinel: false,
        hasVisibleOutput: true,
        strictTerm: false,
      }),
    ).toBe('truncated');
  });
});

describe('M1-C：任务层把 interrupted 传到底', () => {
  function fakeEngine(result: EngineSendResult): ModelEngine {
    return {
      name: 'web',
      health: async () => ({ ok: true }),
      send: async () => result,
    };
  }

  it('引擎报 completion=interrupted → 终态 stopReason=interrupted', async () => {
    const engine = fakeEngine({
      content: '模型答了一半',
      toolCalls: 0,
      completion: 'interrupted',
      sawFinishSentinel: false,
    });
    const loop = createTaskLoop({ engine, history: createMessageHistory() });
    const r = await loop.run('测试');
    expect(r.stopReason).toBe('interrupted');
    // 内容非空也**不得**作为成功回复返回。
    expect(() => requireTaskLoopReply(r)).toThrow(TaskLoopReplyError);
  });

  it('引擎报 completion=complete → 不受影响（未回归）', async () => {
    const engine = fakeEngine({
      content: '完整回答 <task_complete>done</task_complete>',
      toolCalls: 0,
      completion: 'complete',
    });
    const loop = createTaskLoop({ engine, history: createMessageHistory() });
    const r = await loop.run('测试');
    expect(r.stopReason).toBe('completed');
    expect(requireTaskLoopReply(r)).toContain('完整回答');
  });

  it('引擎报 completion=truncated（宿主超时）→ 仍是 timeout（未回归）', async () => {
    const engine = fakeEngine({
      content: '',
      toolCalls: 0,
      completion: 'truncated',
      timedOut: true,
    });
    const loop = createTaskLoop({ engine, history: createMessageHistory() });
    const r = await loop.run('测试');
    expect(r.stopReason).toBe('timeout');
  });
});
