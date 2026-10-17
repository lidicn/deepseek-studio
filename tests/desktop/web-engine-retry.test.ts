import { describe, it, expect } from 'vitest';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

function okResult(data?: unknown): ExecuteResult {
  return { ok: true, data } as ExecuteResult;
}

describe('WebEngine S8: send() retry with backoff', () => {
  it('1. first attempt succeeds → no retry', async () => {
    let insertCalls = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') { insertCalls++; return okResult(); }
      if (tool === 'chat-send') return okResult();
      return okResult({ messages: [{ text: 'done' }], count: 1 });
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 500, reconnectBackoffMs: 1,
    });
    await engine.send('hi');
    expect(insertCalls).toBe(1);
  });

  it('2. transient failure on first attempt → retry succeeds', async () => {
    let insertCalls = 0;
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') {
        insertCalls++;
        if (insertCalls === 1) return { ok: false, error: 'flaky' } as ExecuteResult;
        return okResult();
      }
      if (tool === 'chat-send') return okResult();
      readCount++;
      return okResult({ messages: [{ text: readCount <= 1 ? '' : 'done' }], count: 1 });
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 500, reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(insertCalls).toBe(2);
    expect(r.completion).toBe('complete');
  });

  it('3. all retries exhausted → disconnected', async () => {
    let insertCalls = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') { insertCalls++; return { ok: false, error: 'dead' } as ExecuteResult; }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 500, reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('disconnected');
    // initial + 2 retries = 3 calls
    expect(insertCalls).toBe(3);
  });

  it('4. exponential backoff: 500ms then 1500ms', async () => {
    let insertCalls = 0;
    const timestamps: number[] = [];
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') {
        insertCalls++;
        timestamps.push(Date.now());
        return { ok: false, error: 'x' } as ExecuteResult;
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 10000, reconnectBackoffMs: 1,
    });
    await engine.send('hi');
    expect(timestamps.length).toBe(3);
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    expect(gap1).toBeGreaterThanOrEqual(400);
    expect(gap2).toBeGreaterThanOrEqual(1400);
  });

  it('5. maxSendRetries=0 → no retry, immediate disconnected', async () => {
    let insertCalls = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') { insertCalls++; return { ok: false, error: 'x' } as ExecuteResult; }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 500, reconnectBackoffMs: 1,
      maxSendRetries: 0,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('disconnected');
    expect(insertCalls).toBe(1);
  });

  it('6. retry succeeds on chat-send failure', async () => {
    let sendCalls = 0;
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') return okResult();
      if (tool === 'chat-send') {
        sendCalls++;
        if (sendCalls === 1) return { ok: false, error: 'flaky' } as ExecuteResult;
        return okResult();
      }
      readCount++;
      return okResult({ messages: [{ text: readCount <= 1 ? '' : 'done' }], count: 1 });
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 500, reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(sendCalls).toBe(2);
    expect(r.completion).toBe('complete');
  });
});
