/**
 * v0.27：ChatRoomRuntime 接线层测试
 *
 * 验证「用户消息 → 路由 → 编排 → 回复回收 → 接力/告警」全流程。
 * 用真 BotRegistry + 真 CB 算法层 + 假 MemoryStore（内存降级）+ scriptedEngine。
 *
 * 焦点：接线层装配是否正确（generateReply 捕获、botId 过滤、消息持久化、
 * unresolved 上报、向后兼容），不是算法正确性（那是 CB 的单测覆盖的）。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBotRegistry } from '../../src/host/bot/registry';
import { createSlotRuntime } from '../../src/host/bot/slot-runtime';
import { createChatRoomRuntime, createModelSummarizer } from '../../src/host/bot/chat-room-runtime';
import { createAgentInstructionBuilder } from '../../src/host/bot/instructions';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import { DefaultHandoffParser } from '../../src/host/bot/handoff-parser';
import { SqliteChatMessageStore } from '../../src/host/bot/chat-room-store';
import { SqliteContextEngine, SnapshotStore } from '../../src/host/bot/context-engine';
import { SqliteRoomSummaryService } from '../../src/host/bot/room-summary';
import type { ToolExecutionResult } from '../../src/host/desktop-host';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';
import type { Persona, PersonaRegistry, RoomConfig } from '../../src/host/bot/types';
import type { AgentLoop, AgentLoopEvent } from '../../src/host/agent-loop';
import { MemoryStore } from '../../src/host/memory-store';

// ── 人设 ──────────────────────────────────────────────
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

// ── scriptedEngine：按 botId 返回不同回复（含 @接力标记）────
function makeScriptedEngines(): {
  engines: Map<string, { engine: ModelEngine; sent: string[]; reply: string }>;
  setReply: (botId: string, reply: string) => void;
  ensureEngine: (botId: string) => ModelEngine;
  events: AgentLoopEvent[];
} {
  const engines = new Map<string, { engine: ModelEngine; sent: string[]; reply: string }>();
  const events: AgentLoopEvent[] = [];

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
    events,
    setReply(botId: string, reply: string) { forBot(botId).reply = reply; },
    ensureEngine: (botId: string) => forBot(botId).engine,
  };
}

// ── 装配 ───────────────────────────────────────────────
async function setup(room: RoomConfig, opts?: { maxDepth?: number }) {
  const script = makeScriptedEngines();
  const { events } = script;

  const registry = createBotRegistry({
    createEngine: ({ botId }) => script.ensureEngine(botId),
    onEvent: (event) => {
      events.push(event);
      for (const cb of listeners) {
        try { cb(event); } catch { /* ignore */ }
      }
    },
  });

  // agentListeners 多消费者广播
  const listeners = new Set<(event: AgentLoopEvent) => void>();
  const onAgentEvent = (cb: (event: AgentLoopEvent) => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };

  const invokeTool = vi.fn(async (): Promise<ToolExecutionResult> => ({ ok: true }));
  const slotRuntime = createSlotRuntime({
    registry,
    personas: new FakePersonaRegistry(),
    invokeTool,
  });

  // 每次调用给独立 db 文件：消息不跨测试泄漏（r1 在 test 1 写入会污染 test 10）。
  const mem = new MemoryStore(path.join(os.tmpdir(), `studio-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  const messageStore = new SqliteChatMessageStore(mem);
  const snapshots = new SnapshotStore(mem);
  const summarizer = vi.fn(async () => '[stub-summary]');
  const contextEngine = new SqliteContextEngine({ messageStore, memoryStore: mem, summarizer: summarizer as never });
  const summaryService = new SqliteRoomSummaryService({ messageStore, memoryStore: mem, summarizer: summarizer as never, snapshots });

  const mentionParser = new DefaultMentionParser();
  const handoffParser = new DefaultHandoffParser(mentionParser);
  const instructionBuilder = createAgentInstructionBuilder();

  // 预创建房间成员对应的 bot（botId = persona 名）。
  // 只创建已注册 persona（PERSONAS 表里有）；未注册的不创建 bot → 不进 participants。
  const bots: AgentLoop[] = [];
  for (const name of room.memberPersonas) {
    if (!PERSONAS[name]) continue;
    bots.push((await registry.create({ botId: name, slotId: name })).loop);
  }

  const onBotReply = vi.fn();
  const onUnresolved = vi.fn();
  const onRoundComplete = vi.fn();

  const runtime = createChatRoomRuntime({
    mentionParser, handoffParser, instructionBuilder,
    messageStore, contextEngine, summaryService,
    registry, slotRuntime, personas: new FakePersonaRegistry(),
    onAgentEvent, rooms: [room], maxDepth: opts?.maxDepth,
    onBotReply, onUnresolved, onRoundComplete,
  });

  return { runtime, registry, script, events, messageStore, bots, onBotReply, onUnresolved, onRoundComplete, summarizer };
}

const ROOM: RoomConfig = {
  roomId: 'r1', roomName: '技术评审室', hostPersona: 'host',
  memberPersonas: ['frontend-expert', 'backend-expert', 'host'],
};

describe('chat-room-runtime 接线层', () => {
  it('1. @具体名路由：@frontend-expert → 只 frontend-expert 回', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '前端视角：组件状态管理建议用 zustand。');

    const round = await ctx.runtime.handleUserMessage('r1', '@frontend-expert 你怎么看组件状态管理？');

    expect(round.members).toEqual(['frontend-expert']);
    expect(round.contents['frontend-expert']).toContain('zustand');
    // frontend-expert 收到了带 AGENT_SENTINEL 的消息
    const feSent = ctx.script.engines.get('frontend-expert')!.sent;
    expect(feSent.some((s) => s.startsWith('【Studio Agent】'))).toBe(true);
    // backend-expert 没被唤醒
    expect(round.members).not.toContain('backend-expert');
  });

  it('2. @all 全员：所有已注册成员都回', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', 'FE 回复');
    ctx.script.setReply('backend-expert', 'BE 回复');
    ctx.script.setReply('host', 'HOST 回复');

    const round = await ctx.runtime.handleUserMessage('r1', '@all 大家评估下方案');

    expect(round.members).toContain('frontend-expert');
    expect(round.members).toContain('backend-expert');
    expect(round.members).toContain('host');
    // 三个都回了
    expect(round.contents['frontend-expert']).toBe('FE 回复');
    expect(round.contents['backend-expert']).toBe('BE 回复');
    expect(round.contents['host']).toBe('HOST 回复');
  });

  it('3. 无@主持人兜底：只 host 回', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('host', '主持人兜底回复');

    const round = await ctx.runtime.handleUserMessage('r1', '今天讨论什么？');

    expect(round.members).toEqual(['host']);
    expect(round.contents['host']).toContain('兜底');
  });

  it('4. 接力 pendingHandoff：frontend 回复 @backend-expert → pendingHandoff 含 backend，本轮不执行', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '前端这边 OK。@backend-expert 后端接口准备好了吗？');

    const round = await ctx.runtime.handleUserMessage('r1', '@frontend-expert 前端做完了吗？');

    expect(round.members).toEqual(['frontend-expert']);
    // @backend-expert 被识别为接力目标，进 pendingHandoff，本轮不执行
    expect(round.pendingHandoff).toContain('backend-expert');
    expect(round.members).not.toContain('backend-expert');
  });

  it('5. unresolved 告警：回复里 @拼错的名字 → onUnresolved 被调', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '我觉得 @typo-name 说得不对。');

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 评价下');

    // @typo-name 不在 participants → unresolved 上报
    expect(ctx.onUnresolved).toHaveBeenCalled();
    const args = ctx.onUnresolved.mock.calls[0];
    expect(args[0]).toBe('r1');
    expect(args[1]).toEqual(expect.arrayContaining(['typo-name']));
  });

  it('6. 两轮编排：第 2 轮用 @接力目标 的消息 → 该目标被路由命中', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '前端搞定。@backend-expert 该你了');
    ctx.script.setReply('backend-expert', '后端也搞定');

    // 第 1 轮：@frontend → frontend 回，接力到 backend（pendingHandoff）
    const round1 = await ctx.runtime.handleUserMessage('r1', '@frontend-expert 前端做完了吗？');
    expect(round1.pendingHandoff).toContain('backend-expert');
    expect(round1.members).not.toContain('backend-expert');

    // 第 2 轮：用 @backend-expert 续轮（调用方决定续轮 trigger）
    const round2 = await ctx.runtime.handleUserMessage('r1', '@backend-expert 你那边呢？');
    expect(round2.members).toContain('backend-expert');
    expect(round2.contents['backend-expert']).toBe('后端也搞定');
  });

  it('7. fail-soft：某 bot 引擎抛错 → 该 persona contents 留空，整轮不炸', async () => {
    const ctx = await setup(ROOM);
    // 让 frontend 的引擎 send 抛错
    const fe = ctx.script.engines.get('frontend-expert')!;
    const origSend = fe.engine.send;
    fe.engine.send = async () => { throw new Error('engine crash'); };
    // @all 让 frontend 也参与
    ctx.script.setReply('backend-expert', 'BE 正常');
    ctx.script.setReply('host', 'HOST 正常');

    // 不应抛错
    const round = await ctx.runtime.handleUserMessage('r1', '@all 评估');

    // frontend 的 contents 留空（fail-soft）
    expect(round.contents['frontend-expert'] ?? '').toBe('');
    // 其他人正常
    expect(round.contents['backend-expert']).toBe('BE 正常');
    // 整轮不炸：有别的成员回了
    expect(round.members).toContain('backend-expert');

    fe.engine.send = origSend;
  });

  it('8. botId 过滤：listener 只捕获自己的 assistant 事件', async () => {
    const ctx = await setup(ROOM, { maxDepth: 2 });
    // A 回 @B，B 回 @A → maxDepth:2 会执行第 1 波
    ctx.script.setReply('frontend-expert', 'FE 说。@backend-expert 补充');
    ctx.script.setReply('backend-expert', 'BE 补充完');

    const round = await ctx.runtime.handleUserMessage('r1', '@frontend-expert 开讲');

    // maxDepth:2：backend 真的回了一波
    expect(round.members).toContain('frontend-expert');
    expect(round.members).toContain('backend-expert');
    // 各自的 contents 是各自引擎的回复（没串味）
    expect(round.contents['frontend-expert']).toContain('FE');
    expect(round.contents['backend-expert']).toContain('BE');
  });

  it('9. 消息持久化：handleUserMessage 后 store 有 user 消息 + bot 回复', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '前端回复');

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 怎么看');

    const msgs = ctx.runtime.getMessages('r1');
    // 至少 1 条 user + 1 条 bot
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs.some((m) => m.senderType === 'user')).toBe(true);
    expect(msgs.some((m) => m.senderType === 'main-bot' || m.senderType === 'sub-bot')).toBe(true);
  });

  it('10. @提及被剥离：存储的 user 消息内容不含 @ 标记', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '回复');

    await ctx.runtime.handleUserMessage('r1', '@frontend-expert 问题内容');

    const userMsg = ctx.runtime.getMessages('r1').find((m) => m.senderType === 'user')!;
    // @frontend-expert 被剥离
    expect(userMsg.content).not.toContain('@frontend-expert');
    // 但问题内容保留
    expect(userMsg.content).toContain('问题内容');
    // mentions 记录了 @frontend-expert
    expect(userMsg.mentions.some((m) => m.type === 'agent' && m.participantId === 'frontend-expert')).toBe(true);
  });

  it('11. getRoomParticipants 返回已注册成员', async () => {
    const ctx = await setup(ROOM);
    const ps = ctx.runtime.getRoomParticipants('r1');
    expect(ps.map((p) => p.name)).toEqual(expect.arrayContaining(['frontend-expert', 'backend-expert', 'host']));
  });

  it('12. 未注册成员不在 participants 里（@all 只唤醒已注册子集）', async () => {
    const roomWithUnregistered: RoomConfig = {
      roomId: 'r2', roomName: '测试室', hostPersona: 'host',
      memberPersonas: ['frontend-expert', 'unregistered-bot', 'host'],
    };
    const ctx = await setup(roomWithUnregistered);
    const ps = ctx.runtime.getRoomParticipants('r2');
    // unregistered-bot 没创建 bot → 不在 participants
    expect(ps.map((p) => p.name)).not.toContain('unregistered-bot');
    expect(ps.map((p) => p.name)).toEqual(expect.arrayContaining(['frontend-expert', 'host']));
  });
});

describe('chat-room-runtime 真摘要器', () => {
  it('createModelSummarizer 用指定 bot 产摘要（非桩串）', async () => {
    const script = makeScriptedEngines();
    const listeners = new Set<(event: AgentLoopEvent) => void>();
    const registry = createBotRegistry({
      createEngine: ({ botId }) => script.ensureEngine(botId),
      onEvent: (e) => { for (const cb of listeners) cb(e); },
    });
    await registry.create({ botId: 'main', slotId: 'main' });
    script.setReply('main', '这是一段真实的摘要内容。');
    const onAgentEvent = (cb: (event: AgentLoopEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

    const summarizer = createModelSummarizer({ registry, onAgentEvent, summarizerBotId: 'main' });

    const result = await summarizer([
      { id: 'm1', roomId: 'r1', senderId: 'user', senderType: 'user', content: '问题', timestamp: 1, mentions: [] },
      { id: 'm2', roomId: 'r1', senderId: 'main', senderType: 'main-bot', content: '回答', timestamp: 2, mentions: [] },
    ] as never);

    expect(result).toBe('这是一段真实的摘要内容。');
    expect(result).not.toContain('[summary');
  });

  it('summarizerBotId 不存在 → 抛错（v0.29：不可用也走 throw，不返哨兵串）', async () => {
    const script = makeScriptedEngines();
    const registry = createBotRegistry({
      createEngine: ({ botId }) => script.ensureEngine(botId),
      onEvent: () => {},
    });
    const summarizer = createModelSummarizer({ registry, onAgentEvent: () => () => {}, summarizerBotId: 'ghost' });

    await expect(summarizer([
      { id: 'm1', roomId: 'r1', senderId: 'user', senderType: 'user', content: '问题', timestamp: 1, mentions: [] },
    ] as never)).rejects.toThrow('unavailable');
  });

  it('bot 无回复（超时/空输出）→ 抛错而非返回哨兵串（v0.29 防陈旧摘要落盘）', async () => {
    // 缺陷回归：超时时返回 '[summary: bot error]' 这类非空哨兵串，会被 summarize()
    // 当真实摘要提交落盘，把上一份摘要原样重推。失败必须抛错让 summarize() 走 release。
    const script = makeScriptedEngines();
    const listeners = new Set<(event: AgentLoopEvent) => void>();
    const registry = createBotRegistry({
      createEngine: ({ botId }) => script.ensureEngine(botId),
      onEvent: (e) => { for (const cb of listeners) cb(e); },
    });
    await registry.create({ botId: 'main', slotId: 'main' });
    script.setReply('main', ''); // 引擎返回空 → 摘要为空
    const onAgentEvent = (cb: (event: AgentLoopEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

    const summarizer = createModelSummarizer({ registry, onAgentEvent, summarizerBotId: 'main' });

    await expect(summarizer([
      { id: 'm1', roomId: 'r1', senderId: 'user', senderType: 'user', content: '问题', timestamp: 1, mentions: [] },
    ] as never)).rejects.toThrow();
  });

  it('摘要器专属超时：send 不 resolve 时按 timeoutMs 抛错，不等全局看门狗', async () => {
    // 散会/手动总结不该卡 15 分钟才放弃。用短 timeoutMs 验证快速失败。
    const script = makeScriptedEngines();
    const listeners = new Set<(event: AgentLoopEvent) => void>();
    // 模拟 bot.loop.send 永不 resolve（挂在 pending 态）
    const registry = createBotRegistry({
      createEngine: ({ botId }) => {
        // 一个不 emit assistant 事件的引擎 → send resolve 但 summary 仍空 → throw empty
        // 这里要测超时，所以让 send 永不 resolve：
        const e = script.ensureEngine(botId);
        return { ...e, send: () => new Promise(() => {}) }; // 永不 resolve
      },
      onEvent: (ev) => { for (const cb of listeners) cb(ev); },
    });
    await registry.create({ botId: 'main', slotId: 'main' });
    const onAgentEvent = (cb: (event: AgentLoopEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

    const summarizer = createModelSummarizer({ registry, onAgentEvent, summarizerBotId: 'main', timeoutMs: 1500 });

    const start = Date.now();
    await expect(summarizer([
      { id: 'm1', roomId: 'r1', senderId: 'user', senderType: 'user', content: '问题', timestamp: 1, mentions: [] },
    ] as never)).rejects.toThrow('timeout');
    const elapsed = Date.now() - start;
    // 应在 ~1.5s 抛错，绝非 15 分钟。留 5s 余量（timer 精度 + 事件循环）。
    expect(elapsed).toBeLessThan(5000);
  });
});
