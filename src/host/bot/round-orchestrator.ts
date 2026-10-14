/**
 * RoundOrchestrator（v0.27a 聊天室指令与接力层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 RoundOrchestrator（Claude 锁定）。
 *
 * 决定一整个轮次里谁回、什么顺序、要不要接力。纯算法、无副作用、无状态：
 * 不碰 SQLite / web-engine / desktop-host / registry / slot-runtime。
 *
 * 设计（据答疑回复 ★Q1/★Q2/★Q3）：
 *   - 真实回复由构造注入的 generateReply 回调产出（生产由 Claude v0.27 接 WebEngine，测试用桩）。
 *   - 顺序回复：后者能读到前者的净回复（priorContents，key=persona，value=过 HandoffParser 的内容）；
 *     spokenOrder 与 priorContents 的 key 顺序一致（接线层据此顺序灌进 ContextEngine）。
 *   - maxDepth = 波数（非跳数）：默认 1 = 只跑第 0 波（路由 targets），其接力目标不执行、进 pendingHandoff；
 *     maxDepth:2 追加执行第 1 波。A→B→A 靠 spoken 集合截断（本轮已出现的人不再进 pendingHandoff）。
 *   - fail-soft：generateReply 抛错 → 该 persona 的 contents 记 ''、不解析其接力、继续编下一位，
 *     不让一个 bot 异常炸掉整轮。
 *   - 两轮编排 = 调用方连续调两次 planRound（第 2 轮 trigger 为 @某人 的消息），本类不续轮、不加 planFollowUp。
 */

import type {
  RoundOrchestrator,
  ConversationRound,
  MentionRouter,
  HandoffParser,
  ParticipantResolver,
  ChatMessage,
  RoomConfig,
  Participant,
} from './types';

/** generateReply 的上下文（据 ★Q1 锁定语义）。 */
export interface GenerateReplyContext {
  /** 触发这一轮的用户消息。 */
  readonly trigger: ChatMessage;
  /** 房间配置。 */
  readonly room: RoomConfig;
  /** 本轮已产生净回复的 persona → 净回复内容（后者读前者）。 */
  readonly priorContents: Readonly<Record<string, string>>;
  /** 参与者视图（persona ↔ botId）。 */
  readonly participants: readonly Participant[];
  /** 与 priorContents 的 key 顺序一致的有序投影。 */
  readonly spokenOrder: readonly string[];
}

export type GenerateReply = (persona: string, ctx: GenerateReplyContext) => Promise<string>;

export class DefaultRoundOrchestrator implements RoundOrchestrator {
  private readonly router: MentionRouter;
  private readonly handoffParser: HandoffParser;
  private readonly participantResolver: ParticipantResolver;
  private readonly generateReply: GenerateReply;
  private readonly maxDepth: number;

  constructor(opts: {
    router: MentionRouter;
    handoffParser: HandoffParser;
    participantResolver: ParticipantResolver;
    generateReply: GenerateReply;
    maxDepth?: number;
  }) {
    this.router = opts.router;
    this.handoffParser = opts.handoffParser;
    this.participantResolver = opts.participantResolver;
    this.generateReply = opts.generateReply;
    const md = opts.maxDepth ?? 1;
    this.maxDepth = md < 1 ? 1 : md;
  }

  async planRound(input: {
    readonly trigger: ChatMessage;
    readonly room: RoomConfig;
    readonly participants: readonly Participant[];
  }): Promise<ConversationRound> {
    const { trigger, room, participants } = input;
    const decision = this.router.route({ message: trigger, room, participants });

    const spoken = new Set<string>();
    const order: string[] = [];
    const contents: Record<string, string> = {};
    const pendingHandoff: string[] = [];

    let wave: string[] = [...decision.targets];
    let depth = 0;

    while (wave.length > 0 && depth < this.maxDepth) {
      const nextWave: string[] = [];
      for (const persona of wave) {
        if (spoken.has(persona)) continue;

        // 组装 priorContents / spokenOrder（与已发言顺序一致）。
        const priorContents: Record<string, string> = {};
        for (const p of order) priorContents[p] = contents[p];
        const ctx: GenerateReplyContext = {
          trigger,
          room,
          priorContents,
          participants,
          spokenOrder: order.slice(),
        };

        // fail-soft：单 bot 异常不炸整轮。
        let reply: string;
        try {
          reply = await this.generateReply(persona, ctx);
        } catch {
          contents[persona] = '';
          spoken.add(persona);
          order.push(persona);
          continue; // 不解析其接力、不进 pendingHandoff
        }

        // 解析接力 + 净内容（res.content 即「净回复」：剥已注册 @名后、保留未注册名）。
        // ConversationRound.contents 与 priorContents 都要求存净回复（过 HandoffParser 之后）。
        const res = this.handoffParser.parse(reply, participants);
        contents[persona] = res.content;
        spoken.add(persona);
        order.push(persona);

        // 解析接力：命中且本轮未出现过 → 下一波（depth+1<maxDepth）或 pendingHandoff。
        for (const t of res.targets) {
          const p = this.participantResolver.resolve(t, room);
          if (!p || spoken.has(t)) continue;
          if (depth + 1 < this.maxDepth) {
            if (!nextWave.includes(t)) nextWave.push(t);
          } else if (!pendingHandoff.includes(t)) {
            pendingHandoff.push(t);
          }
        }
      }
      wave = nextWave;
      depth += 1;
    }

    return {
      roomId: room.roomId,
      triggerMessageId: trigger.id,
      members: order,
      contents,
      pendingHandoff,
    };
  }
}
