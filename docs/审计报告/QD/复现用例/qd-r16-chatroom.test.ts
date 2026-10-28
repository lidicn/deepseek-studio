/**
 * QD-R16 复现件 · 聊天室：无房间级 busy 闸门 × fail-soft 吞错 × 永久预授权 × 落盘异常吞掉 round-complete
 *
 * 真用：createBotRegistry（真 AgentLoop / 真 SessionAllowlist）、createChatRoomRuntime、
 *      DefaultRoundOrchestrator（runtime 内部）、DefaultMentionParser、DefaultHandoffParser、
 *      createAgentInstructionBuilder、createModelSummarizer。
 * 假用：ModelEngine（可控延迟/文本）、ChatMessageStore / ContextEngine / RoomSummaryService /
 *      SlotRuntime / PersonaRegistry（纯数据桩）。
 * 桩对齐事实：slot-runtime.ts:186 `instance.persona = persona` —— loadPersona 会把人设写回
 *      BotInstance，故本桩的 loadPersona 同样写 registry.get(botId).persona（否则 generateReply
 *      的 `bot.persona ?? loaded?.persona` 读不到，属桩缺陷非产品缺陷）。
 * 面：src/host/bot/** 在 HEAD `dcedede` 与工作树同字节（registry.ts=632df7df，
 *      chat-room-runtime.ts=faf705a，agent-loop.ts=57f5dfa9）⇒ HEAD 面与盘面同读。
 */
import { describe, expect, it } from 'vitest';
import { createBotRegistry, type BotRegistryInternal } from '../../src/host/bot/registry';
import { createChatRoomRuntime, createModelSummarizer } from '../../src/host/bot/chat-room-runtime';
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

function makePersona(name: string): Persona {
  return { name, prompt: `你是 ${name}`, tools: [], memoryDir: `/tmp/${name}` };
}

function makeStore(opts?: { throwOnBotReply?: boolean }): ChatMessageStore & { all: ChatMessage[] } {
  const all: ChatMessage[] = [];
  let seq = 0;
  return {
    all,
    append(msg) {
      if (opts?.throwOnBotReply && msg.senderType !== 'user') {
        throw new Error('sqlite: disk I/O error（模拟落盘失败）');
      }
      const stored = { ...msg, id: msg.id ?? `msg-${++seq}` } as ChatMessage;
      all.push(stored);
      return stored;
    },
    getMessages(roomId, opts2) {
      const rows = all.filter((m) => m.roomId === roomId);
      const sliced = opts2?.limit ? rows.slice(-opts2.limit) : rows;
      if (!opts2?.throughMessageId) return sliced;
      const idx = sliced.findIndex((m) => m.id === opts2.throughMessageId);
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
  async summarize() { /* 本件不驱动摘要快照 */ },
  getSummary: () => null,
};

/** 桩的关键：与 slot-runtime.ts:186 对齐，loadPersona 写回 BotInstance.persona。 */
function makeSlotRuntime(registry: BotRegistryInternal): SlotRuntime {
  const loadedMap = new Map<string, Persona>();
  const rt = {
    async loadPersona(botId: string, personaName: string) {
      const p = makePersona(personaName);
      loadedMap.set(botId, p);
      const bot = registry.get(botId);
      if (bot) (bot as { persona?: Persona }).persona = p; // 对齐 slot-runtime.ts:186
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

interface Harness {
  registry: BotRegistryInternal;
  runtime: ReturnType<typeof createChatRoomRuntime>;
  bus: Set<(e: AgentLoopEvent) => void>;
  replies: { persona: string; content: string; roomId: string }[];
  rounds: number;
  engineDelayMs: { value: number };
  lastEngineText: { value: string };
}

function buildHarness(storeOpts?: { throwOnBotReply?: boolean }): Harness {
  const bus = new Set<(e: AgentLoopEvent) => void>();
  const engineDelayMs = { value: 400 };
  const lastEngineText = { value: '' };
  const rounds = { value: 0 };

  const registry = createBotRegistry({
    // 假引擎只返回文本；assistant 事件由真 AgentLoop 自己 emit（探针 P1 已实证）。
    createEngine: ({ botId }) => ({
      async send() {
        await sleep(engineDelayMs.value);
        return {
          content: lastEngineText.value || `【${botId}】对提问的回复 @未注册名`,
          toolCalls: 0,
          timedOut: false,
        };
      },
      isStopped: () => false,
    }),
    onEvent: (event) => { for (const cb of bus) cb(event); },
    loopOptions: { throttleBetweenSteps: false },
  });

  const replies: Harness['replies'] = [];
  const room: RoomConfig = {
    roomId: 'room-qd16',
    roomName: '守门席测试房',
    hostPersona: 'analyst',
    memberPersonas: ['analyst'],
  } as RoomConfig;

  const mentionParser = new DefaultMentionParser();
  const runtime = createChatRoomRuntime({
    mentionParser,
    handoffParser: new DefaultHandoffParser(mentionParser),
    instructionBuilder: createAgentInstructionBuilder(),
    messageStore: makeStore(storeOpts),
    contextEngine,
    summaryService,
    registry,
    slotRuntime: makeSlotRuntime(registry),
    personas: { get: () => makePersona('analyst'), list: () => [makePersona('analyst')] } as never,
    onAgentEvent: (cb) => { bus.add(cb); return () => bus.delete(cb); },
    rooms: [room],
    maxDepth: 1,
    onBotReply: (event) => replies.push({ persona: event.persona, content: event.content, roomId: event.roomId }),
    onRoundComplete: () => { rounds.value += 1; },
  });

  return { registry, runtime, bus, replies, get rounds() { return rounds.value; }, engineDelayMs, lastEngineText };
}

async function ensureBot(h: Harness, botId: string): Promise<void> {
  if (!h.registry.get(botId)) await h.registry.create({ botId, slotId: botId });
}

describe('QD-R16 · 聊天室并发闸门与 fail-soft', () => {
  it('CONTROL：单条消息 → 真 loop 回话 → 房间拿到非空回复并落盘', async () => {
    const h = buildHarness();
    await ensureBot(h, 'analyst');
    h.engineDelayMs.value = 60;
    h.lastEngineText.value = '这是分析结论';

    const round = await h.runtime.handleUserMessage('room-qd16', '@analyst 你好');
    console.log(`[CONTROL] members=${JSON.stringify(round.members)} contents=${JSON.stringify(round.contents)} 气泡=${JSON.stringify(h.replies.map((r) => r.content))}`);
    expect(round.contents['analyst']).toContain('这是分析结论');
    expect(h.replies.length).toBe(1);
    expect(h.rounds).toBe(1);
  });

  it('REPRO-A：同房间连发两条 ⇒ 第二条撞真 busy 闸门，fail-soft 记成空回复并落盘+推气泡', async () => {
    const h = buildHarness();
    await ensureBot(h, 'analyst');
    h.engineDelayMs.value = 500;
    h.lastEngineText.value = '第一条的正常回复';

    const first = h.runtime.handleUserMessage('room-qd16', '@analyst 第一个问题');
    await sleep(60);
    const t0 = Date.now();
    const second = await h.runtime.handleUserMessage('room-qd16', '@analyst 第二个问题');
    const secondCost = Date.now() - t0;
    await first;

    const store = h.runtime.getMessages('room-qd16');
    console.log(
      `[REPRO-A] 第二轮 members=${JSON.stringify(second.members)} contents=${JSON.stringify(second.contents)} `
      + `用时=${secondCost}ms 气泡=${JSON.stringify(h.replies.map((r) => r.content))}`,
    );
    console.log(`[REPRO-A] 房间消息=${JSON.stringify(store.map((m) => `${m.senderType}:${JSON.stringify(m.content)}`))}`);
    expect.soft(secondCost, '第二轮被排到第一轮之后（>400ms）').toBeLessThan(400);
    expect.soft(
      h.replies.some((r) => r.content.includes('第二个问题') || r.content.toLowerCase().includes('busy')),
      '第二个问题得到了任何形式的回应',
    ).toBe(true);
    expect.soft(second.contents['analyst'], 'fail-soft 把 agent-busy 记成空回复').not.toBe('');
    expect.soft(store.some((m) => m.senderType !== 'user' && m.content === ''), '房间历史里出现了空的 bot 消息').toBe(false);
  });

  it('REPRO-B：摘要器超时后 loop 未释放 ⇒ 此后一段时间整房静默（空回复落盘）', async () => {
    const h = buildHarness();
    await ensureBot(h, 'analyst');
    const summarizer = createModelSummarizer({
      registry: h.registry,
      onAgentEvent: (cb) => { h.bus.add(cb); return () => h.bus.delete(cb); },
      summarizerBotId: 'analyst',
      timeoutMs: 150,
    });

    h.engineDelayMs.value = 1200;
    h.lastEngineText.value = '这段摘要永远不会被任何人读到';
    let summaryError = '';
    try {
      await summarizer([{ id: 'm1', roomId: 'room-qd16', senderId: 'u', senderType: 'user', content: 'x', timestamp: 1, mentions: [] }]);
    } catch (err) {
      summaryError = err instanceof Error ? err.message : String(err);
    }
    console.log(`[REPRO-B] 摘要器抛错=${JSON.stringify(summaryError)} running=${h.registry.get('analyst')!.loop.running}`);
    expect.soft(summaryError).toContain('timeout');
    expect.soft(h.registry.get('analyst')!.loop.running, '摘要超时后 loop 仍 active').toBe(false);

    const busyRound = await h.runtime.handleUserMessage('room-qd16', '@analyst 摘要之后的新问题');
    console.log(`[REPRO-B] 新问题回复=${JSON.stringify(busyRound.contents)}`);
    expect(busyRound.contents['analyst'], '摘要超时后 loop 未释放，新问题被 busy 吞掉').not.toBe('');
  });

  it('REPRO-C：聊天室给 chat-send / chat-insert 打的永久预授权⛔ 不回滚', async () => {
    const h = buildHarness();
    await ensureBot(h, 'analyst');
    h.engineDelayMs.value = 40;
    const state = h.registry.getState('analyst');
    console.log(`[REPRO-C] 进房前 chat-send=${state?.sessionAllowlist.has('chat-send', { text: '任意参数' })}`);

    await h.runtime.handleUserMessage('room-qd16', '@analyst 你好');

    const afterSend = state?.sessionAllowlist.has('chat-send', { text: '与房间无关的正文' });
    const afterInsert = state?.sessionAllowlist.has('chat-insert', { text: '与房间无关的插入' });
    console.log(`[REPRO-C] 走过一次房间回复后 chat-send=${afterSend} chat-insert=${afterInsert}`);
    expect.soft(h.registry.get('analyst')!.loop.running, '轮次结束后 loop 已释放').toBe(false);
    expect.soft(afterSend, '房间结束后 chat-send 仍是永久免检').toBe(false);
    expect(afterInsert, '房间结束后 chat-insert 仍是永久免检').toBe(false);
  });

  it('REPRO-D：回复落盘抛错 ⇒ round-complete 不推，聊天室输入框永久锁死', async () => {
    const h = buildHarness({ throwOnBotReply: true });
    await ensureBot(h, 'analyst');
    h.engineDelayMs.value = 40;
    h.lastEngineText.value = '已经生成好的回复';

    let thrown = '';
    try {
      await h.runtime.handleUserMessage('room-qd16', '@analyst 你好');
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    console.log(`[REPRO-D] handleUserMessage 抛出=${JSON.stringify(thrown)} round-complete 次数=${h.rounds} 气泡=${JSON.stringify(h.replies.map((r) => r.content))}`);
    // UI 只靠 round-complete（或 main done）复位 roundInProgress；两者都没来。
    expect.soft(thrown, '落盘异常向调用方抛出（agent-channel 已先 ack(true)）').not.toBe('');
    expect(h.rounds, '异常路径仍然推出了 round-complete').toBe(1);
  });
});
