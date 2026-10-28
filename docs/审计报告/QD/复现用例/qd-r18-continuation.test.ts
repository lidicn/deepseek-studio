/**
 * QD-R18 复现件 · 续跑等待（waitForNextReply）的降级路径不可达 × completion 四值在 TaskLoop 侧丢失
 *
 * 真用：createWebEngine（两条轮询路径全是真码）、createTaskLoop、createMessageHistory、decideCompletion。
 * 假用：一扇可控「网页」dispatch + 一个可控 auto-continue 缓冲（形状对齐 desktop-host 的 lastAutoReply）。
 * 与生产对齐：
 *   - desktop-host.ts:820-825 同时注入 getAutoReply / consumeAutoReply ⇒ web-engine.ts:320 走「路径 A」。
 *   - desktop-host.ts:866-870 TaskLoop 只看 content / toolCalls / timedOut，⛔ 读 completion。
 */
import { describe, expect, it } from 'vitest';
import { createWebEngine, decideCompletion } from '../../src/host/engine/web-engine';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import type { ExecuteResult } from '../../src/capabilities/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type AutoReply = { text: string; loop: number; updatedAt: number; fresh: boolean };

interface PageOpts {
  /** chat-read 是否失败（模拟断线）。 */
  readFails?: () => boolean;
  /** chat-insert / chat-send 是否失败（模拟发送失败）。 */
  sendFails?: () => boolean;
  /** chat-read 重连成功后是否终于返回文本。 */
  recoverAfter?: number;
}

/** 可控页面：domText 就是「页面上此刻最后一条消息」。 */
function makePage(domText: () => string, opts: PageOpts = {}) {
  let reads = 0;
  const dispatch = async (tool: string, params: Record<string, unknown>): Promise<ExecuteResult> => {
    if (tool === 'chat-insert') {
      if (opts.sendFails?.()) return { ok: false, error: 'page offline (insert)' };
      return { ok: true, data: { inserted: String(params.text ?? '').slice(0, 20) } };
    }
    if (tool === 'chat-send') {
      if (opts.sendFails?.()) return { ok: false, error: 'page offline (send)' };
      return { ok: true, data: { sent: true } };
    }
    if (tool === 'chat-read') {
      reads += 1;
      if (opts.readFails?.() && !(opts.recoverAfter !== undefined && reads > opts.recoverAfter)) {
        return { ok: false, error: 'page offline (read)' };
      }
      return { ok: true, data: { count: 1, messages: [{ text: domText() }] } };
    }
    return { ok: false, error: `unexpected tool ${tool}` };
  };
  return { dispatch, readCount: () => reads };
}

function makeEngine(page: ReturnType<typeof makePage>, extra: Record<string, unknown> = {}) {
  const counter = { current: 0 };
  const engine = createWebEngine({
    dispatch: page.dispatch,
    toolCallCounter: counter,
    pollIntervalMs: 10,
    stepTimeoutMs: 300,
    maxReconnectAttempts: 1,
    reconnectBackoffMs: 1,
    ...extra,
  } as never);
  return { engine, counter };
}

describe('QD-R18 · 续跑等待与错误分类', () => {
  it('CONTROL：页端推送 auto-continue ⇒ waitForNextReply 立刻拿到回复', async () => {
    const page = makePage(() => '基线');
    const buf: AutoReply = { text: '页端推送的续跑回复', loop: 1, updatedAt: 0, fresh: true };
    const { engine } = makeEngine(page, {
      consumeAutoReply: () => ({ ...buf }),
    });
    const r = await engine.waitForNextReply();
    console.log(`[CONTROL] content=${JSON.stringify(r.content)} completion=${r.completion} timedOut=${r.timedOut}`);
    expect(r.content).toBe('页端推送的续跑回复');
    expect(r.completion).toBe('complete');
  });

  it('REPRO-A：auto-continue 未推送 ⇒ 路径 A 烧光预算后，路径 B 的 DOM 轮询一次都不读页面', async () => {
    // 页面 20ms 后就有新回复了（工具结果已由页端回填、模型已经答完），但 auto-continue 没推送。
    const t0 = Date.now();
    const page = makePage(() => (Date.now() - t0 > 20 ? '页面上明明有的回复' : '基线'));
    const buf: AutoReply = { text: '', loop: 0, updatedAt: 0, fresh: false };
    const { engine } = makeEngine(page, { consumeAutoReply: () => ({ ...buf }) });
    const r = await engine.waitForNextReply();
    console.log(
      `[REPRO-A] content=${JSON.stringify(r.content)} completion=${r.completion} timedOut=${r.timedOut} ` +
        `chat-read 总次数=${page.readCount()}（1 次 = 只在路径 B 开头读了一次基线）`,
    );
    expect(r.content, 'DOM 上已有的回复应被降级轮询读到').toContain('页面上明明有的回复');
  });

  it('REPRO-B：路径 A 成功返回时不关闭指标回合、不打轮次日志、不触发 onRoundComplete', async () => {
    const page = makePage(() => '基线');
    const buf: AutoReply = { text: '页端推送的回复', loop: 1, updatedAt: 0, fresh: true };
    const logs: Record<string, unknown>[] = [];
    const rounds: unknown[] = [];
    const { engine } = makeEngine(page, {
      consumeAutoReply: () => ({ ...buf }),
      logger: (e: Record<string, unknown>) => logs.push(e),
      onRoundComplete: (e: unknown) => rounds.push(e),
    });
    const r = await engine.waitForNextReply();
    await engine.send('这一条走 send，会正常打日志');
    console.log(
      `[REPRO-B] waitForNextReply completion=${r.completion} ｜ logger 条数=${logs.length} rounds 条数=${rounds.length} ｜ 读数=${JSON.stringify(logs)}`,
    );
    expect(logs.length, 'auto-continue 那一轮也应留下结构化日志（现恒缺）').toBe(2);
    expect(rounds.length, 'S21 onRoundComplete 应对两轮都触发（现恒 0 或 1）').toBe(2);
  });

  it('REPRO-C：断线轮的 completion=disconnected 但 timedOut ⛔ 置位 ⇒ TaskLoop 判成正常收尾', async () => {
    const page = makePage(() => '基线', { readFails: () => true });
    const { engine } = makeEngine(page);
    const sent = await engine.send('页面此刻是断的');
    console.log(
      `[REPRO-C] send content=${JSON.stringify(sent.content)} toolCalls=${sent.toolCalls} timedOut=${sent.timedOut} completion=${sent.completion} 重连尝试=${engine.getReconnectAttempts()}`,
    );
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine, history, maxRounds: 3, roundTimeoutMs: 5_000 });
    const res = await loop.run('页面此刻是断的');
    console.log(`[REPRO-C] TaskLoop stopReason=${res.stopReason} content=${JSON.stringify(res.content)} toolCalls=${res.toolCalls}`);
    console.log(`[REPRO-C] decideCompletion({timedOut:false,dispatchFailed:true,stopped:false})=${decideCompletion({ timedOut: false, dispatchFailed: true, stopped: false })}`);
    expect.soft(res.stopReason, '断线不应被 TaskLoop 判成正常结束').toBe('timeout');
    expect(
      history.all().some((m) => m.role === 'assistant' && m.content === ''),
      '断线轮不应把空 assistant 写进历史',
    ).toBe(false);
  });

  it('REPRO-D：reconnectAttempts 引擎级永不清零 ⇒ 第二轮日志把上一轮的重连算进本轮', async () => {
    let failWindow = true;
    const page = makePage(() => '基线', { readFails: () => failWindow });
    const logs: Record<string, unknown>[] = [];
    const { engine } = makeEngine(page, { logger: (e: Record<string, unknown>) => logs.push(e) });
    const r1 = await engine.send('第一轮：读一次失败后恢复');
    failWindow = false;
    const r2 = await engine.send('第二轮：全程健康');
    console.log(
      `[REPRO-D] r1 completion=${r1.completion} r2 completion=${r2.completion} 引擎累计重连=${engine.getReconnectAttempts()} 日志=${JSON.stringify(logs)}`,
    );
    const second = logs[1] ?? {};
    expect(second.reconnects, '本轮日志的 reconnects 应为 0（现继承上一轮的 1）').toBe(0);
  });
});
