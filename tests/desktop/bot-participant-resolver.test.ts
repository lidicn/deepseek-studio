/**
 * v0.27a 验收测试：ParticipantResolver（persona 名 ↔ botId 查表）
 *
 * 验收（路线图 + 答疑 Q6）：
 * - resolve 未注册 → undefined（不兜底成别人的 botId）
 * - resolve 已注册但不在房 → undefined
 * - resolve 在房且注册 → 返回 Participant
 * - has = memberPersonas.includes（只看房间配置）
 * - all = 已注册且在房 子集（可唤醒子集，非配置全集），按 memberPersonas 顺序
 */
import { describe, it, expect } from 'vitest';
import { MapParticipantResolver } from '../../src/host/bot/participant-resolver';
import type { Participant, RoomConfig } from '../../src/host/bot/types';

const participants: Participant[] = [
  { name: 'frontend-expert', botId: 'bot-fe' },
  { name: 'backend-expert', botId: 'bot-be' },
  { name: 'unregistered-bot', botId: 'bot-x' },
];

const room: RoomConfig = {
  roomId: 'r1',
  roomName: '架构评审',
  memberPersonas: ['frontend-expert', 'backend-expert'], // 没有 unregistered-bot
};

const resolver = new MapParticipantResolver(participants);

describe('ParticipantResolver', () => {
  it('resolve 未注册 → undefined', () => {
    expect(resolver.resolve('ghost', room)).toBeUndefined();
  });

  it('resolve 已注册但不在房 → undefined', () => {
    expect(resolver.resolve('unregistered-bot', room)).toBeUndefined();
  });

  it('resolve 在房且注册 → 返回 Participant', () => {
    expect(resolver.resolve('frontend-expert', room)).toEqual({
      name: 'frontend-expert',
      botId: 'bot-fe',
    });
  });

  it('has 只看房间配置，不管注册', () => {
    expect(resolver.has('frontend-expert', room)).toBe(true);
    expect(resolver.has('unregistered-bot', room)).toBe(false); // 不在房
  });

  it('all 返回已注册且在房子集（非配置全集），按 memberPersonas 顺序', () => {
    const all = resolver.all(room).map((p) => p.name);
    expect(all).toEqual(['frontend-expert', 'backend-expert']); // 不含 unregistered-bot
  });
});
