import { describe, it, expect } from 'vitest';
import { evaluatePlanGate, detectPlanRequest } from '../../src/host/plan-gate';

describe('detectPlanRequest', () => {
  it('/plan 开头 → true', () => {
    expect(detectPlanRequest('/plan 帮我改这个文件')).toBe(true);
  });
  it('/Plan 大小写不敏感', () => {
    expect(detectPlanRequest('/Plan 任务')).toBe(true);
  });
  it('前面有空白 → true', () => {
    expect(detectPlanRequest('  /plan 任务')).toBe(true);
  });
  it('普通消息 → false', () => {
    expect(detectPlanRequest('帮我读这个文件')).toBe(false);
  });
  it('/plantext 不命中（词边界）', () => {
    expect(detectPlanRequest('/plantext something')).toBe(false);
  });
});

describe('evaluatePlanGate', () => {
  it('plan 请求 → phase=plan, blockTools=true', () => {
    const r = evaluatePlanGate({ isPlanRequest: true, currentPhase: 'act', toolCalls: [] });
    expect(r.phase).toBe('plan');
    expect(r.blockTools).toBe(true);
    expect(r.reason).toBe('plan-no-tools');
  });

  it('plan 请求但模型调了工具 → 仍阻断', () => {
    const r = evaluatePlanGate({ isPlanRequest: true, currentPhase: 'act', toolCalls: [{ id: 't1' }] });
    expect(r.blockTools).toBe(true);
  });

  it('plan 阶段非 plan 请求 → 切 act', () => {
    const r = evaluatePlanGate({ isPlanRequest: false, currentPhase: 'plan', toolCalls: [] });
    expect(r.phase).toBe('act');
    expect(r.blockTools).toBe(false);
    expect(r.reason).toBe('plan-to-act-confirmation');
  });

  it('act 阶段普通消息 → 放行', () => {
    const r = evaluatePlanGate({ isPlanRequest: false, currentPhase: 'act', toolCalls: [{ id: 't1' }] });
    expect(r.phase).toBe('act');
    expect(r.blockTools).toBe(false);
    expect(r.reason).toBe('act-normal');
  });
});
