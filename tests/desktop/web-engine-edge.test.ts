import { describe, it, expect } from 'vitest';
import { createWebEngine, decideCompletion } from '../../src/host/engine/web-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

function okResult(data?: unknown): ExecuteResult {
  return { ok: true, data } as ExecuteResult;
}

describe('WebEngine S16: edge cases', () => {
  it('1. send() with chat-insert failing → immediately disconnected', async () => {
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') return { ok: false, error: 'tab gone' } as ExecuteResult;
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 500, reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('disconnected');
  });

  it('2. decideCompletion: dispatchFailed takes priority over timedOut', () => {
    expect(decideCompletion({ timedOut: true, dispatchFailed: true, stopped: false })).toBe('disconnected');
  });

  it('3. health() failing → {ok:false, reason}', async () => {
    const dispatch = async (): Promise<ExecuteResult> => ({ ok: false, error: 'crash' } as ExecuteResult);
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
    });
    const h = await engine.health();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe('crash');
  });

  it('4. send() empty text still works', async () => {
    let sentText = '';
    const dispatch = async (tool: string, params: Record<string, unknown>): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') { sentText = params.text as string; return okResult(); }
      if (tool === 'chat-send') return okResult();
      return okResult({ messages: [{ text: 'reply' }], count: 1 });
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
    });
    const r = await engine.send('');
    expect(sentText).toBe('');
    expect(r.completion).toBeDefined();
  });

  it('5. waitForNextReply with consumeAutoReply returns complete immediately', async () => {
    const engine = createWebEngine({
      dispatch: async () => okResult(),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1, stepTimeoutMs: 500,
      consumeAutoReply: () => ({ text: 'auto reply', loop: 1, updatedAt: Date.now(), fresh: true }),
    });
    const r = await engine.waitForNextReply();
    expect(r.content).toBe('auto reply');
    expect(r.completion).toBe('complete');
  });
});
