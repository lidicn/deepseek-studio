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

/**
 * 2026-11-15 卡⑨ 的**反向约束**（PM 要求）：`terminate` 的语义只允许是
 * 「**劝模型别在本轮再发这个调用**」——绝不能把引擎的 **S4 断流重连**一起掐死
 * （`src/host/engine/web-engine.ts` 里「DOM 无页 ⇒ 硬失败 → 走 S4 重连」这条路径必须照旧发生）。
 *
 * 这枚锁用**带 terminate 的结果形态**喂 dispatch：引擎只读 `ok`／`error`／`reason`／`data`，
 * 所以重连照旧。若哪天有人让引擎去读 `terminate` 并提前放弃，这条必红。
 * （注：`no-page-for-dom-capability` 2026-11-15 复议后**不在**终局族、生产上不会再带 terminate；
 *  这里仍按该形态喂，是**防未来耦合**——任何来源的 terminate 都不得影响引擎重连。）
 */
describe('WebEngine S4 与 terminate 正交（终局信号不得掐死重连）', () => {
  it('dispatch 返回带 terminate:true 的 no-page 硬失败 ⇒ 重连仍发生并恢复完成', async () => {
    let readCount = 0;
    const seenTerminate: Array<boolean | undefined> = [];
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount++;
        if (readCount <= 2) {
          // 生产形态：宿主出口挂的终局信号与失败码同级
          const r = { ok: false, reason: 'no-page-for-dom-capability', terminate: true } as ExecuteResult;
          seenTerminate.push((r as { terminate?: boolean }).terminate);
          return r;
        }
        return okResult({ messages: [{ text: readCount > 4 ? 'reconnected reply' : '' }], count: 1 });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 1,
      stepTimeoutMs: 2000,
      maxReconnectAttempts: 3,
      reconnectBackoffMs: 1,
    });
    const r = await engine.send('hi');
    // ① 引擎没有被 terminate 提前放弃：确实重连过，且最终拿到内容
    expect(engine.getReconnectAttempts()).toBeGreaterThan(0);
    expect(r.completion).toBe('complete');
    expect(r.content).toContain('reconnected');
    // ② 喂进去的失败确实带 terminate（证明这条锁咬的是加码后的形态，不是旧形态）
    expect(seenTerminate).toEqual([true, true]);
  });

  it('同样的失败但 terminate 缺省 ⇒ 重连行为逐字相同（terminate 不是引擎的输入）', async () => {
    const build = (withTerminate: boolean) => {
      let readCount = 0;
      const dispatch = async (tool: string): Promise<ExecuteResult> => {
        if (tool === 'chat-read') {
          readCount++;
          if (readCount <= 2) {
            const base = { ok: false, reason: 'no-page-for-dom-capability' };
            const r = withTerminate ? { ...base, terminate: true } : base;
            return r as unknown as ExecuteResult;
          }
          return okResult({ messages: [{ text: readCount > 4 ? 'reconnected reply' : '' }], count: 1 });
        }
        return okResult();
      };
      return createWebEngine({
        dispatch,
        toolCallCounter: { current: 0 },
        pollIntervalMs: 1,
        stepTimeoutMs: 2000,
        maxReconnectAttempts: 3,
        reconnectBackoffMs: 1,
      });
    };
    const withSig = build(true);
    const withoutSig = build(false);
    const a = await withSig.send('hi');
    const b = await withoutSig.send('hi');
    expect(a.completion).toBe(b.completion);
    expect(withSig.getReconnectAttempts()).toBe(withoutSig.getReconnectAttempts());
  });
});
