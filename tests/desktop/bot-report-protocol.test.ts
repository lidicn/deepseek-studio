/**
 * report-protocol 单测（v0.30 · Claude 主开发）
 *
 * 覆盖：buildAuditTaskPrompt 含维度/目标、parseSubBotReport 合法 JSON、
 * stripCodeFence、prose+JSON 混合、非法 JSON 降级单 finding、severity 钳制、
 * 空输入兜底、findings 缺必填字段跳过。
 */
import { describe, it, expect } from 'vitest';
import {
  buildAuditTaskPrompt,
  parseSubBotReport,
  stripCodeFence,
} from '../../src/host/bot/report-protocol';
import type { SubBotReport } from '../../src/host/bot/types';

const TP = 'runs/batch-x/S1.jsonl';

describe('buildAuditTaskPrompt', () => {
  it('含维度和目标', () => {
    const p = buildAuditTaskPrompt('security', 'E:/NAS/AutoForge');
    expect(p).toContain('security');
    expect(p).toContain('E:/NAS/AutoForge');
    expect(p).toContain('JSON');
    expect(p).toContain('findings');
    expect(p).toContain('severity');
  });
});

describe('stripCodeFence', () => {
  it('剥离 ```json 围栏', () => {
    // stripCodeFence 去围栏但保留捕获组内容（含首尾空白）；parseSubBotReport 后续 .trim() 清理
    expect(stripCodeFence('```json\n{"a":1}\n```').trim()).toBe('{"a":1}');
  });
  it('剥离裸 ``` 围栏', () => {
    expect(stripCodeFence('```\n{"a":1}\n```').trim()).toBe('{"a":1}');
  });
  it('无围栏原样返回', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe('parseSubBotReport', () => {
  it('解析合法 JSON 为 SubBotReport', () => {
    const raw = JSON.stringify({
      summary: '发现 2 个问题',
      findings: [
        { id: 'F1', severity: 'high', title: 'SQL注入', location: 'db.ts:42', description: '拼接', evidenceRef: 'db.ts:42' },
        { id: 'F2', severity: 'critical', title: '越权', location: 'api.ts:88', description: '未校验', evidenceRef: 'api.ts:88' },
      ],
      evidenceRefs: ['db.ts:42', 'api.ts:88'],
    });
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.slotId).toBe('S1');
    expect(r.dimension).toBe('security');
    expect(r.transcriptPath).toBe(TP);
    expect(r.summary).toBe('发现 2 个问题');
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[1].severity).toBe('critical');
    expect(r.evidenceRefs).toEqual(['db.ts:42', 'api.ts:88']);
  });

  it('剥离 markdown 围栏后解析', () => {
    const raw = '```json\n{"summary":"ok","findings":[],"evidenceRefs":[]}\n```';
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.summary).toBe('ok');
    expect(r.findings).toHaveLength(0);
  });

  it('前后多余文字仍能定位 JSON', () => {
    const raw = '好的，审计结果：\n{"summary":"ok","findings":[]}\n以上请参考。';
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.summary).toBe('ok');
  });

  it('非法 JSON → 降级单条 medium finding', () => {
    const raw = '这不是JSON{focusTopics:}';
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe('medium');
    expect(r.findings[0].title).toContain('非结构化');
    expect(r.findings[0].description).toContain('这不是JSON');
  });

  it('severity 未知降为 medium', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [{ id: 'F1', severity: 'blocker', title: 't', location: 'l', description: 'd', evidenceRef: 'e' }],
      evidenceRefs: [],
    });
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.findings[0].severity).toBe('medium');
  });

  it('空输入 → 降级 finding', () => {
    const r = parseSubBotReport('', 'S1', 'security', TP);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe('medium');
  });

  it('findings 缺必填字段（无 title 无 description）→ 跳过该条', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [
        { id: 'F1', severity: 'high' }, // 无 title/description → 跳过
        { id: 'F2', severity: 'high', title: 't', description: 'd', location: 'l', evidenceRef: 'e' }, // 保留
      ],
      evidenceRefs: [],
    });
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].id).toBe('F2');
  });

  it('summary 缺失 → 默认占位串', () => {
    const raw = JSON.stringify({ findings: [], evidenceRefs: [] });
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.summary).toBe('(未提供摘要)');
  });

  it('finding 缺 id → 自动生成', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [{ severity: 'low', title: 't', location: 'l', description: 'd', evidenceRef: 'e' }],
      evidenceRefs: [],
    });
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.findings[0].id).toBeTruthy();
    expect(r.findings[0].id.length).toBeGreaterThan(0);
  });

  it('finding 缺 location → N/A', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [{ id: 'F1', severity: 'low', title: 't', description: 'd' }],
      evidenceRefs: [],
    });
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.findings[0].location).toBe('N/A');
  });

  it('evidenceRefs 非字符串元素被过滤', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [],
      evidenceRefs: ['a.ts', 42, null, 'b.ts'],
    });
    const r = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.evidenceRefs).toEqual(['a.ts', 'b.ts']);
  });

  it('解析后报告字段只读（readonly 契约）', () => {
    const raw = JSON.stringify({ summary: 's', findings: [], evidenceRefs: [] });
    const r: SubBotReport = parseSubBotReport(raw, 'S1', 'security', TP);
    expect(r.slotId).toBe('S1');
    // TS readonly 在编译期检查，运行时只是断言结构正确
    expect(Array.isArray(r.findings)).toBe(true);
    expect(Array.isArray(r.evidenceRefs)).toBe(true);
  });
});
