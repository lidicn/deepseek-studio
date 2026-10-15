/**
 * v0.28 收尾：聊天室结构化事件推送 + 洞察数打标（CB 数据/算法层）
 *
 * 对应路线图 §2.2 任务 A（ChatRoomEvent 结构化推送）+ 任务 C（insights 打标）。
 * 焦点：chat-room-runtime 产出的结构化事件 shape 是否干净、字段齐全、可被 UI 渲染/隔离；
 * chat-room-store 的 insights 列读写。不验证接线层 emit（desktop-host 的 no-op→emit 归 Claude）。
 *
 * 复用真 BotRegistry + 真 CB 算法层 + scriptedEngine（与 bot-chat-room-runtime.test.ts 同模式）。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBotRegistry } from '../../src/host/bot/registry';
import { createSlotRuntime } from '../../src/host/bot/slot-runtime';
import { createChatRoomRuntime } from '../../src/host/bot/chat-room-runtime';
import { createAgentInstructionBuilder } from '../../src/host/bot/instructions';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import { DefaultHandoffParser } from '../../src/host/bot/handoff-parser';
import { SqliteChatMessageStore } from '../../src/host/bot/chat-room-store';
import { SqliteContextEngine, SnapshotStore } from '../../src/host/bot/context-engine';
import { SqliteRoomSummaryService } from '../../src/host/bot/room-summary';
import { SqliteRoomStateStore } from '../../src/host/bot/meeting-state';
import type { ToolExecutionResult } from '../../src/host/desktop-host';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';
import type {
  ChatRoomBotReplyEvent,
  ChatRoomSummaryEvent,
  Persona,
  PersonaRegistry,
  RoomConfig,
} from '../../src/host/bot/types';
import type { AgentLoopEvent } from '../../src/host/agent-loop';
import { MemoryStore } from '../../src/host/memory-store';

const PERSONAS: Record<string, Persona> = {
  'frontend-expert': { name: 'frontend-expert', prompt: '你是前端工程专家。', tools: [], memoryDir: '' },
  'backend-expert': { name: 'backend-expert', prompt: '你是后端架构专家。', tools: [], memoryDir: '' },
  host: { name: 'host', prompt: '你是聊天室主持人。', tools: [], memoryDir: '' },
};

class FakePersonaRegistry implements PersonaRegistry {
  async load(name: string): Promise<Persona> {
    const p = PERSONAS[name];
    if (!p) throw new Error(`persona not found: ${name}`);
    return p;
  }
  list(): string[] {
    return Object.keys(PERSONAS);
  }
}

/** scriptedEngine：按 botId 返回不同回复。 */
function makeScriptedEngines() {
  const engines = new Map<string, { engine: ModelEngine; sent: string[]; reply: string }>();
  function forBot(botId: string) {
    let e = engines.get(botId);
    if (!e) {
      const sent: string[] = [];
      e = {
        sent,
        reply: '',
        engine: {
          name: 'web',
          async health() { return { ok: true }; },
          async send(text: string): Promise<EngineSendResult> {
            sent.push(text);
            return { content: e!.reply, toolCalls: 0 };
          },
        },
      };
      engines.set(botId, e);
    }
    return e;
  }
  return {
    engines,
    setReply(botId: string, reply: string) { forBot(botId).reply = reply; },
    ensureEngine: (botId: string) => forBot(botId).engine,
  };
}

async function setup(room: RoomConfig, opts?: { summaryEveryTurns?: number }) {
  const script = makeScriptedEngines();
  const listeners = new Set<(event: AgentLoopEvent) => void>();
  const registry = createBotRegistry({
    createEngine: ({ botId }) => script.ensureEngine(botId),
    onEvent: (event) => { for (const cb of listeners) { try { cb(event); } catch { /* ignore */ } } },
  });
  const onAgentEvent = (cb: (event: AgentLoopEvent) => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };
  const invokeTool = vi.fn(async (): Promise<ToolExecutionResult> => ({ ok: true }));
  const slotRuntime = createSlotRuntime({ registry, personas: new FakePersonaRegistry(), invokeTool });

  const mem = new MemoryStore(path.join(os.tmpdir(), `cb-ev-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  const messageStore = new SqliteChatMessageStore(mem);
  const snapshots = new SnapshotStore(mem);
  const summarizer = vi.fn(async () => '[stub-summary]');
  const contextEngine = new SqliteContextEngine({ messageStore, memoryStore: mem, summarizer: summarizer as never });
  const summaryService = new SqliteRoomSummaryService({
    messageStore, memoryStore: mem, summarizer: summarizer as never, snapshots,
    config: { summaryEveryTurns: opts?.summaryEveryTurns ?? 1 },
  });

  const mentionParser = new DefaultMentionParser();
  // v0.29：注入真 meetingState（独立表），让摘要门控按会议态生效。
  const meetingState = new SqliteRoomStateStore(mem);
  for (const name of room.memberPersonas) {
    if (!PERSONAS[name]) continue;
    await registry.create({ botId: name, slotId: name });
  }

  const onBotReply = vi.fn();
  const onSummary = vi.fn();
  const onMeetingStateChange = vi.fn();
  const runtime = createChatRoomRuntime({
    mentionParser,
    handoffParser: new DefaultHandoffParser(mentionParser),
    instructionBuilder: createAgentInstructionBuilder(),
    messageStore, contextEngine, summaryService,
    registry, slotRuntime, personas: new FakePersonaRegistry(),
    onAgentEvent, rooms: [room],
    onBotReply, onSummary, onMeetingStateChange,
    // v0.29 策略生成器缺省走兜底（不调主 bot，仅取默认阈值 3）。
    meetingState,
  });
  return { runtime, messageStore, summaryService, summarizer, script, onBotReply, onSummary, onMeetingStateChange, meetingState };
}

const ROOM: RoomConfig = {
  roomId: 'r1', roomName: '技术评审室', hostPersona: 'host',
  memberPersonas: ['frontend-expert', 'backend-expert', 'host'],
};

describe('ChatRoomEvent 结构化推送（v0.28 任务 A）', () => {
  it('onBotReply 产出干净的结构化 chat-bot-reply 事件（字段齐全 + 净内容 + 落盘 id）', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '前端视角：用 zustand 管状态。');

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 你怎么看？');

    expect(ctx.onBotReply).toHaveBeenCalledTimes(1);
    const e = ctx.onBotReply.mock.calls[0][0] as ChatRoomBotReplyEvent;
    expect(e.kind).toBe('chat-bot-reply');
    expect(e.roomId).toBe('r1');
    expect(e.persona).toBe('frontend-expert');
    expect(e.botId).toBe('frontend-expert');
    expect(e.senderType).toBe('sub-bot'); // botId !== 'main'
    expect(e.content).toBe('前端视角：用 zustand 管状态。');
    expect(typeof e.timestamp).toBe('number');
    // messageId 指向真实落盘消息，且该消息在 store 里可查到
    expect(typeof e.messageId).toBe('string');
    expect(e.messageId.startsWith('msg-')).toBe(true);
    const stored = ctx.runtime.getMessages('r1').find((m) => m.id === e.messageId);
    expect(stored).toBeDefined();
    expect(stored?.senderType).toBe('sub-bot');
    expect(stored?.content).toBe(e.content);
  });

  it('@all 多回复 → 每条 bot 回复各推一个 chat-bot-reply，persona/botId 各归各', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', 'FE 回复');
    ctx.script.setReply('backend-expert', 'BE 回复');
    ctx.script.setReply('host', 'HOST 回复');

    await ctx.runtime.handleUserMessage('r1', '@all 评估方案');

    expect(ctx.onBotReply).toHaveBeenCalledTimes(3);
    const events = ctx.onBotReply.mock.calls.map((c) => c[0] as ChatRoomBotReplyEvent);
    const byPersona = Object.fromEntries(events.map((e) => [e.persona, e.content]));
    expect(byPersona).toEqual({ 'frontend-expert': 'FE 回复', 'backend-expert': 'BE 回复', host: 'HOST 回复' });
    // 每条都带各自正确的 kind + roomId + messageId
    for (const e of events) {
      expect(e.kind).toBe('chat-bot-reply');
      expect(e.roomId).toBe('r1');
      expect(e.messageId.startsWith('msg-')).toBe(true);
    }
  });

  it('会议 active 且达阈值 → 摘要成功后推结构化 chat-summary 事件', async () => {
    // v0.29：摘要改为会议驱动。先 startMeeting（阈值 1），一轮回复后即触发摘要。
    const ctx = await setup(ROOM, { summaryEveryTurns: 1 });
    ctx.meetingState.startMeeting('r1', {
      focusTopics: ['测试议题'],
      minRoundsBeforeAutoSummary: 1,
    }, 'user');
    ctx.script.setReply('frontend-expert', '前端回复');

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 起头');

    expect(ctx.onSummary).toHaveBeenCalled();
    const e = ctx.onSummary.mock.calls[ctx.onSummary.mock.calls.length - 1][0] as ChatRoomSummaryEvent;
    expect(e.kind).toBe('chat-summary');
    expect(e.roomId).toBe('r1');
    expect(e.summary).toContain('[stub-summary]');
    expect(typeof e.throughMessageId).toBe('string');
    expect(e.throughMessageId.startsWith('msg-')).toBe(true);
    expect(typeof e.timestamp).toBe('number');
  });

  it('会议 active 但未达阈值 → 不推 chat-summary', async () => {
    // v0.29：阈值设为 999，一轮回复后仍未达阈值 → 不摘要。
    const ctx = await setup(ROOM, { summaryEveryTurns: 1 });
    ctx.meetingState.startMeeting('r1', {
      focusTopics: ['测试议题'],
      minRoundsBeforeAutoSummary: 999,
    }, 'user');
    ctx.script.setReply('frontend-expert', '前端回复');

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 起头');

    // 会议已开但轮数未达 999 → 不摘要 → 不推摘要事件
    expect(ctx.onSummary).not.toHaveBeenCalled();
  });

  it('无会议（idle）→ 即使有 bot 回复也不推 chat-summary（v0.29 修复每轮总结）', async () => {
    // 未 startMeeting → status=idle → 摘要门控跳过 → 修复 v0.28 每条消息都总结的缺陷。
    const ctx = await setup(ROOM, { summaryEveryTurns: 1 });
    ctx.script.setReply('frontend-expert', '前端回复');

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 起头');

    expect(ctx.onSummary).not.toHaveBeenCalled();
  });

  it('摘要器 throw → 不推 chat-summary，快照不污染，轮数不重置', async () => {
    // 真机缺陷回归：摘要器超时时 summarize() 仍 resolve（内部 release）。
    // 若仅凭「调过 summarize」就推，会把上一份快照原样重推（陈旧内容重复）。
    // 正确行为：不推事件、快照 lastMessageId 不前进、轮数保留以便下轮重试。
    const ctx = await setup(ROOM, { summaryEveryTurns: 1 });
    ctx.meetingState.startMeeting('r1', { focusTopics: ['议题'], minRoundsBeforeAutoSummary: 1 }, 'user');
    ctx.script.setReply('frontend-expert', '前端回复');
    ctx.summarizer.mockImplementation(async () => { throw new Error('bot timeout'); });

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 起头');

    expect(ctx.onSummary).not.toHaveBeenCalled();
    const snap = ctx.summaryService.getSummary('r1');
    expect(snap?.lastMessageId).toBe('');          // claim→release 未提交 → 无落盘消息
    expect(snap?.summarizedTurnCount).toBe(0);
    expect(ctx.meetingState.get('r1')?.roundsSinceSummary).toBe(1); // 未重置
  });

  it('摘要失败不重置轮数 → 下一轮成功才推一次', async () => {
    // 轮数反映「已总结覆盖到的进度」：总结没成功就该保留，下轮一起摘要。
    // 若失败也清零，那批消息会被跳过，永不进摘要。
    const ctx = await setup(ROOM, { summaryEveryTurns: 1 });
    ctx.meetingState.startMeeting('r1', { focusTopics: ['议题'], minRoundsBeforeAutoSummary: 1 }, 'user');
    ctx.script.setReply('frontend-expert', '前端回复');
    ctx.summarizer.mockImplementation(async () => { throw new Error('bot timeout'); });

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 起头');
    expect(ctx.onSummary).not.toHaveBeenCalled();

    ctx.summarizer.mockImplementation(async () => '[stub-summary]');
    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 继续');

    expect(ctx.onSummary).toHaveBeenCalledTimes(1);
    const e = ctx.onSummary.mock.calls[0][0] as ChatRoomSummaryEvent;
    expect(e.summary).toContain('[stub-summary]');
    expect(ctx.meetingState.get('r1')?.roundsSinceSummary).toBe(0); // 成功后才清零
  });

  it('散会时摘要失败 → 仍正常散会，且不推陈旧摘要', async () => {
    // 散会不阻断于摘要失败（fail-soft）；但也不该因此推一份没更新的内容。
    const ctx = await setup(ROOM, { summaryEveryTurns: 1 });
    ctx.meetingState.startMeeting('r1', { focusTopics: ['议题'], minRoundsBeforeAutoSummary: 999 }, 'user');
    ctx.script.setReply('frontend-expert', '前端回复');
    ctx.summarizer.mockImplementation(async () => { throw new Error('bot timeout'); });

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 起头');
    await ctx.runtime.handleUserMessage('r1', '散会');

    expect(ctx.onSummary).not.toHaveBeenCalled();
    expect(ctx.meetingState.get('r1')?.status).toBe('closed');
    expect(ctx.onMeetingStateChange).toHaveBeenCalledWith('r1', 'closed', null);
  });
});

describe('MessageInsight 洞察数打标（v0.28 任务 C）', () => {
  it('tagInsights 写入后可被 getMessages 读回（count/reviewer/taggedAt 齐全）', async () => {
    const ctx = await setup(ROOM);
    const m = ctx.messageStore.append({
      roomId: 'r1', senderId: 'frontend-expert', senderType: 'sub-bot', content: '回复', timestamp: Date.now(), mentions: [],
    });
    // 打标前无 insights
    expect(ctx.runtime.getMessages('r1').find((x) => x.id === m.id)?.insights).toBeUndefined();

    const ok = ctx.messageStore.tagInsights('r1', m.id, { count: 3, reviewer: 'cb-eval' });
    expect(ok).toBe(true);
    const read = ctx.runtime.getMessages('r1').find((x) => x.id === m.id)?.insights;
    expect(read?.count).toBe(3);
    expect(read?.reviewer).toBe('cb-eval');
    expect(typeof read?.taggedAt).toBe('number');
  });

  it('tagInsights 覆盖写：重复打标取最后一次', async () => {
    const ctx = await setup(ROOM);
    const m = ctx.messageStore.append({
      roomId: 'r1', senderId: 'x', senderType: 'sub-bot', content: 'c', timestamp: Date.now(), mentions: [],
    });
    ctx.messageStore.tagInsights('r1', m.id, { count: 2 });
    ctx.messageStore.tagInsights('r1', m.id, { count: 5, reviewer: 'second' });
    const read = ctx.runtime.getMessages('r1').find((x) => x.id === m.id)?.insights;
    expect(read?.count).toBe(5);
    expect(read?.reviewer).toBe('second');
  });

  it('tagInsights 命中不存在的消息 → false，不影响其它消息', async () => {
    const ctx = await setup(ROOM);
    const m = ctx.messageStore.append({
      roomId: 'r1', senderId: 'x', senderType: 'sub-bot', content: 'c', timestamp: Date.now(), mentions: [],
    });
    expect(ctx.messageStore.tagInsights('r1', 'no-such-id', { count: 1 })).toBe(false);
    expect(ctx.messageStore.tagInsights('no-such-room', m.id, { count: 1 })).toBe(false);
    expect(ctx.runtime.getMessages('r1').find((x) => x.id === m.id)?.insights).toBeUndefined();
  });
});
