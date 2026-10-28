/**
 * QD-R16 探针：先证明「我这把尺」本身的行为，再谈缺陷。
 * P1 真 AgentLoop 的 assistant 事件能否被临时 listener 在同一次 await 内捕获
 * P2 引擎仍在跑时第二次 send 的 busy 语义
 * P3 addPermanent 后 has() 与 getState 对象同一性
 * P4 完整 runtime 链路的逐事件转储（定位 CONTROL 空回复到底在哪一步）
 */
import { describe, expect, it } from 'vitest';
import { createBotRegistry } from '../../src/host/bot/registry';
import { createChatRoomRuntime } from '../../src/host/bot/chat-room-runtime';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import { DefaultHandoffParser } from '../../src/host/bot/handoff-parser';
import { createAgentInstructionBuilder } from '../../src/host/bot/instructions';
import type { AgentLoopEvent } from '../../src/host/agent-loop';
import type {
  ChatContext,
  ChatMessage,
  ChatMessageStore,
  ContextEngine,
  Persona,
  RoomConfig,
  RoomSummaryService,
} from '../../src/host/bot/types';
import type { SlotRuntime } from '../../src/host/bot/slot-runtime';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function personaOf(name: string): Persona {
  return { name, prompt: `你是 ${name}`, tools: [], memoryDir: `/tmp/${name}` };
}

function makeStore(): ChatMessageStore {
  const all: ChatMessage[] = [];
  let seq = 0;
  return {
    append(msg) {
      const stored = { ...msg, id: msg.id ?? `msg-${++seq}` } as ChatMessage;
      all.push(stored);
      return stored;
    },
    getMessages(roomId, opts) {
      const rows = all.filter((m) => m.roomId === roomId);
      const sliced = opts?.limit ? rows.slice(-opts.limit) : rows;
      if (!opts?.throughMessageId) return sliced;
      const idx = sliced.findIndex((m) => m.id === opts.throughMessageId);
      return idx < 0 ? sliced : sliced.slice(0, idx + 1);
    },
    count: (roomId) => all.filter((m) => m.roomId === roomId).length,
    tagInsights: () => false,
  };
}

const contextEngine: ContextEngine = {
  async buildContext() {
    const ctx: ChatContext = {
      systemPrompt: '房间摘要（测试桩）',
      messages: [{ role: 'user', content: '历史消息（测试桩）' }],
      meta: { totalMessages: 1, verbatimCount: 1, hadSnapshot: false, compressed: false },
    };
    return ctx;
  },
  getSnapshot: () => null,
};

const summaryService: RoomSummaryService = {
  async summarize() { /* 不驱动摘要快照 */ },
  getSummary: () => null,
};

function makeSlotRuntime(): SlotRuntime {
  const loadedMap = new Map<string, Persona>();
  const rt = {
    async loadPersona(botId: string, personaName: string) {
      const p = personaOf(personaName);
      loadedMap.set(botId, p);
      return p;
    },
    async unloadPersona(botId: string) { loadedMap.delete(botId); },
    loaded(botId: string) {
      const p = loadedMap.get(botId);
      return p ? { persona: p, promptView: p.prompt, whitelist: [], botId } : undefined;
    },
    executorFor: () => undefined,
    async run() { return ''; },
    renderPersonaBlock: (p: Persona) => `<persona:${p.name}>`,
    renderTaskText: () => '',
  };
  return rt as unknown as SlotRuntime;
}

describe('QD-R16 probe', () => {
  it('P1：真 loop 的 assistant 事件在同一次 await 内可达 listener', async () => {
    const bus = new Set<(e: AgentLoopEvent) => void>();
    const registry = createBotRegistry({
      createEngine: () => ({
        async send() {
          await sleep(30);
          return { content: '引擎最终回复', toolCalls: 0, timedOut: false };
        },
        isStopped: () => false,
      }),
      onEvent: (event) => { for (const cb of bus) cb(event); },
      loopOptions: { throttleBetweenSteps: false },
    });
    await registry.create({ botId: 'analyst', slotId: 'analyst' });
    const bot = registry.get('analyst')!;

    const seen: string[] = [];
    let captured = '';
    const listener = (e: AgentLoopEvent): void => {
      seen.push(`${e.type}/${e.botId}/${e.text ? e.text.slice(0, 8) : ''}`);
      if (e.botId === 'analyst' && e.type === 'assistant' && e.text) captured = e.text;
    };
    bus.add(listener);
    await bot.loop.send('正文', { roomId: 'room-x' });
    bus.delete(listener);

    console.log(`[P1] captured=${JSON.stringify(captured)} 事件=${JSON.stringify(seen)}`);
    expect(captured).toBe('引擎最终回复');
  });

  it('P2：引擎在跑时第二次 send 的 busy 语义', async () => {
    const registry = createBotRegistry({
      createEngine: () => ({
        async send() { await sleep(400); return { content: 'r', toolCalls: 0, timedOut: false }; },
        isStopped: () => false,
      }),
      onEvent: () => { /* noop */ },
      loopOptions: { throttleBetweenSteps: false },
    });
    await registry.create({ botId: 'analyst', slotId: 'analyst' });
    const bot = registry.get('analyst')!;
    const first = bot.loop.send('第一条');
    await sleep(50);
    const t0 = Date.now();
    let secondError = '(no throw)';
    try {
      await bot.loop.send('第二条');
    } catch (err) {
      secondError = err instanceof Error ? err.message : String(err);
    }
    console.log(`[P2] secondError=${JSON.stringify(secondError)} 第二次耗时=${Date.now() - t0}ms running=${bot.loop.running}`);
    await first;
    expect(secondError).toBe('agent-busy');
  });

  it('P3：addPermanent 后 has() 为真且 getState 返回同一对象', async () => {
    const registry = createBotRegistry({
      createEngine: () => ({ async send() { return { content: 'x', toolCalls: 0, timedOut: false }; }, isStopped: () => false }),
      onEvent: () => { /* noop */ },
      loopOptions: { throttleBetweenSteps: false },
    });
    await registry.create({ botId: 'analyst', slotId: 'analyst' });
    const state = registry.getState('analyst');
    const before = state?.sessionAllowlist.has('chat-send', { a: 1 });
    state?.sessionAllowlist.addPermanent('chat-send');
    const again = registry.getState('analyst');
    console.log(
      `[P3] hasBefore=${before} hasAfter=${state?.sessionAllowlist.has('chat-send', { a: 1 })} `
      + `同一对象=${state === again} hasViaAgain=${again?.sessionAllowlist.has('chat-send', { a: 1 })}`,
    );
    expect(state?.sessionAllowlist.has('chat-send', { a: 1 })).toBe(true);
  });

  it('P4：完整 runtime 链路逐事件转储', async () => {
    const bus = new Set<(e: AgentLoopEvent) => void>();
    const registry = createBotRegistry({
      createEngine: ({ botId }) => ({
        async send() {
          await sleep(60);
          return { content: `【${botId}】分析结论`, toolCalls: 0, timedOut: false };
        },
        isStopped: () => false,
      }),
      onEvent: (event) => { for (const cb of bus) cb(event); },
      loopOptions: { throttleBetweenSteps: false },
    });
    await registry.create({ botId: 'analyst', slotId: 'analyst' });

    // 转储所有到 bus 的事件
    const dump: string[] = [];
    bus.add((e) => { dump.push(`${e.type}/${e.botId}/${e.roomId ?? '-'}/${e.text ? e.text.slice(0, 10) : ''}`); });

    const room = {
      roomId: 'room-qd16',
      roomName: '守门席测试房',
      hostPersona: 'analyst',
      memberPersonas: ['analyst'],
    } as RoomConfig;
    const mentionParser = new DefaultMentionParser();
    const roundEvents: string[] = [];
    const botReplies: string[] = [];
    const runtime = createChatRoomRuntime({
      mentionParser,
      handoffParser: new DefaultHandoffParser(mentionParser),
      instructionBuilder: createAgentInstructionBuilder(),
      messageStore: makeStore(),
      contextEngine,
      summaryService,
      registry,
      slotRuntime: makeSlotRuntime(),
      personas: { get: () => personaOf('analyst'), list: () => [personaOf('analyst')] } as never,
      onAgentEvent: (cb) => { bus.add(cb); return () => bus.delete(cb); },
      rooms: [room],
      maxDepth: 1,
      onBotReply: (e) => botReplies.push(JSON.stringify(e.content)),
      onRoundComplete: (r) => roundEvents.push(JSON.stringify(r.contents)),
    });

    const round = await runtime.handleUserMessage('room-qd16', '@analyst 你好');
    console.log(`[P4] round=${JSON.stringify(round.contents)} members=${JSON.stringify(round.members)}`);
    console.log(`[P4] onBotReply=${JSON.stringify(botReplies)} onRoundComplete=${JSON.stringify(roundEvents)}`);
    console.log(`[P4] bus 事件=${JSON.stringify(dump)}`);
    expect(round.contents['analyst']).not.toBe('');
  });
});
