/**
 * MentionRouter（v0.27a 聊天室指令与接力层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 MentionRouter（Claude 锁定）。
 *
 * 把「消息 + 房间」变成「该谁回」。纯算法。
 * 解析复用 v0.26 的 MentionParser（同一 participants 列表），保证 @解析与路由一致。
 * 优先级：@具体名 > @all > 无@→主持人兜底 > none。
 *
 * 与 MentionParser 的分工：MentionParser 只认 participants 里的名字；本类再叠加「是否在房间内」
 * 的判断（resolver.has）与「@all → resolver.all 已注册子集」的收窄（而非 room.memberPersonas 全集）。
 */

import type { MentionRouter, MentionParser, ParticipantResolver, RoomConfig, Participant, RoutingDecision, ChatMessage } from './types';

export class DefaultMentionRouter implements MentionRouter {
  constructor(
    private readonly parser: MentionParser,
    private readonly resolver: ParticipantResolver,
  ) {}

  route(input: {
    readonly message: ChatMessage;
    readonly room: RoomConfig;
    readonly participants: readonly Participant[];
  }): RoutingDecision {
    const { message, room, participants } = input;

    // 1. @具体名：取 MentionParser 解析出的 agent 提及，仅保留房间内成员、去重保序。
    const agentMentions = this.parser
      .resolveMentions(message.content, participants)
      .filter((m) => m.type === 'agent' && m.participantId)
      .map((m) => m.participantId as string);
    const inRoomTargets = [...new Set(agentMentions)].filter((name) => this.resolver.has(name, room));
    // 只要发生过 @具体（无论是否点在房内成员），就保持 mention 模式，不回退 @all/none。
    // （点名点空由接线层按「mode:'mention' + 空 targets」当 unresolved 上报，非本层职责。）
    if (agentMentions.length > 0) {
      return { targets: inRoomTargets, mode: 'mention' };
    }

    // 2. @all：全员按 resolver.all（已注册且在房子集）顺序，而非 room.memberPersonas 配置全集。
    if (this.parser.isAllMentioned(message.content)) {
      return { targets: this.resolver.all(room).map((p) => p.name), mode: 'all' };
    }

    // 3. 无 @ 且有主持人 → 主持人兜底。
    if (room.hostPersona && this.resolver.has(room.hostPersona, room)) {
      return { targets: [room.hostPersona], mode: 'host-fallback' };
    }

    // 4. 无人该回。
    return { targets: [], mode: 'none' };
  }
}
