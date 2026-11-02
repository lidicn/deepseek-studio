/**
 * M0 终态分布脚本（tools/metrics/term-state.ts）单测：锁分桶与容错行为。
 */

import { describe, it, expect } from 'vitest';
import { bucketTraceLines, mapTerm, classifyCaptureGroup } from '../../tools/metrics/term-state';

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
