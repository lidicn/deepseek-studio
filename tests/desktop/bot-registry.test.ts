import { describe, expect, it } from 'vitest';
import { createBotRegistry } from '../../src/host/bot/registry';
import type { AgentLoopEvent } from '../../src/host/agent-loop';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';

/** 造一个脚本化引擎：按 script 顺序返回 EngineSendResult，记录所有 send 的文本。 */
function scriptedEngine(script: EngineSendResult[]): { engine: ModelEngine; sends: string[] } {
  const sends: string[] = [];
  let i = 0;
  const engine: ModelEngine = {
    name: 'web',
    async health() {
      return { ok: true };
    },
    async send(text: string) {
      sends.push(text);
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return next;
    },
  };
  return { engine, sends };
}

/** 造一个「阻塞引擎」：
 *  第一次 send 返回 toolCalls=1（触发续跑），
 *  第二次 send（续跑）阻塞直到 resolveBlocker 被调用，
 *  放行后返回 toolCalls=0（最终回答）。 */
function blockingEngine(): { engine: ModelEngine; blocker: Promise<void>; resolveBlocker: () => void; sends: string[] } {
  const sends: string[] = [];
  let i = 0;
  let resolveBlocker: () => void = () => {};
  const blocker = new Promise<void>((res) => {
    resolveBlocker = res;
  });
  const engine: ModelEngine = {
    name: 'web',
    async health() {
      return { ok: true };
    },
    async send(text: string) {
      sends.push(text);
      i += 1;
      if (i === 1) {
        // 第一次 send → 有工具调用，触发续跑
        return { content: '调工具中', toolCalls: 1 };
      }
      // 第二次 send（续跑）——阻塞，等测试侧放行
      await blocker;
      return { content: `回复-${i}`, toolCalls: 0 };
    },
  };
  return { engine, blocker, resolveBlocker, sends };
}

describe('BotRegistry —— v0.23 多 bot 去单例', () => {
  it('create 返回 BotInstance，loop/engine/slotId 就位', async () => {
    const { engine } = scriptedEngine([{ content: 'hi', toolCalls: 0 }]);
    const events: AgentLoopEvent[] = [];
    const reg = createBotRegistry({
      onEvent: (e) => events.push(e),
      createEngine: () => engine,
      loopOptions: { throttleBetweenSteps: false },
    });
    const bot = await reg.create({ botId: 'b1', slotId: 'S1' });

    expect(bot.id).toBe('b1');
    expect(bot.slotId).toBe('S1');
    expect(bot.engine).toBe(engine);
    expect(bot.loop.running).toBe(false);
  });

  it('get/list/destroy 生命周期', async () => {
    const { engine } = scriptedEngine([{ content: 'hi', toolCalls: 0 }]);
    const reg = createBotRegistry({ onEvent: () => {}, createEngine: () => engine });
    const b1 = await reg.create({ botId: 'b1', slotId: 'S1' });
    const b2 = await reg.create({ botId: 'b2', slotId: 'S2' });

    expect(reg.get('b1')).toBe(b1);
    expect(reg.get('b2')).toBe(b2);
    expect(reg.list().length).toBe(2);

    await reg.destroy('b1');
    expect(reg.get('b1')).toBeUndefined();
    expect(reg.list().length).toBe(1);
  });

  it('重复 botId 抛错', async () => {
    const { engine } = scriptedEngine([{ content: 'hi', toolCalls: 0 }]);
    const reg = createBotRegistry({ onEvent: () => {}, createEngine: () => engine });
    await reg.create({ botId: 'dup', slotId: 'S1' });
    await expect(reg.create({ botId: 'dup', slotId: 'S2' })).rejects.toThrow('already exists');
  });

  it('每个 bot 的 state 独立（counter/stopFlag/sessionAllowlist 不共享）', async () => {
    const { engine: e1 } = scriptedEngine([{ content: 'hi', toolCalls: 0 }]);
    const { engine: e2 } = scriptedEngine([{ content: 'hi', toolCalls: 0 }]);
    const reg = createBotRegistry({ onEvent: () => {}, createEngine: () => e1 });
    await reg.create({ botId: 'b1', slotId: 'S1', engine: e1 });
    await reg.create({ botId: 'b2', slotId: 'S2', engine: e2 });

    const s1 = reg.getState('b1')!;
    const s2 = reg.getState('b2')!;

    s1.toolCallCounter.current = 5;
    s2.toolCallCounter.current = 10;
    expect(s1.toolCallCounter.current).toBe(5);
    expect(s2.toolCallCounter.current).toBe(10);

    s1.sessionAllowlist.add('chat-send');
    expect(s2.sessionAllowlist.has('chat-send')).toBe(false);
  });

  it('两个 bot 并行 send 不互相阻塞（各自 running 独立）', async () => {
    const { engine: e1, resolveBlocker: resolve1, sends: sends1 } = blockingEngine();
    const { engine: e2, resolveBlocker: resolve2, sends: sends2 } = blockingEngine();
    const reg = createBotRegistry({
      onEvent: () => {},
      createEngine: () => e1,
      loopOptions: { throttleBetweenSteps: false },
    });

    const b1 = await reg.create({ botId: 'b1', slotId: 'S1', engine: e1 });
    const b2 = await reg.create({ botId: 'b2', slotId: 'S2', engine: e2 });

    // 两个 bot 同时 send —— 都会走到第二次 send（阻塞点）
    const p1 = b1.loop.send('任务1');
    const p2 = b2.loop.send('任务2');

    // 两个 bot 都在 running
    expect(b1.loop.running).toBe(true);
    expect(b2.loop.running).toBe(true);

    // 放行 b1 的阻塞 → b1 完成，b2 仍 running
    resolve1();
    await p1;
    expect(b1.loop.running).toBe(false);
    expect(b2.loop.running).toBe(true);

    // 放行 b2 → b2 也完成
    resolve2();
    await p2;
    expect(b2.loop.running).toBe(false);

    expect(sends1[0]).toBe('任务1');
    expect(sends2[0]).toBe('任务2');
  });

  it('事件流带 botId 标签', async () => {
    const { engine } = scriptedEngine([{ content: 'hi', toolCalls: 0 }]);
    const events: AgentLoopEvent[] = [];
    const reg = createBotRegistry({
      onEvent: (e) => events.push(e),
      createEngine: () => engine,
      loopOptions: { throttleBetweenSteps: false },
    });
    const bot = await reg.create({ botId: 'tagged-bot', slotId: 'S1' });

    await bot.loop.send('你好');

    // 所有事件都应该带 botId = 'tagged-bot'
    const taggedEvents = events.filter((e) => e.botId === 'tagged-bot');
    expect(taggedEvents.length).toBe(events.length);
    expect(events.some((e) => e.type === 'user' && e.botId === 'tagged-bot')).toBe(true);
    expect(events.some((e) => e.type === 'assistant' && e.botId === 'tagged-bot')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('缺省 botId 自动生成', async () => {
    const { engine } = scriptedEngine([{ content: 'hi', toolCalls: 0 }]);
    const reg = createBotRegistry({ onEvent: () => {}, createEngine: () => engine });
    const bot = await reg.create({ slotId: 'S1' });

    expect(bot.id).toMatch(/^bot-/);
    expect(bot.id.length).toBeGreaterThan('bot-'.length);
  });
});
