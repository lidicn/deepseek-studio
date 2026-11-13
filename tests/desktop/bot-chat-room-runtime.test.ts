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
import type { ConversationRound, Persona, PersonaRegistry, RoomConfig } from '../../src/host/bot/types';
import type { AuditDispatcher } from '../../src/host/bot/audit-meeting';
import type { StrategyGenerator } from '../../src/host/bot/strategy-generator';
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
async function setup(
  room: RoomConfig,
  opts?: {
    maxDepth?: number;
    /** N2-01 用：让会议命令（start 分支的 genStrategy）可控地抛错。 */
    strategyGenerator?: StrategyGenerator;
    /** N2-01 用：让审计 dispatch 可控地抛错。 */
    auditDispatcher?: AuditDispatcher;
    /** N2-01 残余：注入一个会抛错的 onRoundComplete，验证异常隔离。 */
    onRoundComplete?: (round: ConversationRound) => void;
  },
) {
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
  const onBotError = vi.fn();
  const onUnresolved = vi.fn();
  // 注入的 onRoundComplete 用 vi.fn 包一层：既保留 .mock 记录（既有 N2-01 用例要用），
  // 也让「回调自身抛错」能真实传播到 runtime 的 try/catch 里。
  const onRoundComplete: ReturnType<typeof vi.fn> = opts?.onRoundComplete ? vi.fn(opts.onRoundComplete) : vi.fn();

  const runtime = createChatRoomRuntime({
    mentionParser, handoffParser, instructionBuilder,
    messageStore, contextEngine, summaryService,
    registry, slotRuntime, personas: new FakePersonaRegistry(),
    onAgentEvent, rooms: [room], maxDepth: opts?.maxDepth,
    onBotReply, onUnresolved, onRoundComplete,
    onBotError,
    strategyGenerator: opts?.strategyGenerator,
    auditDispatcher: opts?.auditDispatcher,
  });

  return { runtime, registry, script, events, messageStore, bots, onBotReply, onBotError, onUnresolved, onRoundComplete, summarizer };
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
    expect(round.errors?.['frontend-expert']).toContain('engine crash');
    // 其他人正常
    expect(round.contents['backend-expert']).toBe('BE 正常');
    // 整轮不炸：有别的成员回了
    expect(round.members).toContain('backend-expert');
    // 空回复不落盘、不推空气泡；错误原因单独推送
    expect(ctx.onBotReply.mock.calls.some(([event]) => event.persona === 'frontend-expert')).toBe(false);
    expect(ctx.onBotError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'chat-bot-error',
      persona: 'frontend-expert',
      error: expect.stringContaining('engine crash'),
    }));

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

  it('10b. bot 落盘抛错时仍发 round-complete，避免 UI 永久锁死', async () => {
    const ctx = await setup(ROOM);
    ctx.script.setReply('frontend-expert', '正常回复');
    const append = ctx.messageStore.append.bind(ctx.messageStore);
    ctx.messageStore.append = ((message) => {
      if (message.senderType !== 'user') throw new Error('disk full');
      return append(message);
    }) as typeof ctx.messageStore.append;

    await expect(ctx.runtime.handleUserMessage('r1', '@frontend-expert 写盘')).rejects.toThrow('disk full');
    expect(ctx.onRoundComplete).toHaveBeenCalledTimes(1);
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
    let releaseSend: ((value: EngineSendResult) => void) | undefined;
    // 模拟 bot.loop.send 永不 resolve（挂在 pending 态）
    const registry = createBotRegistry({
      createEngine: ({ botId }) => {
        // 一个不 emit assistant 事件的引擎 → send resolve 但 summary 仍空 → throw empty
        // 这里要测超时，所以让 send 永不 resolve：
        const e = script.ensureEngine(botId);
        return { ...e, send: () => new Promise((resolve) => { releaseSend = resolve; }) };
      },
      onEvent: (ev) => { for (const cb of listeners) cb(ev); },
    });
    const created = await registry.create({ botId: 'main', slotId: 'main' });
    const onAgentEvent = (cb: (event: AgentLoopEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

    const summarizer = createModelSummarizer({ registry, onAgentEvent, summarizerBotId: 'main', timeoutMs: 1500 });

    const start = Date.now();
    await expect(summarizer([
      { id: 'm1', roomId: 'r1', senderId: 'user', senderType: 'user', content: '问题', timestamp: 1, mentions: [] },
    ] as never)).rejects.toThrow('timeout');
    const elapsed = Date.now() - start;
    // 应在 ~1.5s 抛错，绝非 15 分钟。留 5s 余量（timer 精度 + 事件循环）。
    expect(elapsed).toBeLessThan(5000);
    // 超时不能只放弃 await，还必须给仍挂起的 AgentLoop 置停止信号。
    expect(registry.getState('main')?.stopFlag.stopped).toBe(true);
    // AgentLoop 的 active 只能由原 send 的 finally 释放；这里不伪造 running=false。
    expect(created.loop.running).toBe(true);
    releaseSend?.({ content: '', toolCalls: 0 });
    await vi.waitFor(() => expect(created.loop.running).toBe(false));
  });
});

/**
 * N2-01（2026-11-12 续审第 2 轮）：轮次结束信号必须覆盖**任何**退出路径。
 *
 * 修复前 `handleUserMessage` 的 try 从「逐条落盘」才开始，room-not-found / 会议命令 /
 * 审计 dispatch / planRound 四个 await 都在 try 之外；它们抛错就不推 round-complete，
 * 而 UI 的 submitMessage 对任何消息都置 roundInProgress=true ⇒ 输入框永久锁死。
 * **不断线也能复现**，U1-01 的前端修复盖不住。
 *
 * 判别力：把守卫拆掉（回到各分支自己推）⇒ 抛错路径 0 次调用，红。
 */
describe('N2-01 轮次结束信号覆盖任何退出路径', () => {
  it('会议命令抛错 → onRoundComplete 恰推一次，且错误照常上抛', async () => {
    const ctx = await setup(ROOM, {
      strategyGenerator: async () => {
        throw new Error('strategy-boom');
      },
    });

    await expect(ctx.runtime.handleUserMessage('r1', '/开会 组件状态管理')).rejects.toThrow('strategy-boom');

    expect(ctx.onRoundComplete).toHaveBeenCalledTimes(1);
    // 抛错路径的合成 round 标 reason='error'：下游据此知道这不是讨论完成。
    expect(ctx.onRoundComplete.mock.calls[0][0]).toMatchObject({
      roomId: 'r1',
      reason: 'error',
      members: [],
      pendingHandoff: [],
    });
  });

  it('审计 dispatch 抛错 → onRoundComplete 恰推一次', async () => {
    const ctx = await setup(ROOM, {
      auditDispatcher: {
        async dispatch() {
          throw new Error('audit-boom');
        },
      },
    });

    await expect(ctx.runtime.handleUserMessage('r1', '@main 审计 src/host')).rejects.toThrow('audit-boom');

    expect(ctx.onRoundComplete).toHaveBeenCalledTimes(1);
    expect(ctx.onRoundComplete.mock.calls[0][0]).toMatchObject({ roomId: 'r1', reason: 'error' });
  });

  it('room 不存在 → 抛错也要推一次（否则输入框永久锁死）', async () => {
    const ctx = await setup(ROOM);

    await expect(ctx.runtime.handleUserMessage('no-such-room', '随便聊聊')).rejects.toThrow(/room not found/);

    expect(ctx.onRoundComplete).toHaveBeenCalledTimes(1);
    expect(ctx.onRoundComplete.mock.calls[0][0]).toMatchObject({
      roomId: 'no-such-room',
      reason: 'error',
      members: [],
    });
  });
});

/**
 * N2-02：合成 round 带 `reason`，让下游能区分「命令回执」与「讨论完成」。
 * 缺省（真讨论轮）不带 reason —— 这是区分两者的唯一判据。
 */
/**
 * N2-01 残余（2026-11-13，PM 批）：`onRoundComplete` 回调自身抛错必须隔离。
 *
 * 为什么必须包：它在 `finally` / `catch` 里被调用 —— 那里抛错会**覆盖原始异常**，
 * 用户看到的变成回调的错、真因被吃掉（诊断灾难）。但也不许静默吞：留一行 warn。
 *
 * 三条同时断言，缺一条都留口子：
 *   ① 原始异常原样冒出（拿到的是 `room not found`，不是 `callback-boom`）；
 *   ② 诊断 warn 恰一次，且文案指得出是谁抛的；
 *   ③ 本轮 `round-complete` 只推一次（回调只被调用一次 ⇒ 没有因抛错而重推）。
 *
 * 判别力：把 `notifyRoundComplete` 里的 try/catch 拆掉 ⇒ ① 变成 `callback-boom`、② 变 0 次，红。
 */
describe('N2-01 残余：onRoundComplete 回调抛错必须隔离', () => {
  it('原始异常原样冒出、warn 恰一次、round-complete 不重复推送', async () => {
    const throwing = vi.fn((_round: ConversationRound) => {
      throw new Error('callback-boom');
    });
    const ctx = await setup(ROOM, { onRoundComplete: throwing });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // ① 原错误必须原样冒出（不能被回调的错顶掉）
      await expect(ctx.runtime.handleUserMessage('no-such-room', '随便聊聊')).rejects.toThrow(/room not found/);

      // ② 诊断一次，且指向回调
      // ⚠️ 断言必须留在 try 内：`warn.mockRestore()` 会连调用记录一起清掉，
      //    放到 finally 之后再断言就永远读到 0 次（本用例第一版正是这么假红的）。
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('onRoundComplete');

      // ③ 只推一次
      expect(throwing).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('N2-02 合成 round 的 reason 标记', () => {  it('会议命令回执 reason=command，真讨论轮无 reason', async () => {
    const ctx = await setup(ROOM);

    const ack = await ctx.runtime.handleUserMessage('r1', '/开会 组件状态管理');
    expect(ack.reason).toBe('command');
    expect(ack.members).toEqual([]);
    expect(ack.contents).toEqual({});
    expect(ctx.onRoundComplete).toHaveBeenCalledTimes(1);

    ctx.script.setReply('frontend-expert', '前端视角：用 zustand。');
    const round = await ctx.runtime.handleUserMessage('r1', '@frontend-expert 你怎么看？');
    expect(round.reason).toBeUndefined();
    expect(round.members).toEqual(['frontend-expert']);
  });

  it('审计命令回执 reason=audit', async () => {
    const dispatch = vi.fn(async () => undefined);
    const ctx = await setup(ROOM, { auditDispatcher: { dispatch } });

    const ack = await ctx.runtime.handleUserMessage('r1', '@main 审计 src/host 维度 安全');
    expect(ack.reason).toBe('audit');
    expect(ack.members).toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // 审计指令是真实任务起点，必须落盘（同 meeting start）。
    const stored = ctx.messageStore.getMessages('r1').map((m) => m.content);
    expect(stored).toContain('@main 审计 src/host 维度 安全');
    expect(ctx.onRoundComplete).toHaveBeenCalledTimes(1);
  });
});
