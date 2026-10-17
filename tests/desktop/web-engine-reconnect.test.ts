import { describe, it, expect } from 'vitest';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

function okResult(data?: unknown): ExecuteResult {
  return { ok: true, data } as ExecuteResult;
}

describe('WebEngine S4: reconnect on disconnect', () => {
  it('1. no disconnect → reconnectAttempts stays 0', async () => {
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') return okResult({ messages: [{ text: 'stable' }], count: 1 });
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 500,
      reconnectBackoffMs: 1,
    });
    await engine.send('hi');
    expect(engine.getReconnectAttempts()).toBe(0);
  });

  it('2. transient disconnect → reconnect succeeds, completion=complete', async () => {
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        // first 2 reads fail, then recover with changing text
        if (readCount <= 2) return { ok: false, error: 'socket gone' } as ExecuteResult;
        return okResult({ messages: [{ text: readCount > 4 ? 'recovered reply' : '' }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 1000,
      maxReconnectAttempts: 3,
      reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('complete');
    expect(engine.getReconnectAttempts()).toBeGreaterThan(0);
  });

  it('3. persistent disconnect → completion=disconnected after max retries', async () => {
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') return { ok: false, error: 'dead' } as ExecuteResult;
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 5000,
      maxReconnectAttempts: 2,
      reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('disconnected');
    expect(engine.getReconnectAttempts()).toBe(2);
  });

  it('4. reconnect exhaustion does not exceed maxReconnectAttempts', async () => {
    let healthCalls = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        healthCalls++;
        return { ok: false, error: 'dead' } as ExecuteResult;
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 5000,
      maxReconnectAttempts: 3,
      reconnectBackoffMs: 1,
    });
    await engine.send('hi');
    expect(engine.getReconnectAttempts()).toBe(3);
  });

  it('5. reconnect backoff is linear (n*backoff)', async () => {
    // Verify by timing: 3 attempts with backoff=10ms should take at least 10+20+30=60ms
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') return { ok: false, error: 'dead' } as ExecuteResult;
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 10000,
      maxReconnectAttempts: 3,
      reconnectBackoffMs: 20,
    });
    const t0 = Date.now();
    await engine.send('hi');
    const elapsed = Date.now() - t0;
    // linear backoff: 20 + 40 + 60 = 120ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('6. waitForNextReply also reconnects on disconnect', async () => {
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        if (readCount <= 2) return { ok: false, error: 'gone' } as ExecuteResult;
        return okResult({ messages: [{ text: readCount > 4 ? 'auto reply' : '' }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 1000,
      maxReconnectAttempts: 3,
      reconnectBackoffMs: 1,
    });
    const r = await engine.waitForNextReply!();
    expect(r.completion).toBe('complete');
  });

  it('7. send() with chat-send failure → disconnected immediately (no reconnect)', async () => {
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') return okResult();
      if (tool === 'chat-send') return { ok: false, error: 'send failed' } as ExecuteResult;
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 500,
      maxReconnectAttempts: 3,
      reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('disconnected');
    expect(engine.getReconnectAttempts()).toBe(0);
  });

  it('8. reconnect then complete: content is from after reconnect, not stale', async () => {
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        if (readCount <= 2) return { ok: false, error: 'blip' } as ExecuteResult;
        // after recovery, produce a stable reply after a few reads
        const stableText = 'post-recovery-stable';
        return okResult({ messages: [{ text: readCount > 5 ? stableText : '' }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 5,
      stepTimeoutMs: 2000,
      maxReconnectAttempts: 3,
      reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    expect(r.completion).toBe('complete');
    expect(r.content).toContain('post-recovery');
  });
});
