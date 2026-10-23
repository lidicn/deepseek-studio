/**
 * Bot 基础设施接口契约（Claude 主开发定义，CodeBuddy 按此实现）
 *
 * 这是 Claude（核心引擎）与 CodeBuddy（数据层）的唯一交接面。
 * 接口签名锁定后不随意改；需改时走 PR + description 说明影响。
 *
 * 谁实现什么：
 *   - Claude 实现：BotInstance（含 loop + engine）、BotRegistry
 *   - CodeBuddy 实现：Persona、PersonaRegistry、Slot、SlotRegistry、MemoryStoreV2
 *
 * 详见 docs/codebuddy/分工方案-CodeBuddy协作-20261014.md
 */

import type { AgentLoop } from '../agent-loop';
import type { ModelEngine } from '../engine/model-engine';

// ===== Persona 层（CodeBuddy 实现）=====

/** 人设包：提示词 + 工具白名单 + 专属记忆目录。对应 personas/<name>/ 结构。 */
export interface Persona {
  /** 人设名，如 'audit-expert'。对应 personas/ 目录下的子目录名。 */
  readonly name: string;
  /** 系统提示词（personas/<name>/prompt.md 内容）。 */
  readonly prompt: string;
  /** 工具白名单（personas/<name>/tools.json），空数组表示继承全部工具。 */
  readonly tools: readonly string[];
  /** 专属记忆目录绝对路径（personas/<name>/memory/）。 */
  readonly memoryDir: string;
}

/** 人设注册表：扫描 personas/ 目录加载人设包。CodeBuddy 实现。 */
export interface PersonaRegistry {
  /** 加载指定人设包；不存在时抛错。 */
  load(name: string): Promise<Persona>;
  /** 列出所有可用人设名。 */
  list(): string[];
}

// ===== Slot 层（CodeBuddy 实现）=====

/** 账号（凭证层，长期稳定）。对应设计稿 2.1。 */
export interface Account {
  readonly id: string;              // A1..A5
  readonly kind: 'web' | 'api';
  /** 网页版：浏览器 profile 目录；API：keyRef。 */
  readonly loginRef: string;
  status: 'ready' | 'rate-limited' | 'banned' | 'logged-out';
  cooldownUntil?: number;
}

/** 槽位（执行位，可复用）。对应设计稿 2.2。 */
export interface Slot {
  readonly id: string;              // S1..S5 工作槽 + S6 汇总槽
  accountId: string;                // 当前绑定的账号
  state: 'idle' | 'busy';
  currentRunId?: string;            // 正在跑哪个 run
  loadedPersona?: string;           // 当前加载的人设包名
}

/** 槽位注册表：管理槽位 ↔ 账号 ↔ 人设 三层绑定。CodeBuddy 实现。 */
export interface SlotRegistry {
  /** 列出所有槽位。 */
  list(): Slot[];
  /** 按 id 查槽位。 */
  get(id: string): Slot | undefined;
  /** 绑定槽位到账号。 */
  bindAccount(slotId: string, accountId: string): void;
  /** 标记槽位忙碌/空闲。 */
  setState(slotId: string, state: 'idle' | 'busy', runId?: string): void;
}

// ===== 记忆层 v2（CodeBuddy 实现）=====

/** 单条记忆。扩展自现有 Memory，新增治理字段。 */
export interface Memory {
  readonly id: string;
  readonly type: 'user' | 'project';
  name: string;
  content: string;
  tags: string[];
  /** v2 新增：来源（谁写入的）。 */
  source?: string;
  /** v2 新增：可信度 0-1（人工=1，模型推断=0.5 等）。 */
  confidence?: number;
  /** v2 新增：人设维度标签，按人设路由记忆子集。 */
  personaTags?: string[];
  /** v2 新增：失效时间戳（失效而非删除，便于审计/回滚）。null=有效。 */
  invalidAt?: number | null;
}

/** 记忆层 v2：SQLite + FTS5 + 失效标记 + 人设路由。CodeBuddy 实现。 */
export interface MemoryStoreV2 {
  /** 混合检索（FTS 全文 + 可选人设过滤）。 */
  search(query: string, opts?: { personaTag?: string; limit?: number }): Promise<Memory[]>;
  /** 失效一条记忆（标记 invalidAt，不删除数据）。 */
  invalidate(id: string): Promise<void>;
  /** 按人设标签列出记忆（只返回有效记忆）。 */
  listByPersona(tag: string): Promise<Memory[]>;
  /** 列出全部有效记忆（兼容现有 list()）。 */
  list(): Promise<Memory[]>;
  /** 格式化记忆为 prompt 注入文本（兼容现有系统提示词注入）。 */
  formatForPrompt(memories: readonly Memory[]): string;
}

// ===== BotInstance（Claude 实现）=====

/** Bot 实例：一个并发执行体 = loop + engine + 人设 + 槽位。Claude 实现。 */
export interface BotInstance {
  readonly id: string;
  /** Claude 实现的 AgentLoop（已去单例，事件带 botId 标签）。 */
  readonly loop: AgentLoop;
  /** Claude 实现的 ModelEngine（ApiEngine 或 WebEngine）。 */
  readonly engine: ModelEngine;
  /** CodeBuddy 的 PersonaRegistry 产出。v0.23 主 bot 无 人设（v0.25 由 SlotRuntime 加载）。 */
  persona?: Persona;
  /** CodeBuddy 的 SlotRegistry 产出。 */
  slotId: string;
}

/** Bot 注册表：管理 N 个 BotInstance 生命周期。Claude 实现。 */
export interface BotRegistry {
  /** 创建一个 BotInstance。botId 缺省自动分配；engine 缺省自动建 WebEngine。 */
  create(opts: { botId?: string; slotId: string; personaName?: string; engine?: ModelEngine }): Promise<BotInstance>;
  get(id: string): BotInstance | undefined;
  list(): BotInstance[];
  destroy(id: string): Promise<void>;
}

// ===== 聊天室数据层（v0.26，CodeBuddy 实现）=====
//
// 本节是 v0.26 聊天室数据层的接口契约。Claude 已锁定签名，
// CodeBuddy 按此实现。详见 docs/codebuddy/路线图-CodeBuddy-聊天室数据层-20261014.md
// 及 docs/交接单/v0.26-聊天室数据层-回复单-20261014.md。

/** 消息发送者类型。三态枚举：用户 / 主bot / 子bot。 */
export type ChatSenderType = 'user' | 'main-bot' | 'sub-bot';

/** 结构化 @提及。@all 全员；@具体名 指定参与者。对齐 Ekko mention-routing。 */
export interface StructuredMention {
  readonly type: 'all' | 'agent';
  /** type='agent' 时的参与者 id（通常等于 persona 名，如 'audit-expert'）。type='all' 时省略。 */
  readonly participantId?: string;
}

/** 消息洞察数标签（v0.28 PoC 门槛 #6「多 bot 洞察数 ≥ 单 bot ×1.5」对照用）。评审/脚本给 bot 回复打分后写入。 */
export interface MessageInsight {
  /** 该回复被评出的洞察数。 */
  readonly count: number;
  /** 评审者标识（人工或评审脚本名）。 */
  readonly reviewer?: string;
  /** 打标时间戳（ms）。约定 `Date.now()`。 */
  readonly taggedAt: number;
}

/** 聊天室消息。一条聊天室消息。存储在 chat_messages 表。 */
export interface ChatMessage {
  /** 唯一 id。约定：`msg-<base36时间戳>-<6位随机>`，与 Memory.id 同款生成法。 */
  readonly id: string;
  /** 所属房间 id。 */
  readonly roomId: string;
  /** 发送者 id。user=用户标识；bot=botId。 */
  readonly senderId: string;
  /** 发送者类型。 */
  readonly senderType: ChatSenderType;
  /** 消息文本（已剥离 @路由标记的净内容）。 */
  readonly content: string;
  /** 毫秒时间戳。约定：`Date.now()`。 */
  readonly timestamp: number;
  /** 本消息中解析出的 @提及。无则空数组。 */
  readonly mentions: readonly StructuredMention[];
  /** v0.28：洞察数标签（PoC 门槛 #6 对照用）。无则 undefined（未打标）。 */
  readonly insights?: MessageInsight;
}

/** 房间上下文快照。每个房间一份，记录已摘要的历史。 */
export interface ChatContextSnapshot {
  readonly roomId: string;
  /** 已压缩的历史摘要。 */
  summary: string;
  /** 摘要覆盖到哪条消息为止（不含该消息之后）。 */
  lastMessageId: string;
  lastMessageTimestamp: number;
  /** 已摘要的轮次数。 */
  summarizedTurnCount: number;
  /** 快照版本号（CAS 并发控制）。 */
  version: number;
  status: 'idle' | 'summarizing' | 'success' | 'failed';
  updatedAt: number;
}

/** ContextEngine.buildContext 的返回。bot 回复前注入的上下文。 */
export interface ChatContext {
  /** 系统提示词。v0.26 只含房间摘要；v0.27 由 Claude 接 buildAgentInstructions 注入人设指令。 */
  systemPrompt: string;
  /** 注入 bot 的消息序列（role: user/assistant）。= 摘要之后的最近消息原文。 */
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  /** 元信息（诊断用）。 */
  meta: {
    totalMessages: number;
    verbatimCount: number;
    hadSnapshot: boolean;
    compressed: boolean;
  };
}

/** 摘要器回调。v0.26 用桩（计数器），v0.27 由 Claude 接真实 ModelEngine。 */
export type ChatSummarizer = (messages: ReadonlyArray<ChatMessage>) => Promise<string>;

/** 人设注入钩子。v0.26 留空；v0.27 由 Claude 接 buildAgentInstructions。 */
export type PersonaInjector = (ctx: {
  agentName: string;
  roomName: string;
  agentDescription: string;
  memberNames: readonly string[];
  summary: string;
}) => string;

/** 聊天室消息存储。CodeBuddy 实现。 */
export interface ChatMessageStore {
  /** 存一条消息。 */
  append(msg: Omit<ChatMessage, 'id'> & { id?: string }): ChatMessage;
  /** 按范围取消息（含 throughMessageId，不含之后）。limit 截断尾部。 */
  getMessages(roomId: string, opts?: { throughMessageId?: string; limit?: number }): ChatMessage[];
  /** 取房间消息总数。 */
  count(roomId: string): number;
  /** 给某条消息打「洞察数」标签（v0.28 PoC 门槛 #6 对照用）。返回是否命中并更新。 */
  tagInsights(roomId: string, messageId: string, insight: { count: number; reviewer?: string }): boolean;
}

/** 上下文引擎。构建 bot 回复所需的注入上下文。CodeBuddy 实现。 */
export interface ContextEngine {
  /** 为指定 bot 构建回复上下文。 */
  buildContext(input: {
    roomId: string;
    agentName: string;
    currentMessageId: string;
    /** 人设注入钩子（v0.27 接入，v0.26 可选）。 */
    personaInjector?: PersonaInjector;
    /** 房间名/人设描述/成员名（v0.27 提供，v0.26 可选）。 */
    roomName?: string;
    agentDescription?: string;
    memberNames?: readonly string[];
  }): Promise<ChatContext>;
  /** 取房间快照（诊断用）。 */
  getSnapshot(roomId: string): ChatContextSnapshot | null;
}

/** 房间摘要服务。周期摘要 + CAS 租约。CodeBuddy 实现。 */
export interface RoomSummaryService {
  /** 触发摘要（满足 summaryEveryTurns 条件时）。租约+CAS 防并发覆盖。 */
  summarize(roomId: string): Promise<void>;
  /** 取当前摘要状态。 */
  getSummary(roomId: string): ChatContextSnapshot | null;
}

/** 房间会议状态（v0.29）。与 chat_snapshots 分离——策略写入不该触碰摘要的 version/CAS/租约。 */
export interface RoomMeetingState {
  readonly status: MeetingStatus;
  readonly strategy: MeetingStrategy | null;
  /** 自上次摘要以来累计的「有 bot 回复」轮数。用于阈值门控自动总结。 */
  readonly roundsSinceSummary: number;
}

/** 房间会议状态存储（v0.29）。Claude 实现。每房间一行，内存降级可用。 */
export interface ChatRoomStateStore {
  get(roomId: string): RoomMeetingState | null;
  startMeeting(roomId: string, strategy: MeetingStrategy, by: string): void;
  endMeeting(roomId: string, by: string): void;
  /** 累计一轮讨论。仅在有 bot 回复的轮次调用。 */
  incrementRounds(roomId: string): void;
  /** 摘要成功后清零。 */
  resetRounds(roomId: string): void;
}

/** @提及解析器。纯算法，不依赖 host 基础设施。CodeBuddy 实现。 */
export interface MentionParser {
  /** 解析消息中的 @提及，返回结构化列表。 */
  resolveMentions(content: string, participants: ReadonlyArray<{ name: string; id?: string }>): StructuredMention[];
  /** 剥离 @路由标记，留净内容。 */
  stripMentionTokens(content: string, participants: ReadonlyArray<{ name: string; id?: string }>): string;
  /** 判断是否 @all。 */
  isAllMentioned(content: string): boolean;
}

// ===== 聊天室指令与接力层（v0.27a，CodeBuddy 实现）=====
//
// v0.26 只做「存/取/压缩/解析」。本节做「一个 bot 说完之后，该谁接」。
// 全部纯算法 + 无副作用：不碰 SQLite、不碰 web-engine、不 import desktop-host。
// 与 v0.26 一致，衔接面仍只限 types.ts。见 docs/架构文档/路线图-Bot平台-v0.21-v0.38-20261014.md §5.1a
// 及 docs/交接单/v0.27a-聊天室指令与接力层-回复单-20261014.md。

/** 房间配置。房间名/主持人/成员都从这里取，不由调用方散着传。 */
export interface RoomConfig {
  /** 房间 id。 */
  readonly roomId: string;
  /** 房间名（注入系统提示词用）。 */
  readonly roomName: string;
  /** 主持人（无 @ 时兜底回复者）的 persona 名。缺省时按「不兜底」处理——宁可不答也不乱答。 */
  readonly hostPersona?: string;
  /** 成员 persona 名列表。顺序即默认回复顺序。 */
  readonly memberPersonas: readonly string[];
}

/** 单个 participant 的路由视图：persona 名 → 运行时实例标识。 */
export interface Participant {
  /** persona 名，如 'audit-expert'。语义身份，@命中用它。 */
  readonly name: string;
  /** 运行时实例 id（botId）。由 Claude 的接线层提供；数据层不产生。 */
  readonly botId: string;
}

/** 路由决策：一条消息该由谁回、以何种方式回。 */
export interface RoutingDecision {
  /** 需要回复的 persona 名，按回复顺序排列。空数组 = 该消息不需要任何 bot 回复。 */
  readonly targets: readonly string[];
  /** 命中方式。 */
  readonly mode: 'mention' | 'all' | 'host-fallback' | 'none';
}

/** @提及路由器。把「消息 + 房间」变成「该谁回」。纯算法。 */
export interface MentionRouter {
  /**
   * 决定由谁回复。优先级：@具体名 > @all > 无@→主持人兜底 > none。
   * 解析用 MentionParser（同一 participants 列表），保证 @解析与路由一致。
   */
  route(input: {
    readonly message: ChatMessage;
    readonly room: RoomConfig;
    readonly participants: readonly Participant[];
  }): RoutingDecision;
}

/** 参与者翻译：persona 名 ↔ botId。人设是语义身份，botId 是运行时实例。 */
export interface ParticipantResolver {
  /** persona 名 → 房间内的 Participant；未找到 → undefined（不猜测、不兜底成别人的 botId）。 */
  resolve(personaName: string, room: RoomConfig): Participant | undefined;
  /** 房间全部成员的 Participant 视图。 */
  all(room: RoomConfig): Participant[];
  /** persona 名是否在房间内。 */
  has(personaName: string, room: RoomConfig): boolean;
}

/** 人设指令构建器：产出可直接塞进系统提示词的一段文本。 */
export interface AgentInstructions {
  /** 产出结果（同时作为 ContextEngine 的 PersonaInjector 返回串）。 */
  readonly instructions: string;
}

/** 人设指令构建器。Claude 原 v0.27 的第 8 项，现移交给 CB 作为纯文本生成器交付。 */
export interface AgentInstructionBuilder {
  build(ctx: {
    readonly agentName: string;
    readonly roomName: string;
    readonly agentDescription: string;
    readonly memberNames: readonly string[];
    readonly summary: string;
  }): AgentInstructions;
}

/** 接力解析结果：从 bot 的回复文本里拆出「净回复」与「交接目标」。 */
export interface HandoffResolution {
  /** 剥离接力标记后的净回复文本（这是进聊天室存储/显示的内容）。 */
  readonly content: string;
  /** 解析出的接力目标 persona 名。无则空数组。 */
  readonly targets: readonly string[];
  /** 是否含未解析/未注册的接力目标（拼错的名字等）。调用方据此决定是否告警。 */
  readonly unresolved: readonly string[];
}

/** 接力解析器：识别 bot 回复里的 @点名 → 下一个该谁接。 */
export interface HandoffParser {
  /**
   * 从 bot 回复里解析接力。@具体名 → 交接给该 persona；@all → 视为无接力（避免自我放大成全员广播）。
   * 未注册的名字进 unresolved 而非静默丢弃。
   */
  parse(content: string, participants: ReadonlyArray<{ name: string; id?: string }>): HandoffResolution;
}

/** 一轮对话：用户在房间里发一条消息引发的全部 bot 回复。 */
export interface ConversationRound {
  readonly roomId: string;
  /** 触发这一轮的用户消息 id。 */
  readonly triggerMessageId: string;
  /** 本轮各参与者回复顺序（可能少于 members，取决于路由结果）。 */
  readonly members: readonly string[];
  /** 本轮内各 persona 的净回复内容。 */
  readonly contents: Readonly<Record<string, string>>;
  /** 本轮生成失败的 persona → 可诊断错误。成功时不出现该键。 */
  readonly errors?: Readonly<Record<string, string>>;
  /** 本轮结束后解析出的接力目标（下一轮的入参）。 */
  readonly pendingHandoff: readonly string[];
}

/** 轮次编排器：决定一整个轮次里谁回、什么顺序、要不要接力。 */
export interface RoundOrchestrator {
  /**
   * 编排一轮。
   *   - 由 MentionRouter 决定 targets（无 @ → 主持人；@all → 全员）
   *   - 顺序回复：后者能读到前者的内容（对话感，参考 Ekko「同轮可并发，轮间串行」）
   *   - 每条回复后过 HandoffParser，命中且未在本轮出现过 → 加入 pendingHandoff
   *   - 单轮接力深度受限（防 A→B→A→B 无限环）；上限由构造时 maxDepth 控制，默认 1
   */
  planRound(input: {
    readonly trigger: ChatMessage;
    readonly room: RoomConfig;
    readonly participants: readonly Participant[];
  }): Promise<ConversationRound>;
}

// ===== 聊天室结构化事件（v0.28 收尾，CodeBuddy 定义）=====
//
// 为什么需要：现有 AgentLoopEvent（user/assistant/status/done…）是**引擎层原始事件**，
// 其中 user 事件携带的是内部 sentinel+persona 文本，不适合 UI 直接渲染；且 broadcast 无
// roomId 过滤，日常对话事件会混进聊天室 UI。ChatRoomEvent 是**面向 UI 的干净、带 roomId
// 的结构化事件**，是多房间事件隔离 + 干净渲染的唯一事件源。
//
// 方案 B（采纳）：新开类型，**不走 AgentLoopEvent**——由接线层（Claude）在 desktop-host 的
// onBotReply/onSummary 回调里，经 agentListeners/agent-channel 单独 broadcast 成 WS 事件；
// UI 据此渲染气泡/摘要，并按 roomId 过滤（只渲染当前房间）。
//
// CB 侧职责：在 types.ts 定义类型 + 在 chat-room-runtime.ts 把数据（落盘后的 bot 回复、
// 摘要）准备成这些事件。desktop-host 的 no-op→emit 接线归 Claude。
// 衔接面见 docs/交接单/v0.28-聊天室事件结构化推送-交接卡-20261015.md。

/** bot 回复结构化事件（onBotReply payload）。一条 bot 回复落盘后推给 UI。 */
export interface ChatRoomBotReplyEvent {
  readonly kind: 'chat-bot-reply';
  readonly roomId: string;
  /** persona 名（语义身份；UI 头像/名称用）。 */
  readonly persona: string;
  /** 运行时 botId（main/sub 判定用）。 */
  readonly botId: string;
  readonly senderType: ChatSenderType;
  /** 净回复内容（已过 HandoffParser，无 @接力标记）。 */
  readonly content: string;
  /** 落盘后的消息 id（UI 去重/定位用）。 */
  readonly messageId: string;
  readonly timestamp: number;
}

/** bot 生成失败的结构化事件。 */
export interface ChatRoomBotErrorEvent {
  readonly kind: 'chat-bot-error';
  readonly roomId: string;
  readonly persona: string;
  readonly botId: string;
  readonly error: string;
  readonly timestamp: number;
}

/** 房间摘要结构化事件（onSummary payload）。摘要落快照成功后推给 UI。 */
export interface ChatRoomSummaryEvent {
  readonly kind: 'chat-summary';
  readonly roomId: string;
  /** 摘要文本（已累加的历史摘要）。 */
  readonly summary: string;
  /** 摘要覆盖到哪条消息为止（through）。UI 可据此去重。 */
  readonly throughMessageId: string;
  readonly timestamp: number;
}

/**
 * 会议策略（v0.29）。会议开始时由主 bot 判断并生成，持久化后注入各 bot 的人设指令。
 * 语义：一场「值得总结」的讨论应满足什么条件、大概几轮讨论后值得沉淀一次。
 */
export interface MeetingStrategy {
  /** 本次会议重点跟踪的议题。 */
  readonly focusTopics: readonly string[];
  /** 累计多少轮「有 bot 回复」的讨论后自动触发一次摘要。 */
  readonly minRoundsBeforeAutoSummary: number;
  /** 摘要风格提示（可选）。 */
  readonly summaryStyle?: string;
}

/** 会议生命周期状态。无 meeting → idle；开会 → active；散会 → closed。 */
export type MeetingStatus = 'idle' | 'active' | 'closed';

/** 会议状态变更结构化事件（onMeetingStateChange payload）。开会/散会时推给 UI 更新状态指示。 */
export interface ChatRoomMeetingStateEvent {
  readonly kind: 'meeting-state';
  readonly roomId: string;
  readonly status: MeetingStatus;
  readonly strategy: MeetingStrategy | null;
  readonly timestamp: number;
}

/**
 * 一轮讨论完成事件（onRoundComplete payload）。handleUserMessage 走完 planRound + 落盘 +
 * 摘要门控后推给 UI，让 UI 解锁输入框（reset roundInProgress）。
 *
 * 为什么需要：v0.28 UI 的 roundInProgress 仅靠 main bot 摘要器的 `done` 事件复位——
 * v0.29 无会议时跳过 summarize()，main bot 不跑，`done` 不发，输入框永久锁死。
 * 这个事件给 UI 一个**确定性的轮次结束信号**，不依赖摘要是否跑。
 */
export interface ChatRoomRoundCompleteEvent {
  readonly kind: 'round-complete';
  readonly roomId: string;
  /** 本轮回复的成员数（0 = 无人回复，UI 仍应解锁）。 */
  readonly memberCount: number;
  readonly timestamp: number;
}

// ===== SubBotReport 协议（v0.30）=====
//
// 为什么需要：v0.30 之前所有 bot 回复都是同步内联的（planRound 逐个 send，UI 等整轮）。
// 审计等长任务需要子 bot 离线执行 → 产结构化报告 → 主 bot 汇总，不在聊天室里灌全文。
// SubBotReport 是子 bot 任务产出的数据契约：summary（≤500 字进上下文）+ findings（结构化）
// + evidenceRefs（指针不内联）+ transcriptPath（全文落盘供追溯）。
// 设计稿：docs/架构文档/设计稿-Bot编排-账号槽位人设三层解耦-20261014.md:142-158。

/** 审计发现严重程度。 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 单条审计发现（结构化条目）。 */
export interface Finding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  /** 文件:行 或其他定位串。 */
  readonly location: string;
  readonly description: string;
  /** 指向 transcript 中的证据（不内联全文）。 */
  readonly evidenceRef: string;
}

/**
 * 子 bot 任务报告（v0.30）。一个离线审计槽位完成后的产出。
 * 报告本身是纯数据——不加 status/timestamps：状态由 task-complete 事件携带（ok/error），
 * 时间戳在事件上。
 */
export interface SubBotReport {
  readonly slotId: string;
  readonly dimension: string;
  /** ≤500 字，进上下文。 */
  readonly summary: string;
  readonly findings: readonly Finding[];
  /** 证据引用指针，不内联全文。 */
  readonly evidenceRefs: readonly string[];
  /** 全文落盘路径 runs/<batchId>/<slotId>.jsonl（供追溯，不进上下文）。 */
  readonly transcriptPath: string;
}

/**
 * 报告存储契约（v0.30）。Claude 定义接口，CB 实现 FS 版（report-store.ts）。
 * 设计稿 :161 指定 FS（jsonl + report.json），不进 SQLite。
 * Claude 用 InMemoryReportStore（测试桩）并行建全部新文件，CB 交付 FS 版后一行换。
 */
export interface ReportStore {
  /** mkdir -p runs/<batchId>，返回该批次目录路径。 */
  ensureBatchDir(batchId: string): string;
  /** 写 jsonl 一行到 runs/<batchId>/<slotId>.jsonl。 */
  appendTranscript(batchId: string, slotId: string, event: unknown): void;
  /** 原子写 runs/<batchId>/<slotId>.report.json。 */
  writeSubReport(batchId: string, slotId: string, report: SubBotReport): void;
  /** 读该批次所有 .report.json。 */
  readSubReports(batchId: string): SubBotReport[];
  /** 写 runs/<batchId>/summary.md，返回路径。 */
  writeMergedReport(batchId: string, content: string): string;
  /** 返回 summary.md 路径，不存在返 ''。 */
  getMergedReportPath(batchId: string): string;
}

// ===== v0.30 任务事件（加进 ChatRoomEvent union）=====
//
// 术语统一：用 batchId（一批审计），不用 Scheduler 的 runId（单次 send 句柄）。
// 这三个事件经 emitChatRoomEvent → agent-channel → WS → UI handleStructuredEvent 渲染。

/** 子 bot 任务进度事件（离线执行开始/步进时推给 UI）。 */
export interface ChatRoomTaskProgressEvent {
  readonly kind: 'task-progress';
  readonly roomId: string;
  readonly batchId: string;
  readonly slotId: string;
  readonly dimension: string;
  /** running=开始执行；step=有可观察的步进。 */
  readonly status: 'running' | 'step';
  readonly step?: number;
  readonly message?: string;
  readonly timestamp: number;
}

/** 子 bot 任务完成事件（成功/失败时推给 UI，携带 finding 数或错误）。 */
export interface ChatRoomTaskCompleteEvent {
  readonly kind: 'task-complete';
  readonly roomId: string;
  readonly batchId: string;
  readonly slotId: string;
  readonly dimension: string;
  readonly ok: boolean;
  readonly findingCount: number;
  readonly error?: string;
  readonly timestamp: number;
}

/** 综合报告就绪事件（所有维度合并完成后推给 UI，含各子报告摘要 + 路径）。 */
export interface ChatRoomReportReadyEvent {
  readonly kind: 'report-ready';
  readonly roomId: string;
  readonly batchId: string;
  readonly summaryPath: string;
  readonly subReports: ReadonlyArray<{
    readonly slotId: string;
    readonly dimension: string;
    readonly findingCount: number;
    readonly summary: string;
  }>;
  readonly timestamp: number;
}

/** 聊天室结构化事件联合。UI + 多房间隔离的唯一事件源。 */
export type ChatRoomEvent =
  | ChatRoomBotReplyEvent
  | ChatRoomBotErrorEvent
  | ChatRoomSummaryEvent
  | ChatRoomMeetingStateEvent
  | ChatRoomRoundCompleteEvent
  | ChatRoomTaskProgressEvent
  | ChatRoomTaskCompleteEvent
  | ChatRoomReportReadyEvent;
