/**
 * v0.27a 验收测试：HandoffParser（接力解析）
 *
 * 验收（路线图 + 答疑 Q4）：
 * - 净内容 = stripMentionTokens：已注册 @名 + @all 被剥掉
 * - 未注册 @名保留在净内容里（让用户看到拼错）+ 进 unresolved
 * - @all 在接力层不算接力（targets 不含、不进 pendingHandoff）
 */
import { describe, it, expect } from 'vitest';
import { DefaultHandoffParser } from '../../src/host/bot/handoff-parser';
import { DefaultMentionParser } from '../../src/host/bot/mention-parser';
import type { Participant } from '../../src/host/bot/types';

const participants: Participant[] = [
  { name: 'frontend-expert', botId: 'bot-fe' },
  { name: 'backend-expert', botId: 'bot-be' },
];

const parser = new DefaultHandoffParser(new DefaultMentionParser());

describe('HandoffParser', () => {
  it('已注册 @名 → 净内容剥离该 @，进 targets', () => {
    const r = parser.parse('@frontend-expert 来看这段代码', participants);
    expect(r.content).toBe('来看这段代码');
    expect(r.targets).toEqual(['frontend-expert']);
    expect(r.unresolved).toEqual([]);
  });

  it('@all → 不接力（targets 空）、净内容剥离 @all', () => {
    const r = parser.parse('@all 大家说说', participants);
    expect(r.content).toBe('大家说说');
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });

  it('未注册 @名 → 保留在净内容 + 进 unresolved', () => {
    const r = parser.parse('@typo-name 来接手', participants);
    expect(r.content).toBe('@typo-name 来接手'); // 原文保留
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toEqual(['typo-name']);
  });

  it('已注册 @名 + @all 混合：@all 不算接力，已注册进 targets', () => {
    const r = parser.parse('@frontend-expert 和 @all 一起看', participants);
    expect(r.content).toBe('和 一起看');
    expect(r.targets).toEqual(['frontend-expert']);
    expect(r.unresolved).toEqual([]);
  });

  it('多个已注册 @名去重；未注册去重', () => {
    const r = parser.parse('@frontend-expert @frontend-expert @ghost @ghost', participants);
    expect(r.targets).toEqual(['frontend-expert']);
    expect(r.unresolved).toEqual(['ghost']);
  });

  it('无任何 @ → 净内容原样、无 targets、无 unresolved', () => {
    const r = parser.parse('我自己总结一下', participants);
    expect(r.content).toBe('我自己总结一下');
    expect(r.targets).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });
});
