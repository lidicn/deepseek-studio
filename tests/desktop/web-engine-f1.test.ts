/**
 * F1：WebEngine 的答案选取（20261031）
 *
 * 三条真机结论对应的行为：
 *   1. **用户自己的气泡不能当答案**——它总是 DOM 里最后一条、含记忆注入块 ~10k 字符；
 *      旧实现 `messages.at(-1)` 直接把它当模型回答。
 *   2. **读不到 ≠ 读到空**——chat-read 失败/空要继续等（`no-messages-found`），
 *      只有「页面能力不可用」（no-page）才是硬失败；旧实现把两者混同 → 空转 120s。
 *   3. **超时也不返回旧答案**——没见到本轮新文本就返回空，绝不拿上一轮答案冒充本轮。
 */

import { describe, it, expect } from 'vitest';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

function okResult(data?: unknown): ExecuteResult {
  return { ok: true, data } as ExecuteResult;
}

/** 造一个 chat-read 的返回：消息文本数组 */
function msgs(...texts: string[]): ExecuteResult {
  return okResult({
    count: texts.length,
    messages: texts.map((t) => ({ role: 'unknown', text: t, id: `local#${texts.indexOf(t)}` })),
  });
}

describe('WebEngine F1：答案选取', () => {
  it('1. 用户自己的气泡（包含刚发的 prompt）不被当成答案', async () => {
    const prompt = '请只回复 F1V3-1234567890';
    let readCount = 0;
    const dispatch = async (tool: string, _p: Record<string, unknown>): Promise<ExecuteResult> => {
      if (tool === 'chat-insert') return okResult();
      if (tool === 'chat-send') return okResult();
      if (tool === 'chat-read') {
        readCount += 1;
        // 基线：上一轮答案 + 我们刚发的用户气泡（气泡里含 prompt）
        if (readCount <= 2) return msgs('上一轮答案', `用户气泡：${prompt}（含记忆注入块，很长）`);
        // 之后：答案出现了（注意用户气泡仍在 DOM 里、仍是最后一条之前的项）
        return msgs('上一轮答案', `用户气泡：${prompt}（含记忆注入块，很长）`, '本轮答案 F1V3-1234567890');
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 2000,
    });
    const r = await engine.send(prompt);
    expect(r.content).toBe('本轮答案 F1V3-1234567890');
    expect(r.completion).toBe('complete');
  });

  it('2. chat-read 返回 no-messages-found 时继续等，不当硬失败', async () => {
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount += 1;
        if (readCount < 3) return { ok: false, error: 'no-messages-found' } as ExecuteResult;
        return msgs('答案到了');
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 2000,
    });
    const r = await engine.send('随便一句提示语');
    expect(r.content).toBe('答案到了');
    expect(r.completion).toBe('complete');
  });

  it('3. chat-read 报 no-page（页面能力没了）→ 硬失败 disconnected，不空转', async () => {
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') return { ok: false, error: 'no-page-for-dom-capability' } as ExecuteResult;
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 60_000,
      maxReconnectAttempts: 1, reconnectBackoffMs: 1,
    });
    const started = Date.now();
    const r = await engine.send('随便一句提示语');
    expect(r.completion).toBe('disconnected');
    // 关键：不能空转到 120s 看门狗
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('4. 超时且没有本轮新文本 → 返回空，绝不返回上一轮答案', async () => {
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') return msgs('上一轮答案');
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 120,
    });
    const r = await engine.send('随便一句提示语');
    expect(r.content).toBe('');
    expect(r.completion).toBe('truncated');
    expect(r.timedOut).toBe(true);
  });

  it('5. SSE 通道（auto-continue 轮）有本轮新回复时以它为准', async () => {
    let seq = 7;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') return msgs('DOM 里的旧文本');
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 2000,
      getAutoReply: () => ({ text: 'SSE 推来的本轮答案', loop: 1, updatedAt: Date.now(), fresh: true, seq }),
    });
    const p = engine.send('随便一句提示语');
    // 发送后模拟页端推来一条新的 SSE 回复（seq 递增）
    seq = 8;
    const r = await p;
    expect(r.content).toBe('SSE 推来的本轮答案');
    expect(r.completion).toBe('complete');
  });

  it('6. 真机场景：DOM 只挂老用户消息（无 assistant）时，答案取 Studio 镜像（SSE 派生）', async () => {
    const prompt = '请只回复 F1V3-abcdefgh';
    let readCount = 0;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        readCount += 1;
        // 前两次：镜像里还没有本轮答案；之后出现
        const hasAnswer = readCount > 2;
        return okResult({
          count: 3,
          // 真机现场：挂载的全是 user（带能力前导注入）
          messages: [
            { role: 'user', text: `[studio-tool-capability] ## 角色 说明`, injected: true },
            { role: 'user', text: `[studio-tool-capability] ## 角色 说明`, injected: true },
            { role: 'user', text: `${prompt}`, injected: false },
          ],
          mirror: {
            count: hasAnswer ? 1 : 0,
            assistantTexts: hasAnswer ? ['F1V3-abcdefgh'] : [],
            lastAssistantText: hasAnswer ? 'F1V3-abcdefgh' : '',
          },
        });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 1, stepTimeoutMs: 3000,
    });
    const r = await engine.send(prompt);
    expect(r.content).toBe('F1V3-abcdefgh');
    expect(r.completion).toBe('complete');
  });

  it('7. waitForNextReply：consumeAutoReply 永不 fresh 时不能被它吃光预算，应走镜像拿到答案', async () => {
    let mirrorCount = 15;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-read') {
        // 普通轮：页端不会推 assistant-reply，镜像条数在 1s 后 +1
        return okResult({
          count: 3,
          messages: [{ role: 'user', text: '[studio-tool-capability] ## 角色', injected: true }],
          mirror: {
            count: mirrorCount,
            assistantTexts: mirrorCount > 15 ? ['F1V3-mirror-answer'] : [],
            lastAssistantText: mirrorCount > 15 ? 'F1V3-mirror-answer' : '',
          },
        });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 20, stepTimeoutMs: 5000,
      // 永不 fresh：模拟普通轮
      consumeAutoReply: () => ({ text: '', loop: 0, updatedAt: 0, fresh: false }),
    });
    setTimeout(() => { mirrorCount = 16; }, 60);
    const started = Date.now();
    const r = await engine.waitForNextReply();
    const elapsed = Date.now() - started;
    expect(r.content).toBe('F1V3-mirror-answer');
    expect(r.completion).toBe('complete');
    // 关键：远早于 5000ms 预算（旧实现会先空转满预算）
    expect(elapsed).toBeLessThan(2000);
  });

  it('8. send()：基线取在发送之前，答案 1 秒内到达也能判到（复验 R4 的 130s 回归）', async () => {
    let mirrorCount = 15;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert' || tool === 'chat-send') return okResult();
      if (tool === 'chat-read') {
        return okResult({
          count: 0,
          messages: [],
          mirror: {
            count: mirrorCount,
            assistantTexts: mirrorCount > 15 ? ['本轮答案 F1V3-fast'] : [],
            lastAssistantText: mirrorCount > 15 ? '本轮答案 F1V3-fast' : '',
          },
        });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 20, stepTimeoutMs: 3000,
    });
    setTimeout(() => { mirrorCount = 16; }, 40);
    const r = await engine.send('提示语');
    expect(r.content).toBe('本轮答案 F1V3-fast');
    expect(r.completion).toBe('complete');
  });

  it('9. R5：续跑复用 send 的基线——答案在 send 阶段已落地时，waitForNextReply 必须秒回而不是空转 120s', async () => {
    let mirrorCount = 15;
    const dispatch = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert' || tool === 'chat-send') {
        setTimeout(() => {
          mirrorCount = 16;
        }, 20);
        return okResult();
      }
      if (tool === 'chat-read') {
        return okResult({
          count: 0,
          messages: [],
          mirror: {
            count: mirrorCount,
            assistantTexts: mirrorCount > 15 ? ['ANSWER-R5'] : [],
            lastAssistantText: mirrorCount > 15 ? 'ANSWER-R5' : '',
          },
        });
      }
      return okResult();
    };
    const engine = createWebEngine({
      dispatch, toolCallCounter: { current: 0 }, pollIntervalMs: 20, stepTimeoutMs: 5000,
      consumeAutoReply: () => ({ text: '', loop: 0, updatedAt: 0, fresh: false }),
    });
    const first = await engine.send('q');
    expect(first.content).toBe('ANSWER-R5');
    // 续跑轮：旧实现在这里重取基线（mirrorCount 已 =16）→ 永远没有增量 → 空转满预算
    const t0 = Date.now();
    const r = await engine.waitForNextReply();
    expect(r.content).toBe('ANSWER-R5');
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
