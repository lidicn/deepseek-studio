/**
 * ParticipantResolver（v0.27a 聊天室指令与接力层 · 副开发 CodeBuddy 实现）
 *
 * 契约来源：src/host/bot/types.ts 的 ParticipantResolver（Claude 锁定）。
 *
 * 纯算法、无副作用：persona 名（语义身份）↔ botId（运行时实例）的查表。
 * 不碰 SQLite / web-engine / desktop-host / registry。
 */

import type { Participant, ParticipantResolver, RoomConfig } from './types';

/** 基于内存 Map 的 ParticipantResolver 实现。构造注入注册表（name → botId）。 */
export class MapParticipantResolver implements ParticipantResolver {
  private readonly registry: Map<string, Participant>;

  constructor(registry: ReadonlyArray<Participant>) {
    this.registry = new Map(registry.map((p) => [p.name.toLowerCase(), p]));
  }

  /** 在房且已注册 → 返回 Participant；否则 undefined（不猜测、不兜底成别人的 botId）。 */
  resolve(personaName: string, room: RoomConfig): Participant | undefined {
    const p = this.registry.get(personaName.toLowerCase());
    if (!p) return undefined;
    if (!room.memberPersonas.includes(p.name)) return undefined;
    return p;
  }

  /** persona 名是否在房间内（只看房间配置，不管是否注册）。 */
  has(personaName: string, room: RoomConfig): boolean {
    return room.memberPersonas.includes(personaName);
  }

  /**
   * 返回房间「已注册且在房」的参与者，按 memberPersonas 顺序。
   * 注意：这是「当前可唤醒的成员子集」，不是 room.memberPersonas 配置全集——
   * 没注册的 bot 唤不醒（强行唤醒也只是空转）。MentionRouter 的 @all 路由应使用本方法而非配置全集。
   */
  all(room: RoomConfig): Participant[] {
    const out: Participant[] = [];
    for (const name of room.memberPersonas) {
      const p = this.registry.get(name.toLowerCase());
      if (p) out.push(p);
    }
    return out;
  }
}
