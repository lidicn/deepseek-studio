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
