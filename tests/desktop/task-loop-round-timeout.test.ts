// @vitest-environment node
/**
 * N2-04（P3）：轮超时**不能只放弃等待**。
 *
 * 缺陷本体：`roundTimeoutMs` 到点只是让 `await` 抛 `RoundTimeoutError`，
 * **在途的 `engine.send` 照样跑完** —— 「只加 Promise.race」正是缺陷本身：
 * 迟到的回复/错误既没被取消，也没有任何地方记录它被丢弃。
 *
 * 引擎签名结论（先读后写，不假设）：`ModelEngine.send(text)` / `waitForNextReply()`
 * 原本**都不吃 `signal`**。本次给两者补了可选 `signal`（additive，不强迫老实现改签名），
 * 并由内核每轮传一个内部 `AbortController.signal`；同时用**轮次 generation token**
 * 兜住「引擎忽略 signal」的情况：迟到的 resolve/reject 一律丢弃并留一行诊断。
 *
 * 本文件的判据：
 *   ① 每轮把 signal 传给引擎，超时后该 signal 必须 `aborted`；
 *   ② 迟到的 resolve 不进 history、不触发 onDelta，且**有一条诊断**；
 *   ③ 迟到的 reject 不许变成 unhandledRejection（现代 Node 默认直接抛崩）；
 *   ④ 未超时的正常路径逐字节不变；
 *   ⑤ 上一次 run 的迟到回复不许混进下一次 run 的 history；
 *   ⑥ web 引擎真吃 signal：进函数即已 abort → 对页面零副作用；轮询中被 abort → 立刻收尾。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskLoop, type TaskLoopDiagnostic } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function okResult(data?: unknown): ExecuteResult {
  return { ok: true, data } as ExecuteResult;
}

/** 会记录收到的 signal 的假引擎：`delayMs` 后才给出结果（或抛错）。 */
function slowEngine(opts: {
  delayMs: number;
  content?: string;
  reject?: boolean;
  secondRunImmediate?: string;
}): { engine: ModelEngine; signals: Array<AbortSignal | undefined>; calls: number[] } {
  const signals: Array<AbortSignal | undefined> = [];
  const calls: number[] = [];
  const engine: ModelEngine = {
    name: 'web',
    async health() {
      return { ok: true };
    },
    send(_text: string, signal?: AbortSignal): Promise<EngineSendResult> {
      calls.push(Date.now());
      signals.push(signal);
      const first = calls.length === 1;
      const content = first ? (opts.content ?? '迟到的回复') : (opts.secondRunImmediate ?? '新一轮回复');
      const delay = first || !opts.secondRunImmediate ? opts.delayMs : 0;
      return new Promise<EngineSendResult>((resolve, reject) => {
        setTimeout(() => {
          if (opts.reject && first) reject(new Error('late-failure'));
          else resolve({ content, toolCalls: 0, completion: 'complete' });
        }, delay);
      });
    },
  };
  return { engine, signals, calls };
}

describe('N2-04 ① 每轮 signal：超时后必须 aborted', () => {
  it('轮超时时内核 abort 本轮的 signal（引擎据此可立即收尾）', async () => {
    const { engine, signals } = slowEngine({ delayMs: 120 });
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine, history, maxRounds: 1, roundTimeoutMs: 30 });

    const r = await loop.run('你好');

    expect(r.stopReason).toBe('timeout');
    expect(signals.length).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(true);
  });
});

describe('N2-04 ② 迟到结果：丢弃 + 一行诊断', () => {
  it('超时之后才 resolve 的回复不进 history、不触发 onDelta，且诊断恰一条', async () => {
    const { engine } = slowEngine({ delayMs: 120, content: '迟到的回复' });
    const history = createMessageHistory();
    const diagnostics: TaskLoopDiagnostic[] = [];
    const onDelta = vi.fn();
    const loop = createTaskLoop({
      engine,
      history,
      maxRounds: 1,
      roundTimeoutMs: 30,
      onDelta,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    const r = await loop.run('你好');
    expect(r.stopReason).toBe('timeout');

    // 等迟到结果真的到达
    await sleep(220);

    const contents = history.all().map((m) => m.content);
    expect(contents).not.toContain('迟到的回复');
    expect(onDelta).not.toHaveBeenCalled();
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]!.kind).toBe('stale-result-dropped');
    expect(diagnostics[0]!.generation).toBe(1);
  });
});

describe('N2-04 ③ 迟到 reject 不许变成 unhandledRejection', () => {
  it('超时后引擎才失败 → 不产生未处理拒绝，诊断记为 stale-error-dropped', async () => {
    const { engine } = slowEngine({ delayMs: 100, reject: true });
    const history = createMessageHistory();
    const diagnostics: TaskLoopDiagnostic[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const loop = createTaskLoop({
        engine,
        history,
        maxRounds: 1,
        roundTimeoutMs: 30,
        onDiagnostic: (d) => diagnostics.push(d),
      });
      const r = await loop.run('你好');
      expect(r.stopReason).toBe('timeout');
      await sleep(220);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(diagnostics.map((d) => d.kind)).toEqual(['stale-error-dropped']);
  });
});

describe('N2-04 ④ 正常路径逐字节不变', () => {
  it('未超时：结果照旧落库、无诊断、单次调用', async () => {
    const { engine, calls } = slowEngine({ delayMs: 0, content: '正常回复' });
    const history = createMessageHistory();
    const diagnostics: TaskLoopDiagnostic[] = [];
    const onDelta = vi.fn();
    const loop = createTaskLoop({
      engine,
      history,
      maxRounds: 1,
      roundTimeoutMs: 5_000,
      onDelta,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    const r = await loop.run('你好');

    expect(r).toEqual({ round: 1, content: '正常回复', toolCalls: 0, stopReason: 'no-tool-calls' });
    expect(history.all().map((m) => m.content)).toEqual(['你好', '正常回复']);
    expect(onDelta).toHaveBeenCalledWith('正常回复');
    expect(diagnostics).toEqual([]);
    expect(calls.length).toBe(1);
  });
});

describe('N2-04 ⑤ 上一次 run 的迟到回复不许混进下一次 run', () => {
  it('第一次 run 超时、第二次 run 正常 → history 里只有第二次的回复', async () => {
    const { engine } = slowEngine({ delayMs: 120, content: '上一轮的迟到回复', secondRunImmediate: '新一轮回复' });
    const history = createMessageHistory();
    const diagnostics: TaskLoopDiagnostic[] = [];
    const loop = createTaskLoop({
      engine,
      history,
      maxRounds: 1,
      roundTimeoutMs: 30,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    const first = await loop.run('第一次');
    expect(first.stopReason).toBe('timeout');

    const second = await loop.run('第二次');
    expect(second.content).toBe('新一轮回复');

    // 再等一会儿，让第一轮的迟到结果落地
    await sleep(220);

    const contents = history.all().map((m) => m.content);
    expect(contents).not.toContain('上一轮的迟到回复');
    expect(contents).toContain('新一轮回复');
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
  });
});

describe('N2-04 ⑥ web 引擎真吃 signal（不是假设）', () => {
  it('进函数即已 abort → 对页面零副作用，completion=truncated', async () => {
    const dispatch = vi.fn(async () => okResult());
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 5_000,
    });
    const ctl = new AbortController();
    ctl.abort();

    const r = await engine.send('不该被发出去', ctl.signal);

    expect(r.completion).toBe('truncated');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('轮询中被 abort → 立刻收尾，不烧满 stepTimeoutMs', async () => {
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        return okResult({ count: 1, messages: [{ role: 'unknown', text: '上一轮答案', id: 'x' }] });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 5,
      stepTimeoutMs: 60_000,
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 40);
    const started = Date.now();

    const r = await engine.send('随便一句提示语', ctl.signal);

    expect(r.completion).toBe('truncated');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
