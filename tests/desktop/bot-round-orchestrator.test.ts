/**
 * v0.27a 验收测试：RoundOrchestrator（轮次编排）
 *
 * 验收（路线图 + 答疑 ★Q1/★Q2/★Q3）：
 * - planRound({trigger:@前端专家}) → 前端专家回复，若其文本 @后端专家 → pendingHandoff 含 backend-expert
 * - maxDepth=1（默认）：只跑路由波，接力目标不执行、进 pendingHandoff
 * - maxDepth=2 互相 @：A→B→A 靠 spoken 截断，pendingHandoff 不再增长
 * - fail-soft：某 persona 的 generateReply 抛错 → 该位 contents=''、不进 pendingHandoff、整轮不炸
 * - priorContents 传播：同一波后者能读到前者净回复；spokenOrder 与 priorContents key 顺序一致
 * - 两轮：连续调两次 planRound，第 2 轮 trigger=@后端专家 → 后端专家进 members（不续轮、不加 planFollowUp）
 */
import { describe, it, expect } from 'vitest';
import { DefaultRoundOrchestrator, type GenerateReplyContext } from '../../src/host/bot/round-orchestrator';
import { DefaultMentionRouter } from '../../src/host/bot/mention-router';
import { DefaultHandoffParser } from '../../src/host/bot/handoff-parser';
import { MapParticipantResolver } from '../../src/host/bot/participant-resolver';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import type { Participant, RoomConfig, ChatMessage } from '../../src/host/bot/types';

const participants: Participant[] = [
  { name: 'frontend-expert', botId: 'bot-fe' },
  { name: 'backend-expert', botId: 'bot-be' },
];

const room: RoomConfig = {
  roomId: 'r1',
  roomName: '架构评审',
  memberPersonas: ['frontend-expert', 'backend-expert'],
};

const parser = new DefaultMentionParser();
const resolver = new MapParticipantResolver(participants);
const router = new DefaultMentionRouter(parser, resolver);
const handoff = new DefaultHandoffParser(parser);

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

/** 可配置回复 + 记录调用 ctx（用于断言 priorContents 传播）。 */
function stubGenerate(replyMap: Record<string, string>, throwFor?: string) {
  const calls: Array<{ persona: string; ctx: GenerateReplyContext }> = [];
  const fn = async (persona: string, ctx: GenerateReplyContext): Promise<string> => {
    calls.push({ persona, ctx });
    if (throwFor && persona === throwFor) throw new Error(`boom:${persona}`);
    return replyMap[persona] ?? '';
  };
  return { fn, calls };
}

describe('RoundOrchestrator', () => {
  it('@前端专家 回复并 @后端专家 → pendingHandoff 含 backend-expert', async () => {
    const { fn } = stubGenerate({ 'frontend-expert': '@backend-expert 你说得对' });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn });
    const round = await orch.planRound({ trigger: msg('@frontend-expert 问题'), room, participants });
    expect(round.members).toEqual(['frontend-expert']);
    expect(round.pendingHandoff).toEqual(['backend-expert']);
    expect(round.contents['frontend-expert']).toBe('你说得对'); // 净内容（剥 @）
  });

  it('maxDepth=1：接力目标不执行（不在 members，只在 pendingHandoff）', async () => {
    const { fn } = stubGenerate({ 'frontend-expert': '@backend-expert 接力' });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn, maxDepth: 1 });
    const round = await orch.planRound({ trigger: msg('@frontend-expert 问题'), room, participants });
    expect(round.members).toEqual(['frontend-expert']);
    expect(round.pendingHandoff).toEqual(['backend-expert']);
  });

  it('maxDepth=2 互相 @：A→B→A 靠 spoken 截断，pendingHandoff 不增长', async () => {
    const { fn } = stubGenerate({
      'frontend-expert': '@backend-expert 接力',
      'backend-expert': '@frontend-expert 回接',
    });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn, maxDepth: 2 });
    const round = await orch.planRound({ trigger: msg('@frontend-expert 问题'), room, participants });
    expect(round.members).toEqual(['frontend-expert', 'backend-expert']);
    expect(round.pendingHandoff).toEqual([]); // B 回接 A，但 A 已 spoken → 不进 pendingHandoff
  });

  it('fail-soft：某 persona 抛错 → 该位 contents 为空、不进 pendingHandoff、整轮不炸', async () => {
    const { fn } = stubGenerate(
      { 'backend-expert': '我补充一下' },
      'frontend-expert',
    );
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn });
    const round = await orch.planRound({ trigger: msg('@all 大家说'), room, participants });
    expect(round.members).toEqual(['frontend-expert', 'backend-expert']);
    expect(round.contents['frontend-expert']).toBe(''); // 异常 → 空
    expect(round.errors?.['frontend-expert']).toContain('boom:frontend-expert');
    expect(round.contents['backend-expert']).toBe('我补充一下');
    expect(round.pendingHandoff).toEqual([]); // 抛错者不解析接力
  });

  it('priorContents 传播：同波后者能读前者净回复，spokenOrder 与 key 顺序一致', async () => {
    const { fn, calls } = stubGenerate({
      'frontend-expert': 'FE 观点',
      'backend-expert': 'BE 观点',
    });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn });
    await orch.planRound({ trigger: msg('@all 讨论'), room, participants });
    const beCall = calls.find((c) => c.persona === 'backend-expert');
    expect(beCall?.ctx.priorContents['frontend-expert']).toBe('FE 观点');
    expect(beCall?.ctx.spokenOrder).toEqual(['frontend-expert']);
  });

  it('两轮：连续两次 planRound，第 2 轮 trigger=@后端专家 → 后端专家进 members', async () => {
    const { fn } = stubGenerate({
      'frontend-expert': '@backend-expert 补充',
      'backend-expert': '收到',
    });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn });
    const r1 = await orch.planRound({ trigger: msg('@frontend-expert 问题'), room, participants });
    expect(r1.pendingHandoff).toEqual(['backend-expert']);
    const r2 = await orch.planRound({ trigger: msg('@backend-expert 继续'), room, participants });
    expect(r2.members).toEqual(['backend-expert']);
    expect(r2.pendingHandoff).toEqual([]);
  });
});

describe('A 任务：上下文传递与接力链路（独立证明，不依赖接线层测试）', () => {
  it('A1: planRound 多目标时，第 2 个目标的 generateReply ctx.priorContents 含第 1 个目标的净回复', async () => {
    const { fn, calls } = stubGenerate({ 'frontend-expert': 'FE观点', 'backend-expert': 'BE观点' });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn });
    await orch.planRound({ trigger: msg('@all 讨论'), room, participants });
    const beCall = calls.find((c) => c.persona === 'backend-expert');
    expect(beCall?.ctx.priorContents['frontend-expert']).toBe('FE观点');
  });

  it('A2: ctx.spokenOrder 与 priorContents 的 key 顺序一致', async () => {
    const { fn, calls } = stubGenerate({ 'frontend-expert': 'FE观点', 'backend-expert': 'BE观点' });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn });
    await orch.planRound({ trigger: msg('@all 讨论'), room, participants });
    const beCall = calls.find((c) => c.persona === 'backend-expert');
    expect(beCall?.ctx.spokenOrder).toEqual(['frontend-expert']);
    expect(Object.keys(beCall?.ctx.priorContents ?? {})).toEqual(beCall?.ctx.spokenOrder);
  });

  it('A3: 接力链 A→B→A 被截断（A 第二次出现 spoken.has 命中，不进 pendingHandoff）', async () => {
    const { fn } = stubGenerate({ 'frontend-expert': '@backend-expert 接力', 'backend-expert': '@frontend-expert 回接' });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn, maxDepth: 2 });
    const round = await orch.planRound({ trigger: msg('@frontend-expert 问题'), room, participants });
    expect(round.members).toEqual(['frontend-expert', 'backend-expert']);
    expect(round.pendingHandoff).toEqual([]); // B 回接 A，但 A 已 spoken → 被截断，不进 pendingHandoff
  });

  it('A4: maxDepth:2 A 回 @B → B 真的在 nextWave 执行，且 B 的 ctx.priorContents 含 A 的净回复', async () => {
    const { fn, calls } = stubGenerate({
      'frontend-expert': '@backend-expert 前端说：接口用REST',
      'backend-expert': '后端收到，数据格式用JSON',
    });
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn, maxDepth: 2 });
    const round = await orch.planRound({ trigger: msg('@frontend-expert 起头'), room, participants });
    expect(round.members).toEqual(['frontend-expert', 'backend-expert']); // B 在 nextWave 被执行
    const beCall = calls.find((c) => c.persona === 'backend-expert');
    expect(beCall?.ctx.priorContents['frontend-expert']).toBe('前端说：接口用REST'); // B 看到 A 的净回复
    expect(round.pendingHandoff).toEqual([]);
  });

  it('A5: fail-soft 下 B 引擎抛错 → B 的 contents 是 ""、不解析其接力、A 继续正常', async () => {
    const { fn } = stubGenerate({ 'frontend-expert': '我补充一下' }, 'backend-expert');
    const orch = new DefaultRoundOrchestrator({ router, handoffParser: handoff, participantResolver: resolver, generateReply: fn });
    const round = await orch.planRound({ trigger: msg('@all 大家说'), room, participants });
    expect(round.members).toEqual(['frontend-expert', 'backend-expert']);
    expect(round.contents['backend-expert']).toBe(''); // 异常 → 空
    expect(round.pendingHandoff).toEqual([]); // B 的接力未被解析
    expect(round.contents['frontend-expert']).toBe('我补充一下'); // A 正常
  });
});
