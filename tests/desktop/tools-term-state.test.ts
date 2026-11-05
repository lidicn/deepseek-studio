/**
 * M0 终态分布脚本（tools/metrics/term-state.ts）单测：锁分桶与容错行为。
 */

import { describe, it, expect } from 'vitest';
import {
  bucketTraceLines,
  mapTerm,
  classifyCaptureGroup,
  collectRetryEvidence,
  buildRetryReport,
  buildFrequencyReport,
  renderReport,
  type DecisionEvent,
  type RequestSentEvent,
} from '../../tools/metrics/term-state';

describe('term-state · 映射表', () => {
  it('七终态 + read-no-data + 页端值全部有映射', () => {
    for (const raw of [
      'complete', 'truncated', 'disconnected', 'unknown', 'no-tool-calls', 'empty-response', 'max-rounds', 'read-no-data',
      'completed', 'continuation-truncated', 'truncated-tool-tag', 'max-loop', 'protocol-repair-failed',
    ]) {
      expect(mapTerm(raw)).not.toBeNull();
    }
  });

  it('未收录值返回 null（调用方单列，不崩）', () => {
    expect(mapTerm('weird-new-reason')).toBeNull();
    expect(mapTerm('interrupted')).toBeNull(); // M1 将新增，当前按未收录单列
  });
});

describe('term-state · trace 分桶', () => {
  it('同输入同分布；两种输入分布不同（防「打印常量」假分桶）', () => {
    const a = bucketTraceLines([
      '{"t":"turn.end","stopReason":"completed"}',
      '{"t":"turn.end","stopReason":"completed"}',
      '{"t":"turn.end","stopReason":"continuation-truncated"}',
    ]);
    const b = bucketTraceLines([
      '{"t":"turn.end","stopReason":"max-loop"}',
      '{"t":"turn.end","stopReason":"max-loop"}',
    ]);
    expect(a.buckets).toEqual({ complete: 2, truncated: 1 });
    expect(b.buckets).toEqual({ 'max-rounds': 2 });
    expect(a.buckets).not.toEqual(b.buckets);
  });

  it('未知 stopReason 进 unknown(未收录:…) 单列且不崩', () => {
    const d = bucketTraceLines([
      '{"t":"turn.end","stopReason":"brand-new-reason"}',
      '{"t":"turn.end","stopReason":"completed"}',
    ]);
    expect(d.buckets['unknown(未收录:brand-new-reason)']).toBe(1);
    expect(d.buckets.complete).toBe(1);
    expect(d.unmapped['brand-new-reason']).toBe(1);
    expect(d.total).toBe(2);
  });

  it('非 JSON 行 / 非 turn.end 行 / 缺 stopReason 都不算终态证据（缺 stopReason 单列）', () => {
    const d = bucketTraceLines([
      'hello not json',
      '{"kind":"msel","ok":true}',
      '{"t":"turn.end"}',
      '{"t":"turn.end","stopReason":"completed"}',
    ]);
    expect(d.total).toBe(2);
    expect(d.rawValues['(缺 stopReason)']).toBe(1);
    expect(d.buckets.complete).toBe(1);
  });
});

describe('term-state · 抓包分类', () => {
  it('task_complete 优先；quasi_status FINISHED 次之；长流无哨兵单列', () => {
    const tc = classifyCaptureGroup('r1', null, '{"status":200}', 'data: x <task_complete> ok');
    expect(tc.classify).toBe('complete-signal');
    const fin = classifyCaptureGroup('r2', null, null, 'data: {"p":"quasi_status","v":"FINISHED"}');
    expect(fin.classify).toBe('finished-signal');
    const long = classifyCaptureGroup('r3', null, null, 'y'.repeat(3000));
    expect(long.classify).toBe('long-stream-no-sentinel');
    const short = classifyCaptureGroup('r4', null, null, 'ok');
    expect(short.classify).toBe('short-body-no-sentinel');
    const none = classifyCaptureGroup('r5', null, null, null);
    expect(none.classify).toBe('no-response-body');
  });

  it('agent 判定只看请求哨兵，不看响应', () => {
    const g = classifyCaptureGroup('r6', 'prefix 【Studio Agent】 task', null, 'body');
    expect(g.agentDriven).toBe(true);
    const h = classifyCaptureGroup('r7', 'plain user text', null, 'body');
    expect(h.agentDriven).toBe(false);
  });
});

// ── M3-1：retryable 重试占比口径（分列分子 / request.sent 分母 / 预算耗尽单列）──────────

function mkDecision(reason: string, triggered: boolean, turnId = 't-1'): DecisionEvent {
  return { turnId, reason, triggered };
}
function mkSent(turnId = 't-1', bytes = 100): RequestSentEvent {
  return { turnId, bytes };
}

describe('term-state · retry 口径采集（collectRetryEvidence）', () => {
  it('三类重试 + request.sent + 预算耗尽终态各自入桶；噪声行不进', () => {
    const ev = collectRetryEvidence([
      '{"t":"continuation.decision","turnId":"t-1","reason":"first-attempt-retry","triggered":true}',
      '{"t":"continuation.decision","turnId":"t-1","reason":"error-retry-network-error","triggered":true}',
      '{"t":"continuation.decision","turnId":"t-1","reason":"continuation-truncated","triggered":true}',
      '{"t":"request.sent","turnId":"t-1","bytes":10240}',
      '{"t":"turn.end","turnId":"t-1","finished":false,"stopReason":"first-attempt-retry-out"}',
      // 噪声：非重试 decision / 非 JSON / 其他事件
      '{"t":"continuation.decision","turnId":"t-1","reason":"user-aborted","triggered":false}',
      '{"t":"tool.parsed","turnId":"t-1","name":"file.read","status":"ok"}',
      'not json at all',
    ]);
    expect(ev.decisions).toHaveLength(4);
    expect(ev.requestsSent).toHaveLength(1);
    expect(ev.firstAttemptRetryOutTurnEnds).toBe(1);
  });
});

describe('term-state · retry 聚合（buildRetryReport）', () => {
  it('① 每类重试各一条样例 → 分列计数正确、占比 = 分子/分母A', () => {
    const decisions = [
      mkDecision('first-attempt-retry', true),
      mkDecision('error-retry-network-error', true),
      mkDecision('error-retry-server-error', true),
      mkDecision('continuation-truncated', true),
    ];
    const sent = [mkSent(), mkSent(), mkSent(), mkSent(), mkSent()]; // 分母 A = 5
    const r = buildRetryReport(decisions, sent, 0);
    expect(r.requestsSent).toBe(5);
    expect(r.firstAttemptRetry).toBe(1);
    expect(r.errorRetry).toBe(2);
    expect(r.errorRetryByReason['network-error']).toBe(1);
    expect(r.errorRetryByReason['server-error']).toBe(1);
    expect(r.truncatedResend).toBe(1);
    expect(r.retryShare).toBeCloseTo(4 / 5);
    expect(r.perClassShare.firstAttempt).toBeCloseTo(1 / 5);
    expect(r.perClassShare.errorRetry).toBeCloseTo(2 / 5);
    expect(r.perClassShare.truncated).toBeCloseTo(1 / 5);
  });

  it('② 负控：去掉某类重试打点 → 聚合里该类计数归零（口径真在咬事件，不是常量）', () => {
    const noErrorRetry = [
      mkDecision('first-attempt-retry', true),
      mkDecision('continuation-truncated', true),
    ].filter((d) => !(d.reason ?? '').startsWith('first-attempt'));
    const r = buildRetryReport(noErrorRetry, [mkSent(), mkSent()], 0);
    expect(r.firstAttemptRetry).toBe(0);
    expect(r.errorRetry).toBe(0);
    expect(r.errorRetryByReason).toEqual({});
    expect(r.truncatedResend).toBe(1);
    expect(r.retryShare).toBeCloseTo(1 / 2);
  });

  it('③ 预算耗尽单列：不计入分子（重试被拒 ≠ 重试发生）', () => {
    const decisions = [
      mkDecision('error-budget-out', false),
      mkDecision('continuation-truncated-budget-out', false),
      mkDecision('first-attempt-retry', true),
    ];
    const r = buildRetryReport(decisions, [mkSent()], 1); // 1 条 first-attempt-retry-out turn.end
    expect(r.errorRetry).toBe(0);
    expect(r.truncatedResend).toBe(0);
    expect(r.firstAttemptRetry).toBe(1); // 只有真调度的算分子
    expect(r.budgetOut).toEqual({ firstAttemptRetryOut: 1, errorBudgetOut: 1, truncatedBudgetOut: 1 });
    expect(r.retryShare).toBe(1); // 1 次重试 / 1 次请求
  });

  it('④ 未触发事件（triggered:false）与无 turnId 事件：分子不计、分母仍计', () => {
    const decisions = [
      mkDecision('continuation-truncated', false), // 未触发，不计分子
      mkDecision('user-aborted', false),           // 非重试类
    ];
    const sent = [mkSent('t-1'), mkSent(''), mkSent('')]; // 后两条无 turnId（空串单列）
    const r = buildRetryReport(decisions, sent, 0);
    expect(r.truncatedResend).toBe(0);
    expect(r.retryShare).toBe(0);
    expect(r.requestsSent).toBe(3);
    expect(r.requestsSentWithTurnId).toBe(1);
  });

  it('⑤ 分母 0：占比归 0 不产生 NaN（缺报不编数）', () => {
    const r = buildRetryReport([mkDecision('first-attempt-retry', true)], [], 0);
    expect(r.requestsSent).toBe(0);
    expect(r.firstAttemptRetry).toBe(1);
    expect(r.retryShare).toBe(0);
    expect(Number.isNaN(r.retryShare)).toBe(false);
  });
});

describe('term-state · E3 渲染层：未采集 ≠ 零（PM 20261105 口径）', () => {
  const emptyDist = { buckets: {}, rawValues: {}, unmapped: {}, total: 0 };
  function render(freqRetry: ReturnType<typeof buildRetryReport>): string {
    const freq = buildFrequencyReport([], 0);
    freq.retry = freqRetry;
    return renderReport({
      trace: emptyDist,
      captures: [],
      logMentions: {},
      frequency: freq,
      inputs: ['x'],
      filesScanned: 0,
    });
  }

  it('retry 证据全零 → 表显示「未采集（无打点）」，不许出现 0 值分母行', () => {
    const md = render(buildRetryReport([], [], 0));
    expect(md).toContain('**未采集（无打点）**');
    expect(md).toContain('未采集 ≠ 零');
    expect(md).not.toContain('（request.sent 计数，含重试重发）');
    expect(md).not.toContain('重试合计 / 分母 A');
  });

  it('retry 证据非零 → 显示真实数字行（「未采集」不出现）', () => {
    const md = render(
      buildRetryReport(
        [mkDecision('first-attempt-retry', true), mkDecision('error-retry-429', true)],
        [mkSent(), mkSent(), mkSent()],
        0,
      ),
    );
    expect(md).toContain('（request.sent 计数，含重试重发）');
    expect(md).not.toContain('**未采集（无打点）**');
  });
});
