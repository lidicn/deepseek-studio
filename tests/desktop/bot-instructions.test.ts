/**
 * v0.27a：聊天室人设指令模板测试。
 *
 * createAgentInstructionBuilder 是纯文本生成器，测试重点是「输出对 bot 的行为约束是否真的写进了提示词」——
 * 这几条规则不是文案美化，是多 bot 聊天室不出事故的底线：
 *   - 越界发言（bot 装作懂自己不负责的领域）
 *   - 各说各话变成各说同话（复述别人结论，零增量）
 *   - 抢话（A 一直接，其他人永远轮不上）
 *   - 幻觉接力（@一个不存在的人设，被静默丢弃）
 */

import { describe, expect, it } from 'vitest';
import { createAgentInstructionBuilder } from '../../src/host/bot/instructions';

const ROOM = {
  agentName: 'audit-expert',
  roomName: '架构评审室',
  agentDescription: '负责并发安全、竞态条件与资源泄漏审查',
  memberNames: ['frontend-expert', 'backend-expert', 'audit-expert'] as const,
  summary: '已讨论过登录链路与 SSE 流式帧解析，确认帧边界需要状态机处理。',
};

describe('agent-instructions —— 人设指令模板', () => {
  it('输出身份、房间、摘要、成员四段，且人设名与描述都在', () => {
    const { instructions } = createAgentInstructionBuilder().build(ROOM);

    expect(instructions).toContain('audit-expert');
    expect(instructions).toContain('并发安全');
    expect(instructions).toContain('架构评审室');
    expect(instructions).toContain('SSE 流式帧解析');
    // 在场成员含全部三人
    expect(instructions).toContain('frontend-expert');
    expect(instructions).toContain('backend-expert');
  });

  it('接力提示只列其他成员，不含自己（自己 @自己 没有意义）', () => {
    const { instructions } = createAgentInstructionBuilder().build(ROOM);
    const handoffLine = instructions
      .split('\n')
      .find((l) => l.includes('接着讨论时'));

    expect(handoffLine).toBeDefined();
    expect(handoffLine).toContain('frontend-expert');
    expect(handoffLine).toContain('backend-expert');
    // 关键：不能把自己列成接力目标
    expect(handoffLine).not.toContain('@audit-expert');
  });

  it('唯一成员时不产生接力指令，并明确说明无需 @点名', () => {
    const { instructions } = createAgentInstructionBuilder().build({
      ...ROOM,
      memberNames: ['audit-expert'],
    });

    // 成员列表仍列出自己（在场成员只有 1 人），但不再出现接力指令
    expect(instructions).toContain('audit-expert');
    expect(instructions).toContain('无需 @点名');
    expect(instructions).not.toContain('仅你一人');
    expect(instructions).not.toContain('接着讨论时');
  });

  it('含边界约束：不越界、不代替他人、不复述已说结论', () => {
    const { instructions } = createAgentInstructionBuilder().build(ROOM);

    expect(instructions).toContain('职责范围内');
    expect(instructions).toContain('不要替其他人发言');
    expect(instructions).toContain('复述');
    expect(instructions).toContain('拿不准的不要下结论');
  });

  it('人设描述为空时落到兜底文案，而不是产出空段', () => {
    const { instructions } = createAgentInstructionBuilder({
      fallbackDescription: '未填写职责描述',
    }).build({ ...ROOM, agentDescription: '   ' });

    expect(instructions).toContain('未填写职责描述');
  });

  it('摘要为空时给出「尚无历史」提示，而非空段（bot 需要知道自己是否首轮）', () => {
    const { instructions } = createAgentInstructionBuilder().build({ ...ROOM, summary: '' });

    expect(instructions).toContain('尚无历史');
  });

  it('成员列表为空时显示「仅你一人」', () => {
    const { instructions } = createAgentInstructionBuilder().build({ ...ROOM, memberNames: [] });

    expect(instructions).toContain('仅你一人');
  });

  it('同入参必同出串（纯函数，可直接作为 PersonaInjector 用）', () => {
    const builder = createAgentInstructionBuilder();
    expect(builder.build(ROOM).instructions).toBe(builder.build(ROOM).instructions);
  });

  it('不同人设产出不同的接力目标列表（成员视图随 agentName 变化）', () => {
    const builder = createAgentInstructionBuilder();
    const asFrontend = builder
      .build({ ...ROOM, agentName: 'frontend-expert' })
      .instructions.split('\n')
      .find((l) => l.includes('接着讨论时'));

    // 前端专家视角：接力目标是后端 + 审计，不含自己
    expect(asFrontend).toContain('backend-expert');
    expect(asFrontend).toContain('audit-expert');
    expect(asFrontend).not.toContain('@frontend-expert');
  });
});
