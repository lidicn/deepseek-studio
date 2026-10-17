import { describe, it, expect } from 'vitest';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

function okResult(data?: unknown): ExecuteResult {
  return { ok: true, data } as ExecuteResult;
}

describe('WebEngine S19: input validation', () => {
  it('1. send("") still works (no crash)', async () => {
    const dispatch = async (tool: string, _p: Record<string, unknown>): Promise<ExecuteResult> => {
      if (tool === 'chat-read') return okResult({ messages: [{ text: 'reply' }], count: 1 });
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
    });
    await expect(engine.send('')).resolves.toBeDefined();
  });

  it('2. send(超长文本) does not crash', async () => {
    let sent = '';
    const dispatch = async (tool: string, p: Record<string, unknown>): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') { sent = p.text as string; return okResult(); }
      if (tool === 'chat-read') return okResult({ messages: [{ text: 'ok' }], count: 1 });
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
    });
    const long = 'a'.repeat(200_000);
    await engine.send(long);
    expect(sent.length).toBe(200_000);
  });

  it('3. send(中文/emoji/换行) normal', async () => {
    let sent = '';
    const dispatch = async (tool: string, p: Record<string, unknown>): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') { sent = p.text as string; return okResult(); }
      if (tool === 'chat-read') return okResult({ messages: [{ text: 'ok' }], count: 1 });
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
    });
    await engine.send('你好世界\n🎉\n第二行');
    expect(sent).toBe('你好世界\n🎉\n第二行');
  });

  it('4. health() with failing dispatch returns {ok:false} not throw', async () => {
    const dispatch = async (): Promise<ExecuteResult> => ({ ok: false, error: 'no tab' } as ExecuteResult);
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
    });
    const h = await engine.health();
    expect(h.ok).toBe(false);
  });

  // S21: onRoundComplete event
  it('5. onRoundComplete fires with correct structure', async () => {
    const events: unknown[] = [];
    const engine = createWebEngine({
      dispatch: async (tool: string): Promise<ExecuteResult> => {
        if (tool === 'chat-read') return okResult({ messages: [{ text: 'done' }], count: 1 });
        return okResult();
      },
      toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
      onRoundComplete: (e) => events.push(e),
    });
    await engine.send('hi');
    expect(events.length).toBe(1);
    const ev = events[0] as Record<string, unknown>;
    expect(ev).toHaveProperty('round');
    expect(ev).toHaveProperty('completion');
    expect(ev).toHaveProperty('durationMs');
  });

  it('6. no onRoundComplete → silent', async () => {
    const engine = createWebEngine({
      dispatch: async (): Promise<ExecuteResult> => okResult({ messages: [{ text: 'x' }], count: 1 }),
      toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 500,
    });
    await expect(engine.send('hi')).resolves.toBeDefined();
  });

  it('7. two rounds → incrementing round number', async () => {
    const events: Record<string, unknown>[] = [];
    const engine = createWebEngine({
      dispatch: async (): Promise<ExecuteResult> => okResult({ messages: [{ text: '' }], count: 1 }),
      toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 30,
      onRoundComplete: (e) => events.push(e),
    });
    await engine.send('a'); // times out → truncated
    await engine.send('b'); // times out → truncated
    expect(events.length).toBe(2);
    expect(events[0].round).toBe(1);
    expect(events[1].round).toBe(2);
  });
});
