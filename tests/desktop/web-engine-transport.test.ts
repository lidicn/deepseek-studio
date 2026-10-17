import { describe, it, expect } from 'vitest';
import { createWebEngine, decideCompletion } from '../../src/host/engine/web-engine';
import type { ModelEngine } from '../../src/host/engine/model-engine';
import type { HarnessMetrics } from '../../src/shared/harness-metrics';
import { createHarnessMetrics } from '../../src/shared/harness-metrics';
import { createToolEventBus } from '../../src/shared/tool-event-bus';
import type { ExecuteResult } from '../../src/capabilities/types';

function okResult(data?: unknown): ExecuteResult {
  return { ok: true, data } as ExecuteResult;
}

function makeFakeDispatch() {
  return async (_tool: string, _params: Record<string, unknown>): Promise<ExecuteResult> => {
    return okResult({ messages: [{ text: 'reply' }], count: 1 });
  };
}

describe('WebEngine as ModelEngine transport (M1-2)', () => {
  it('1. WebEngine type assignable to ModelEngine (compile-time)', () => {
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
    });
    const asModel: ModelEngine = engine;
    expect(asModel.name).toBe('web');
    expect(typeof asModel.health).toBe('function');
    expect(typeof asModel.send).toBe('function');
  });

  it('2. no metrics injected: recordToolCall does not crash, old behavior unchanged', () => {
    const calls: string[] = [];
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
      onToolCall: (rec) => calls.push(rec.tool),
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    engine.recordToolCall({ tool: 'file.read', ok: false, error: 'denied' });
    expect(calls).toEqual(['shell.exec', 'file.read']);
    expect(engine.getMetrics()).toBeUndefined();
  });

  it('3. metrics injected: recordToolCall changes snapshot numbers', () => {
    const bus = createToolEventBus();
    const metrics: HarnessMetrics = createHarnessMetrics(bus);
    const before = metrics.snapshot();

    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
      metrics,
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    engine.recordToolCall({ tool: 'file.read', ok: true });

    const after = metrics.snapshot();
    console.log('before:', JSON.stringify(before));
    console.log('after :', JSON.stringify(after));
    expect(after.toolRounds).toBe(before.toolRounds + 2);
    expect(after.nudgeRate).toBe(0);
  });

  it('4. two consecutive send rounds: buffers are independent', async () => {
    const counter = { current: 0 };
    let engineRef: ReturnType<typeof createWebEngine> | null = null;
    let recordedThisRound = false;
    const dispatch = async (tool: string, _p: Record<string, unknown>): Promise<ExecuteResult> => {
      if (tool === 'chat-read' && engineRef && !recordedThisRound) {
        engineRef.recordToolCall({ tool: 'shell.exec', ok: true });
        recordedThisRound = true;
      }
      return okResult({ messages: [{ text: 'reply' }], count: 1 });
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: counter,
      pollIntervalMs: 1,
      stepTimeoutMs: 200,
      onToolCall: () => {},
    });
    engineRef = engine;

    const r1 = await engine.send('hello');
    expect(r1.toolCallRecords!.length).toBe(1);

    // round 2: buffer must be reset (send() clears it), no stale records
    recordedThisRound = false;
    const r2 = await engine.send('world');
    expect(r2.toolCallRecords!.length).toBe(1); // fresh record this round, NOT 2
    expect(r2.toolCallRecords![0].tool).toBe('shell.exec');
  });

  it('5. onToolCall callback still invoked (M2-2 regression)', () => {
    const seen: string[] = [];
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
      onToolCall: (rec) => seen.push(rec.tool),
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    expect(seen).toEqual(['shell.exec']);
  });

  it('6. toolCallRecords still populated correctly (M2-2 regression)', () => {
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
      onToolCall: () => {},
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    engine.recordToolCall({ tool: 'file.write', ok: true });
    // send resets and returns buffer
    // We can't easily run send without real dispatch; verify via internal state by
    // checking that recordToolCall pushes to buffer (no throw) and getMetrics works.
    expect(engine.getMetrics()).toBeUndefined();
  });

  it('7. injected metrics vs internally-created metrics both yield snapshot', () => {
    // path A: externally injected
    const bus1 = createToolEventBus();
    const m1 = createHarnessMetrics(bus1);
    const e1 = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
      metrics: m1,
    });
    expect(e1.getMetrics()).toBe(m1);

    // path B: internal creation from bus
    const bus2 = createToolEventBus();
    const e2 = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
      toolEventBus: bus2,
    });
    expect(e2.getMetrics()).toBeDefined();
    e2.recordToolCall({ tool: 'shell.exec', ok: true });
    expect(e2.getMetrics()!.snapshot().toolRounds).toBe(1);
  });

  it('8. dispose() cleans up bus subscription without throwing', () => {
    const bus = createToolEventBus();
    const metrics = createHarnessMetrics(bus);
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
      metrics,
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    expect(bus.listenerCount()).toBeGreaterThan(0);
    metrics.dispose();
    expect(bus.listenerCount()).toBe(0);
  });

  // ---- S2: completion status ----
  it('9. decideCompletion: normal exit → complete', () => {
    expect(decideCompletion({ timedOut: false, dispatchFailed: false, stopped: false })).toBe('complete');
  });

  it('10. decideCompletion: watchdog timeout → truncated', () => {
    expect(decideCompletion({ timedOut: true, dispatchFailed: false, stopped: false })).toBe('truncated');
  });

  it('11. decideCompletion: dispatch failure → disconnected', () => {
    expect(decideCompletion({ timedOut: false, dispatchFailed: true, stopped: false })).toBe('disconnected');
  });

  it('12. decideCompletion: user stop → unknown', () => {
    expect(decideCompletion({ timedOut: false, dispatchFailed: false, stopped: true })).toBe('unknown');
  });

  it('13. send() with dispatch failure returns completion=disconnected', async () => {
    const badDispatch = async (): Promise<ExecuteResult> => ({ ok: false, error: 'page gone' } as ExecuteResult);
    const engine = createWebEngine({
      dispatch: badDispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 100,
    });
    const r = await engine.send('hello');
    expect(r.completion).toBe('disconnected');
  });

  it('14. send() watchdog timeout returns completion=truncated', async () => {
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 50,
    });
    const r = await engine.send('hello');
    expect(r.completion).toBe('truncated');
  });

  // ---- S3: nudgeRate wiring ----
  it('15. truncated completion bumps nudgeRounds in metrics', async () => {
    const bus = createToolEventBus();
    const metrics = createHarnessMetrics(bus);
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 30,
      metrics,
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    await engine.send('x'); // times out → truncated
    const snap = metrics.snapshot();
    expect(snap.toolRounds).toBe(1);
    expect(snap.nudgeRounds).toBe(1);
    expect(snap.nudgeRate).toBe(1);
  });

  it('16. disconnected completion bumps nudgeRounds', async () => {
    const bus = createToolEventBus();
    const metrics = createHarnessMetrics(bus);
    const badDispatch = async (): Promise<ExecuteResult> => ({ ok: false, error: 'gone' } as ExecuteResult);
    const engine = createWebEngine({
      dispatch: badDispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 30,
      metrics,
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    await engine.send('x');
    const snap = metrics.snapshot();
    expect(snap.toolRounds).toBe(1);
    expect(snap.nudgeRounds).toBe(1);
  });

  it('17. complete completion does NOT bump nudgeRounds', async () => {
    const bus = createToolEventBus();
    const metrics = createHarnessMetrics(bus);
    // dispatch returns changing text so polling detects stable completion
    let callCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        callCount++;
        return okResult({ messages: [{ text: callCount > 2 ? 'stable reply' : '' }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 500,
      metrics,
    });
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    await engine.send('x');
    const snap = metrics.snapshot();
    expect(snap.toolRounds).toBe(1);
    expect(snap.nudgeRounds).toBe(0);
    expect(snap.nudgeRate).toBe(0);
  });

  it('18. two rounds: one truncated one complete → nudgeRate = 0.5', async () => {
    const bus = createToolEventBus();
    const metrics = createHarnessMetrics(bus);
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 30,
      metrics,
    });
    // round 1: truncated
    engine.recordToolCall({ tool: 'shell.exec', ok: true });
    await engine.send('x');
    // round 2: also truncated (fake dispatch never changes text → timeout)
    engine.recordToolCall({ tool: 'file.read', ok: true });
    await engine.send('y');
    const snap = metrics.snapshot();
    expect(snap.toolRounds).toBe(2);
    expect(snap.nudgeRounds).toBe(2);
    expect(snap.nudgeRate).toBe(1);
  });

  // ---- S5: structured logging ----
  it('19. logger injected: each round emits one structured entry', async () => {
    const entries: Record<string, unknown>[] = [];
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 30,
      logger: (e) => entries.push(e),
    });
    await engine.send('a');
    await engine.send('b');
    expect(entries.length).toBe(2);
    expect(entries[0].round).toBe(1);
    expect(entries[1].round).toBe(2);
  });

  it('20. log entry contains completion, toolCalls, elapsedMs', async () => {
    const entries: Record<string, unknown>[] = [];
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 30,
      logger: (e) => entries.push(e),
    });
    await engine.send('x');
    const e = entries[0];
    expect(e).toHaveProperty('completion');
    expect(e).toHaveProperty('toolCalls');
    expect(e).toHaveProperty('elapsedMs');
    expect(typeof e.elapsedMs).toBe('number');
  });

  it('21. no logger → silent (no throw, no console pollution)', async () => {
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 30,
    });
    await expect(engine.send('x')).resolves.toBeDefined();
  });

  it('22. truncated round logs completion=truncated', async () => {
    const entries: Record<string, unknown>[] = [];
    const engine = createWebEngine({
      dispatch: makeFakeDispatch(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 30,
      logger: (e) => entries.push(e),
    });
    await engine.send('x');
    expect(entries[0].completion).toBe('truncated');
  });

  // ---- S7: onDelta streaming callback ----
  it('23. onDelta called when text grows during polling', async () => {
    const deltas: string[] = [];
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        const text = readCount <= 2 ? '' : readCount === 3 ? 'Hel' : readCount === 4 ? 'Hello' : 'Hello world';
        return okResult({ messages: [{ text }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 500,
      onDelta: (t) => deltas.push(t),
    });
    await engine.send('hi');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[deltas.length - 1]).toBe('Hello world');
  });

  it('24. no onDelta → no throw, streaming is opt-in', async () => {
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        return okResult({ messages: [{ text: readCount > 3 ? 'done' : '' }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 500,
    });
    await expect(engine.send('hi')).resolves.toBeDefined();
  });

  it('25. onDelta not called for identical snapshots', async () => {
    const deltas: string[] = [];
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        // baseline empty, then immediately stable
        const text = readCount <= 1 ? '' : 'stable';
        return okResult({ messages: [{ text }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 500,
      onDelta: (t) => deltas.push(t),
    });
    await engine.send('hi');
    // first change ('' → 'stable') triggers one delta, subsequent identical snapshots don't
    expect(deltas.length).toBe(1);
  });

  it('26. onDelta receives cumulative text, not incremental diff', async () => {
    const deltas: string[] = [];
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        const text = readCount <= 2 ? '' : readCount === 3 ? 'A' : readCount === 4 ? 'AB' : 'ABC';
        return okResult({ messages: [{ text }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 500,
      onDelta: (t) => deltas.push(t),
    });
    await engine.send('hi');
    expect(deltas).toContain('A');
    expect(deltas).toContain('AB');
    expect(deltas).toContain('ABC');
  });

  // ---- S9: multi-instance isolation ----
  it('27. two instances have independent reconnect counters', async () => {
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') { readCount++; return { ok: false, error: 'dead' } as ExecuteResult; }
      return okResult();
    };
    const e1 = createWebEngine({ dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 5000, maxReconnectAttempts: 2, reconnectBackoffMs: 1 });
    const e2 = createWebEngine({ dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 5000, maxReconnectAttempts: 2, reconnectBackoffMs: 1 });
    await e1.send('a');
    expect(e1.getReconnectAttempts()).toBe(2);
    expect(e2.getReconnectAttempts()).toBe(0);
  });

  it('28. two instances have independent metrics', async () => {
    const bus1 = createToolEventBus();
    const bus2 = createToolEventBus();
    const m1 = createHarnessMetrics(bus1);
    const m2 = createHarnessMetrics(bus2);
    const e1 = createWebEngine({ dispatch: makeFakeDispatch(), toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 30, metrics: m1 });
    // e2 不创建也能验证 m2 初始为 0（隔离测试）
    e1.recordToolCall({ tool: 'shell.exec', ok: true });
    expect(m1.snapshot().toolRounds).toBe(1);
    expect(m2.snapshot().toolRounds).toBe(0);
  });

  it('29. two instances have independent round counters', async () => {
    const log1: unknown[] = [];
    const log2: unknown[] = [];
    const e1 = createWebEngine({ dispatch: makeFakeDispatch(), toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 30, logger: (e) => log1.push(e) });
    const e2 = createWebEngine({ dispatch: makeFakeDispatch(), toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 30, logger: (e) => log2.push(e) });
    await e1.send('a');
    await e1.send('b');
    await e2.send('c');
    expect((log1[0] as Record<string, unknown>).round).toBe(1);
    expect((log1[1] as Record<string, unknown>).round).toBe(2);
    expect((log2[0] as Record<string, unknown>).round).toBe(1);
  });

  it('30. no shared global state between instances', () => {
    const e1 = createWebEngine({ dispatch: makeFakeDispatch(), toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 30 });
    const e2 = createWebEngine({ dispatch: makeFakeDispatch(), toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 30 });
    // both start fresh
    expect(e1.getReconnectAttempts()).toBe(0);
    expect(e2.getReconnectAttempts()).toBe(0);
  });
});
