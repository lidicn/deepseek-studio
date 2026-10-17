/**
 * v0.27a 验收测试：MentionRouter（@路由）
 *
 * 验收（路线图 + 答疑 Q5/Q6）：
 * - @具体 → mode:'mention' + 该成员
 * - @具体 指向「注册但不在房」→ mode:'mention' + 空 targets（点名点空，不回退 @all/none）
 * - @all → mode:'all'，targets 走 resolver.all（已注册子集，非 room.memberPersonas 全集）
 * - 无 @ 有 host → mode:'host-fallback'
 * - 无 @ 无 host → mode:'none'
 * - 优先级：@具体 > @all（同一消息两者都有 → mention）
 */
import { describe, it, expect } from 'vitest';
import { DefaultMentionRouter } from '../../src/host/bot/mention-router';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import { MapParticipantResolver } from '../../src/host/bot/participant-resolver';
import type { Participant, RoomConfig, ChatMessage } from '../../src/host/bot/types';

const participants: Participant[] = [
  { name: 'frontend-expert', botId: 'bot-fe' },
  { name: 'backend-expert', botId: 'bot-be' },
  { name: 'auditor', botId: 'bot-au' }, // 注册但不在房
  { name: 'moderator', botId: 'bot-mod' }, // 主持人（注册）
];

const room: RoomConfig = {
  roomId: 'r1',
  roomName: '架构评审',
  memberPersonas: ['frontend-expert', 'backend-expert'],
};

// host-fallback 用例的房间：主持人 moderator 也是房间成员。
const roomWithHost: RoomConfig = {
  roomId: 'r1',
  roomName: '架构评审',
  hostPersona: 'moderator',
  memberPersonas: ['frontend-expert', 'backend-expert', 'moderator'],
};

const router = new DefaultMentionRouter(new DefaultMentionParser(), new MapParticipantResolver(participants));

function msg(content: string): ChatMessage {
  return {
    id: `m-${Math.random()}`,
    roomId: 'r1',
    senderId: 'u1',
    senderType: 'user',
    content,
    timestamp: Date.now(),
    mentions: [],
  };
}

describe('MentionRouter', () => {
  it('@具体 → mention + 该成员', () => {
    const d = router.route({ message: msg('@frontend-expert 看看这段代码'), room, participants });
    expect(d.mode).toBe('mention');
    expect(d.targets).toEqual(['frontend-expert']);
  });

  it('@具体 指向注册但不在房 → mention + 空 targets（点名点空，不回退）', () => {
    const d = router.route({ message: msg('@auditor 你来审'), room, participants });
    expect(d.mode).toBe('mention');
    expect(d.targets).toEqual([]);
  });

  it('@all → all，且 targets 为已注册子集（不含 auditor）', () => {
    const d = router.route({ message: msg('@all 大家聊聊'), room, participants });
    expect(d.mode).toBe('all');
    expect(d.targets).toEqual(['frontend-expert', 'backend-expert']);
  });

  it('无 @ 有 host（且 host 在房）→ host-fallback', () => {
    const d = router.route({ message: msg('这段代码怎么优化'), room: roomWithHost, participants });
    expect(d.mode).toBe('host-fallback');
    expect(d.targets).toEqual(['moderator']);
  });

  it('无 @ 无 host → none', () => {
    const r2: RoomConfig = { roomId: 'r2', roomName: 'x', memberPersonas: ['frontend-expert'] };
    const d = router.route({ message: msg('随便聊聊'), room: r2, participants });
    expect(d.mode).toBe('none');
    expect(d.targets).toEqual([]);
  });

  it('优先级：@具体 > @all（同一消息两者都有 → mention）', () => {
    const d = router.route({ message: msg('@frontend-expert 和 @all 都看看'), room, participants });
    expect(d.mode).toBe('mention');
    expect(d.targets).toEqual(['frontend-expert']);
  });

  it('与 MentionParser 一致：@具体 命中依赖同一 participants 列表', () => {
    const d = router.route({ message: msg('@backend-expert'), room, participants });
    expect(d.targets).toEqual(['backend-expert']);
  });
});
