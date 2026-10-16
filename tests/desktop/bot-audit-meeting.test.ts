/**
 * audit-meeting 单测（v0.30 · Claude 主开发）
 *
 * 覆盖：detectAuditCommand 多形态（/审计、@main 审计、显式维度、默认维度、中英文逗号/顿号、
 * 无 target 不触发）；dispatch → Promise.allSettled → readSubReports → mergeReports →
 * writeMergedReport → report-ready（用 InMemoryReportStore + 假 scheduler）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectAuditCommand,
  createAuditDispatcher,
  DEFAULT_AUDIT_DIMENSIONS,
} from '../../src/host/bot/audit-meeting';
import { InMemoryReportStore } from '../../src/host/bot/in-memory-report-store';
import type { Scheduler } from '../../src/host/bot/scheduler';
import type { RunHandle } from '../../src/host/bot/scheduler';
import type { Persona, SubBotReport } from '../../src/host/bot/types';

function mkHandle(slotId: string, dimension: string, batchId: string): RunHandle {
  const persona: Persona = { name: 'audit-expert', prompt: 'p', tools: [], memoryDir: '' };
  return {
    runId: `run-${slotId}`,
    slotId,
    persona,
    task: { dimension, target: 'E:/test', batchId, roomId: 'r1', text: 'prompt' },
    startedAt: Date.now(),
  };
}

describe('detectAuditCommand', () => {
  it('/审计 <target> → 默认维度', () => {
    const cmd = detectAuditCommand('/审计 E:/NAS/AutoForge');
    expect(cmd.kind).toBe('audit');
    expect(cmd.target).toBe('E:/NAS/AutoForge');
    expect(cmd.dimensions).toEqual(DEFAULT_AUDIT_DIMENSIONS);
  });

  it('@main 审计 <target> → 默认维度', () => {
    const cmd = detectAuditCommand('@main 审计 src/db.ts');
    expect(cmd.kind).toBe('audit');
    expect(cmd.target).toBe('src/db.ts');
    expect(cmd.dimensions).toEqual(DEFAULT_AUDIT_DIMENSIONS);
  });

  it('@main 审计 + 显式维度（英文逗号）', () => {
    const cmd = detectAuditCommand('@main 审计 E:/x 维度 security,performance');
    expect(cmd.kind).toBe('audit');
    expect(cmd.target).toBe('E:/x');
    expect(cmd.dimensions).toEqual(['security', 'performance']);
  });

  it('@main 审计 + 显式维度（中文逗号）', () => {
    const cmd = detectAuditCommand('@main 审计 E:/x 维度 并发安全，内存泄漏，越权风险');
    expect(cmd.kind).toBe('audit');
    expect(cmd.target).toBe('E:/x');
    expect(cmd.dimensions).toEqual(['并发安全', '内存泄漏', '越权风险']);
  });

  it('@main 审计 + 显式维度（顿号）', () => {
    const cmd = detectAuditCommand('@main 审计 E:/x 维度 a、b、c');
    expect(cmd.kind).toBe('audit');
    expect(cmd.dimensions).toEqual(['a', 'b', 'c']);
  });

  it('维度标记用 dim 也识别', () => {
    const cmd = detectAuditCommand('@main 审计 E:/x dim security');
    expect(cmd.kind).toBe('audit');
    expect(cmd.dimensions).toEqual(['security']);
  });

  it('无 target → 不触发', () => {
    const cmd = detectAuditCommand('@main 审计');
    expect(cmd.kind).toBe('none');
  });

  it('普通消息 → 不触发', () => {
    expect(detectAuditCommand('@frontend 接口返回结构').kind).toBe('none');
    expect(detectAuditCommand('审计一下这个设计').kind).toBe('none'); // 句中不算
  });

  it('空输入 → none', () => {
    expect(detectAuditCommand('').kind).toBe('none');
    expect(detectAuditCommand('   ').kind).toBe('none');
  });

  it('维度全空 → 回退默认维度', () => {
    const cmd = detectAuditCommand('@main 审计 E:/x 维度 ,,,');
    expect(cmd.kind).toBe('audit');
    expect(cmd.dimensions).toEqual(DEFAULT_AUDIT_DIMENSIONS);
  });

  it('大小写不敏感', () => {
    const cmd = detectAuditCommand('/AUDIT E:/x');
    expect(cmd.kind).toBe('audit');
  });
});

describe('createAuditDispatcher', () => {
  it('dispatch → N 维度 assign → merge → report-ready', async () => {
    const reportStore = new InMemoryReportStore();
    const assigned: string[] = [];
    // 假 scheduler：assign 调 runner 不跑（runner 由 Scheduler 内部调，这里直接跳过），
    // 只记录维度 + 直接写一个 SubBotReport 进 reportStore 模拟 runner 副作用。
    const fakeScheduler = {
      idleSlots: vi.fn(() => [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }]),
      assign: vi.fn(async (opts: { persona: string; task: { dimension: string; batchId: string } }) => {
        assigned.push(opts.task.dimension);
        // 模拟 runner 副作用：写一份报告
        const report: SubBotReport = {
          slotId: opts.task.dimension,
          dimension: opts.task.dimension,
          summary: `${opts.task.dimension} 摘要`,
          findings: [{ id: 'F1', severity: 'high', title: 't', location: 'l', description: 'd', evidenceRef: 'e' }],
          evidenceRefs: ['e'],
          transcriptPath: `runs/${opts.task.batchId}/${opts.task.dimension}.jsonl`,
        };
        reportStore.writeSubReport(opts.task.batchId, opts.task.dimension, report);
        return mkHandle(opts.task.dimension, opts.task.dimension, opts.task.batchId);
      }),
    } as unknown as Scheduler;

    const reportReadySink = vi.fn();
    const dispatcher = createAuditDispatcher({
      scheduler: fakeScheduler,
      reportStore,
      onReportReady: reportReadySink,
    });

    await dispatcher.dispatch('r1', 'batch-1', 'E:/target', ['security', 'performance']);

    expect(assigned).toEqual(['security', 'performance']);
    expect(reportStore.readSubReports('batch-1')).toHaveLength(2);
    expect(reportStore.getMergedReportPath('batch-1')).toBeTruthy();
    expect(reportReadySink).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'report-ready',
        roomId: 'r1',
        batchId: 'batch-1',
        subReports: expect.arrayContaining([
          expect.objectContaining({ dimension: 'security', findingCount: 1 }),
          expect.objectContaining({ dimension: 'performance', findingCount: 1 }),
        ]),
      }),
    );
  });

  it('某维度 assign 抛错 → allSettled 吞 → 仍汇总 + report-ready', async () => {
    const reportStore = new InMemoryReportStore();
    const fakeScheduler = {
      idleSlots: vi.fn(() => [{ id: 'S1' }, { id: 'S2' }]),
      assign: vi.fn(async (opts: { task: { dimension: string; batchId: string } }) => {
        if (opts.task.dimension === 'performance') throw new Error('slot busy');
        const report: SubBotReport = {
          slotId: opts.task.dimension,
          dimension: opts.task.dimension,
          summary: 'ok',
          findings: [],
          evidenceRefs: [],
          transcriptPath: `runs/${opts.task.batchId}/${opts.task.dimension}.jsonl`,
        };
        reportStore.writeSubReport(opts.task.batchId, opts.task.dimension, report);
        return mkHandle(opts.task.dimension, opts.task.dimension, opts.task.batchId);
      }),
    } as unknown as Scheduler;

    const reportReadySink = vi.fn();
    const dispatcher = createAuditDispatcher({
      scheduler: fakeScheduler,
      reportStore,
      onReportReady: reportReadySink,
    });

    // 不应抛——allSettled 吞
    await dispatcher.dispatch('r1', 'batch-2', 'E:/t', ['security', 'performance']);

    expect(reportReadySink).toHaveBeenCalled();
    const ev = reportReadySink.mock.calls[0][0];
    expect(ev.subReports).toHaveLength(1); // 只有 security 写了报告
    expect(ev.subReports[0].dimension).toBe('security');
  });

  it('writeMergedReport 落盘 + getMergedReportPath 一致', async () => {
    const reportStore = new InMemoryReportStore();
    const fakeScheduler = {
      idleSlots: vi.fn(() => [{ id: 'S1' }]),
      assign: vi.fn(async (opts: { task: { dimension: string; batchId: string } }) => {
        const report: SubBotReport = {
          slotId: opts.task.dimension,
          dimension: opts.task.dimension,
          summary: 'ok',
          findings: [],
          evidenceRefs: [],
          transcriptPath: `runs/${opts.task.batchId}/${opts.task.dimension}.jsonl`,
        };
        reportStore.writeSubReport(opts.task.batchId, opts.task.dimension, report);
        return mkHandle(opts.task.dimension, opts.task.dimension, opts.task.batchId);
      }),
    } as unknown as Scheduler;

    const dispatcher = createAuditDispatcher({ scheduler: fakeScheduler, reportStore });
    await dispatcher.dispatch('r1', 'batch-3', 'E:/t', ['security']);
    expect(reportStore.getMergedReportPath('batch-3')).toBeTruthy();
  });
});
