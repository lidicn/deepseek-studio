/**
 * ChatRoomRuntime（Bot 平台 v0.27 · Claude 主开发）
 *
 * 聊天室接线层：把 CB 的纯算法层（MentionRouter/HandoffParser/RoundOrchestrator）
 * + 数据层（ChatMessageStore/ContextEngine/RoomSummaryService）接到 Claude 的
 * 引擎层（BotRegistry/SlotRuntime/AgentLoop）上。
 *
 * 职责：用户消息 → 存储 → 路由 → 编排回复 → 回收存储 → 推 UI → 接力/告警 → 摘要。
 * 不实现算法——只调 CB 的 route/planRound/parse。
 *
 * 核心设计（见 plan & 答疑回复）：
 *   - generateReply 回调（RoundOrchestrator 构造注入）：persona→botId 路由 →
 *     ContextEngine.buildContext 灌上下文 → 临时 listener 按 botId 过滤捕获
 *     assistant 事件 → bot.loop.send(AGENT_SENTINEL + personaBlock + 上下文) →
 *     返回原始回复文本（含 @接力标记，orchestrator 内部过 HandoffParser）。
 *   - agentSender 模式（desktop-host.ts:613-632）的 per-bot 泛化。
 *   - fail-soft：generateReply 抛错被 orchestrator 的 try/catch 捕获，记 ''。
 *   - 向后兼容：无 chatRooms 配置时 chatRoomRuntime=null，原直发路径不变。
 */

import type { AgentLoopEvent } from '../agent-loop';
import { AGENT_SENTINEL } from '../agent-loop';
import type { BotRegistryInternal } from './registry';
import type { SlotRuntime } from './slot-runtime';
import type {
  ChatContext,
  ChatMessage,
  ChatMessageStore,
  ChatSummarizer,
  ChatRoomBotReplyEvent,
  ChatRoomSummaryEvent,
  ContextEngine,
  HandoffParser,
  HandoffResolution,
  MentionParser,
  Participant,
  Persona,
  PersonaInjector,
  PersonaRegistry,
  RoomConfig,
  RoomSummaryService,
} from './types';
import type { AgentInstructionBuilder, ConversationRound } from './types';
import type { GenerateReply, GenerateReplyContext } from './round-orchestrator';
import { DefaultRoundOrchestrator } from './round-orchestrator';
import { MapParticipantResolver } from './participant-resolver';
import { DefaultMentionRouter } from './mention-router';

/** 事件订阅器形状（接 desktop-host 的 agentListeners）。 */
export type AgentEventBus = (cb: (event: AgentLoopEvent) => void) => () => void;

/** 发送 bot 回复到 UI 的回调。接线层在每条 bot 回复落盘后调它（payload 即 ChatRoomBotReplyEvent）。 */
export type BotReplySink = (event: ChatRoomBotReplyEvent) => void;

/** 房间摘要结构化推送回调。摘要落快照成功后调它（payload 即 ChatRoomSummaryEvent）。 */
export type SummarySink = (event: ChatRoomSummaryEvent) => void;

/** 未注册 @名上报回调。接线层发现拼错/未注册的人设名时调它打告警。 */
export type UnresolvedSink = (roomId: string, names: readonly string[]) => void;

/** 一轮结束回调。 */
export type RoundCompleteSink = (round: ConversationRound) => void;

export interface ChatRoomRuntimeOptions {
  // 算法层（CB 交付，只读消费）
  readonly mentionParser: MentionParser;
  readonly handoffParser: HandoffParser;
  readonly instructionBuilder: AgentInstructionBuilder;

  // 数据层（CB 交付）
  readonly messageStore: ChatMessageStore;
  readonly contextEngine: ContextEngine;
  readonly summaryService: RoomSummaryService;

  // 引擎层（Claude 交付）
  readonly registry: BotRegistryInternal;
  readonly slotRuntime: SlotRuntime;
  readonly personas: PersonaRegistry;

  // 事件总线（接 desktop-host 的 agentListeners）
  readonly onAgentEvent: AgentEventBus;

  // 房间配置
  readonly rooms: ReadonlyArray<RoomConfig>;
  readonly maxDepth?: number; // 默认 1

  // 回调
  readonly onBotReply?: BotReplySink;
  readonly onSummary?: SummarySink;
  readonly onUnresolved?: UnresolvedSink;
  readonly onRoundComplete?: RoundCompleteSink;
}

export interface ChatRoomRuntime {
  /** 用户发消息进聊天室主入口。 */
  handleUserMessage(roomId: string, text: string, userId?: string): Promise<ConversationRound>;
  /** 取房间当前可唤醒的参与者（供 UI @提及选择）。 */
  getRoomParticipants(roomId: string): Participant[];
  /** 取房间消息历史（供 UI 渲染）。 */
  getMessages(roomId: string): ChatMessage[];
  /** 主动触发摘要。 */
  summarizeRoom(roomId: string): Promise<void>;
  /** 取房间配置（供外部查询）。 */
  getRoom(roomId: string): RoomConfig | undefined;
}

/** 渲染上下文为模型可读文本：systemPrompt + 消息序列。 */
function renderContextMessages(ctx: ChatContext): string {
  const parts: string[] = [];
  if (ctx.systemPrompt && ctx.systemPrompt.trim()) {
    parts.push(ctx.systemPrompt.trim());
  }
  for (const m of ctx.messages) {
    const label = m.role === 'user' ? '用户' : '助手';
    parts.push(`${label}：${m.content}`);
  }
  return parts.join('\n\n');
}

/** 构建 participants：遍历房间成员 persona 名，查 registry 取 botId。 */
function buildParticipants(room: RoomConfig, registry: BotRegistryInternal): Participant[] {
  const out: Participant[] = [];
  for (const name of room.memberPersonas) {
    // v0.27 阶段：persona 名即 botId（registry.create 时 botId=persona 名）。
    // 未注册的 bot 不进 participants——@all 只唤醒已注册子集（防空转）。
    const bot = registry.get(name);
    if (bot) {
      out.push({ name, botId: bot.id });
    }
  }
  return out;
}

/**
 * createGenerateReply：产 generateReply 回调注入 RoundOrchestrator。
 *
 * 每次调 planRound 前，接线层按当前 participants 动态重建 resolver/router/orchestrator。
 * generateReply 闭包内记录原始回复（rawReplyMap），供 planRound 后重新 parse 取 unresolved。
 */
function createGenerateReply(
  deps: ChatRoomRuntimeOptions,
  room: RoomConfig,
  participants: Participant[],
  rawReplyMap: Map<string, string>,
): GenerateReply {
  const { registry, slotRuntime, contextEngine, instructionBuilder, onAgentEvent } = deps;

  // personaInjector：包裹 instructionBuilder.build，ctx 结构匹配，直接透传 .instructions
  const personaInjector: PersonaInjector = (injCtx) =>
    instructionBuilder.build({
      agentName: injCtx.agentName,
      roomName: injCtx.roomName,
      agentDescription: injCtx.agentDescription,
      memberNames: injCtx.memberNames,
      summary: injCtx.summary,
    }).instructions;
  return async (persona: string, ctx: GenerateReplyContext): Promise<string> => {
    const participant = participants.find((p) => p.name === persona);
    if (!participant) throw new Error(`generateReply: unknown persona ${persona}`);
    const botId = participant.botId;

    // 1. 确保该 bot 已加载 persona（幂等）
    const loaded = slotRuntime.loaded(botId);
    if (!loaded || loaded.persona.name !== persona) {
      await slotRuntime.loadPersona(botId, persona);
    }
    const bot = registry.get(botId);
    if (!bot) throw new Error(`generateReply: bot ${botId} not found`);
    const personaObj: Persona | undefined = bot.persona ?? loaded?.persona;
    if (!personaObj) throw new Error(`generateReply: persona ${persona} not loaded on bot ${botId}`);

    // 2. ContextEngine 灌上下文（trigger.id 之前的消息 + trigger 本身 + 人设指令注入）
    const chatContext = await contextEngine.buildContext({
      roomId: room.roomId,
      agentName: persona,
      currentMessageId: ctx.trigger.id,
      personaInjector,
      roomName: room.roomName,
      memberNames: room.memberPersonas,
    });

    // 3. 组合发送文本：personaBlock + 上下文消息
    const personaBlock = slotRuntime.renderPersonaBlock(personaObj);
    const contextText = renderContextMessages(chatContext);
    const message = [personaBlock, contextText].filter(Boolean).join('\n\n---\n\n');

    // 4. 临时 listener 按 botId 过滤捕获 assistant 事件
    let capturedReply = '';
    const listener = (event: AgentLoopEvent): void => {
      if (event.botId === botId && event.type === 'assistant' && event.text) {
        capturedReply = event.text;
      }
    };
    const unsub = onAgentEvent(listener);
    try {
      // 5. sessionAllowlist 加 chat-insert/chat-send（与 agentSender 同模式）
      const state = registry.getState(botId);
      state?.sessionAllowlist.add('chat-insert');
      state?.sessionAllowlist.add('chat-send');

      // 6. 发送 → loop.send resolve 时 assistant 事件已同步 emit
      // v0.28：带 roomId，AgentLoop 把它戳到每条事件上供 UI 按 roomId 过滤。
      await bot.loop.send(`${AGENT_SENTINEL}${message}`, { roomId: room.roomId });

      // 7. 记录原始回复供 planRound 后取 unresolved
      rawReplyMap.set(persona, capturedReply);
      return capturedReply; // 原始文本（含 @接力标记），orchestrator 内部过 HandoffParser
    } finally {
      unsub();
    }
  };
}

/**
 * createModelSummarizer：真摘要器（任务#9）。
 *
 * 用 agentSender 模式产摘要：拼摘要 prompt → 某 bot loop.send → listener 捕获 → 返回摘要文本。
 * 替换 v0.26 的 defaultStubSummarizer。
 */
export function createModelSummarizer(deps: {
  registry: BotRegistryInternal;
  onAgentEvent: AgentEventBus;
  /** 产摘要的 botId（优先 room.hostPersona，再缺省 main）。 */
  summarizerBotId?: string;
}): ChatSummarizer {
  const { registry, onAgentEvent } = deps;
  return async (messages: ReadonlyArray<ChatMessage>): Promise<string> => {
    const summarizerBotId = deps.summarizerBotId ?? 'main';
    const bot = registry.get(summarizerBotId);
    if (!bot) return '[summary: bot unavailable]';
    if (messages.length === 0) return '';

    // 拼摘要 prompt
    const transcript = messages
      .map((m) => `${m.senderType === 'user' ? '用户' : m.senderId}: ${m.content}`)
      .join('\n');
    const prompt = `请将以下聊天室对话总结为要点（不超过 500 字，保留关键结论与分歧）：\n\n${transcript}`;

    let summary = '';
    const listener = (event: AgentLoopEvent): void => {
      if (event.botId === summarizerBotId && event.type === 'assistant' && event.text) {
        summary = event.text;
      }
    };
    const unsub = onAgentEvent(listener);
    try {
      const state = registry.getState(summarizerBotId);
      state?.sessionAllowlist.add('chat-insert');
      state?.sessionAllowlist.add('chat-send');
      await bot.loop.send(`${AGENT_SENTINEL}${prompt}`);
      return summary || '[summary: empty]';
    } catch {
      return '[summary: bot error]';
    } finally {
      unsub();
    }
  };
}

export function createChatRoomRuntime(options: ChatRoomRuntimeOptions): ChatRoomRuntime {
  const {
    mentionParser,
    handoffParser,
    messageStore,
    summaryService,
    registry,
    rooms,
    maxDepth = 1,
    onBotReply,
    onSummary,
    onUnresolved,
    onRoundComplete,
  } = options;

  function findRoom(roomId: string): RoomConfig | undefined {
    return rooms.find((r) => r.roomId === roomId);
  }

  async function handleUserMessage(roomId: string, text: string, userId = 'user'): Promise<ConversationRound> {
    const room = findRoom(roomId);
    if (!room) throw new Error(`chat-room-runtime: room not found: ${roomId}`);

    // 动态构建 participants（bot 可运行时增删）
    const participants = buildParticipants(room, registry);

    // 1. 解析 @提及
    const mentions = mentionParser.resolveMentions(text, participants);
    // 2. 剥离 @路由标记得净内容
    const cleanContent = mentionParser.stripMentionTokens(text, participants);

    // 3. 存用户消息（净内容，契约要求剥离 @路由标记）
    const storedMsg = messageStore.append({
      roomId,
      senderId: userId,
      senderType: 'user',
      content: cleanContent,
      timestamp: Date.now(),
      mentions,
    });

    // 路由触发器携带原始文本（含 @提及），供 MentionRouter 解析 @目标。
    // 存储消息是净内容（契约 + 上下文注入用），路由触发器是原始文本——两者分离是接线层职责。
    const trigger: ChatMessage = { ...storedMsg, content: text };

    // 4. 动态重建 resolver/router（每次按当前 participants）
    const resolver = new MapParticipantResolver(participants);
    const router = new DefaultMentionRouter(mentionParser, resolver);

    // 5. createGenerateReply（闭包记 rawReplyMap 供取 unresolved）
    const rawReplyMap = new Map<string, string>();
    const generateReply = createGenerateReply(options, room, participants, rawReplyMap);

    // 6. orchestrator
    const orchestrator = new DefaultRoundOrchestrator({
      router,
      handoffParser,
      participantResolver: resolver,
      generateReply,
      maxDepth,
    });

    // 7. planRound
    const round = await orchestrator.planRound({ trigger, room, participants });

    // 8. 逐个回复落盘 + 推 UI（结构化 ChatRoomBotReplyEvent）
    for (const persona of round.members) {
      const participant = participants.find((p) => p.name === persona);
      if (!participant) continue;
      const content = round.contents[persona] ?? '';
      const botId = participant.botId;
      const senderType: 'main-bot' | 'sub-bot' = botId === 'main' ? 'main-bot' : 'sub-bot';
      const stored = messageStore.append({
        roomId,
        senderId: botId,
        senderType,
        content,
        timestamp: Date.now(),
        mentions: [],
      });
      onBotReply?.({
        kind: 'chat-bot-reply',
        roomId,
        persona,
        botId,
        senderType,
        content,
        messageId: stored.id,
        timestamp: stored.timestamp,
      });
    }

    // 9. unresolved 上报：重新 parse 原始回复取未注册 @名
    const unresolvedAll: string[] = [];
    for (const persona of round.members) {
      const raw = rawReplyMap.get(persona);
      if (!raw) continue;
      const res: HandoffResolution = handoffParser.parse(raw, participants);
      if (res.unresolved.length > 0) {
        unresolvedAll.push(...res.unresolved);
      }
    }
    if (unresolvedAll.length > 0) {
      onUnresolved?.(roomId, unresolvedAll);
    }

    // 10. pendingHandoff 不执行（maxDepth=1 默认）；接线层可据此决定续轮策略
    // （v0.27 阶段：调用方连续调 handleUserMessage 续轮，不在此自动续）

    // 11. 摘要触发
    try {
      const should = (summaryService as { shouldSummarize?(roomId: string): boolean }).shouldSummarize;
      if (typeof should === 'function' && should.call(summaryService, roomId)) {
        await summaryService.summarize(roomId);
      } else {
        // 无 shouldSummarize 方法的实现：每轮后无条件试一次（内部有 CAS/租约防并发）
        await summaryService.summarize(roomId);
      }
    } catch {
      // 摘要失败不影响主流程
    }

    // 11b. 摘要结构化事件：若房间已有成功快照，推 chat-summary 供 UI 渲染/按 roomId 隔离。
    // 仅在 status='success' 且有 through id 时推（UI 据 throughMessageId 去重）。
    try {
      const snap = summaryService.getSummary(roomId);
      if (snap && snap.status === 'success' && snap.lastMessageId) {
        onSummary?.({
          kind: 'chat-summary',
          roomId,
          summary: snap.summary,
          throughMessageId: snap.lastMessageId,
          timestamp: snap.updatedAt,
        });
      }
    } catch {
      // 摘要事件推送失败不影响主流程
    }

    onRoundComplete?.(round);
    return round;
  }

  function getRoomParticipants(roomId: string): Participant[] {
    const room = findRoom(roomId);
    if (!room) return [];
    return buildParticipants(room, registry);
  }

  function getMessages(roomId: string): ChatMessage[] {
    return messageStore.getMessages(roomId);
  }

  async function summarizeRoom(roomId: string): Promise<void> {
    await summaryService.summarize(roomId);
  }

  return { handleUserMessage, getRoomParticipants, getMessages, summarizeRoom, getRoom: findRoom };
}
