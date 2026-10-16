/**
 * offline-runner 单测（v0.30 · Claude 主开发）
 *
 * 覆盖：scripted slotRuntime.run → assistant 回 JSON → 解析 → 写 reportStore；
 * jsonl 含全量事件按序；unloadPersona 被调 spy 验证；超时 task-complete ok=false；
 * 失败仍写降级报告 + 推 ok=false 事件 + 仍 unloadPersona。
 *
 * 不依赖真模型——mock registry/onAgentEvent/slotRuntime/reportStore。
 */
import { describe, it, expect, vi } from 'vitest';
import { createOfflineRunExecutor } from '../../src/host/bot/offline-runner';
import { InMemoryReportStore } from '../../src/host/bot/in-memory-report-store';
import type { AgentLoopEvent } from '../../src/host/agent-loop';
import type { BotRegistryInternal, BotInternalState } from '../../src/host/bot/registry';
import type { SlotRuntime } from '../../src/host/bot/slot-runtime';
import type { RunHandle } from '../../src/host/bot/scheduler';
import type { Persona } from '../../src/host/bot/types';

function makePersona(name: string): Persona {
  return { name, prompt: `人设:${name}`, tools: [], memoryDir: '' };
}

function mkHandle(slotId: string, dimension: string, batchId: string, text: string): RunHandle {
  return {
    runId: `run-${slotId}`,
    slotId,
    persona: makePersona('audit-expert'),
    task: { dimension, target: 'E:/test', batchId, roomId: 'r1', text },
    startedAt: Date.now(),
  };
}

function mockDeps(runImpl: (handle: RunHandle) => Promise<unknown>) {
  const listeners = new Set<(e: AgentLoopEvent) => void>();
  const onAgentEvent = (cb: (e: AgentLoopEvent) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const emit = (e: AgentLoopEvent) => {
    for (const l of listeners) l(e);
  };
  const state: BotInternalState = {
    toolCallCounter: { current: 0 },
    stopFlag: { stopped: false },
    lastAutoReply: { text: '' } as never,
    sessionAllowlist: new Set<string>(),
  };
  const registry = {
    get: vi.fn(() => ({ id: 'S1', loop: { send: vi.fn() }, engine: {} })),
    getState: vi.fn(() => state),
  } as unknown as BotRegistryInternal;
  const slotRuntime: SlotRuntime = {
    loadPersona: vi.fn(async (_id: string, _name: string) => makePersona('audit-expert')),
    unloadPersona: vi.fn(async (_id: string) => {}),
    loaded: vi.fn(() => undefined),
    executorFor: vi.fn(() => undefined),
    run: vi.fn(runImpl),
    renderPersonaBlock: vi.fn(() => ''),
    renderTaskText: vi.fn(() => ''),
  };
  const reportStore = new InMemoryReportStore();
  const progressSink = vi.fn();
  const completeSink = vi.fn();
  const executor = createOfflineRunExecutor({
    registry,
    slotRuntime,
    onAgentEvent,
    reportStore,
    timeoutMs: 3000,
    onTaskProgress: progressSink,
    onTaskComplete: completeSink,
  });
  return { executor, emit, reportStore, slotRuntime, progressSink, completeSink, state };
}

describe('createOfflineRunExecutor', () => {
  it('scripted run → assistant JSON → 解析 → 写 reportStore + 推 ok=true', async () => {
    const jsonOut = JSON.stringify({
      summary: '发现 1 个问题',
      findings: [{ id: 'F1', severity: 'high', title: 'SQL注入', location: 'db.ts:42', description: '拼接', evidenceRef: 'db.ts:42' }],
      evidenceRefs: ['db.ts:42'],
    });
    const { executor, emit, reportStore, completeSink, slotRuntime } = mockDeps(async () => {
      // 模拟 run 发出 assistant 事件
      emit({ botId: 'S1', type: 'assistant', text: jsonOut } as AgentLoopEvent);
    });
    const handle = mkHandle('S1', 'security', 'batch-1', '审计prompt');

    await executor(handle);

    const report = reportStore.getSubReport('batch-1', 'S1');
    expect(report).toBeTruthy();
    expect(report!.summary).toBe('发现 1 个问题');
    expect(report!.findings).toHaveLength(1);
    expect(report!.findings[0].severity).toBe('high');
    expect(completeSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-complete', ok: true, findingCount: 1 }),
    );
    expect(slotRuntime.unloadPersona).toHaveBeenCalledWith('S1');
  });

  it('jsonl 含全量事件按序', async () => {
    const { executor, emit, reportStore } = mockDeps(async () => {
      emit({ botId: 'S1', type: 'status', text: 'thinking' } as AgentLoopEvent);
      emit({ botId: 'S1', type: 'tool', text: 'file.read' } as AgentLoopEvent);
      emit({ botId: 'S1', type: 'assistant', text: '{"summary":"s","findings":[]}' } as AgentLoopEvent);
    });
    const handle = mkHandle('S1', 'security', 'batch-2', 'prompt');
    await executor(handle);

    const transcript = reportStore.getTranscript('batch-2', 'S1');
    expect(transcript).toHaveLength(3);
    expect((transcript[0] as AgentLoopEvent).type).toBe('status');
    expect((transcript[1] as AgentLoopEvent).type).toBe('tool');
    expect((transcript[2] as AgentLoopEvent).type).toBe('assistant');
  });

  it('无 assistant 文本（run 正常 resolve 但零产出）→ 判失败 + 仍 unloadPersona', async () => {
    const { executor, slotRuntime, completeSink } = mockDeps(async () => {
      // run resolve 但无任何 assistant 事件——AgentLoop 吞了引擎异常时的真实形态
      // （agent-loop.ts:197 只 emit error 不 rethrow），必须判失败而非 ok=true。
    });
    const handle = mkHandle('S1', 'security', 'batch-3', 'prompt');
    await expect(executor(handle)).rejects.toThrow('assistant');
    expect(completeSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-complete', ok: false }),
    );
    expect(slotRuntime.unloadPersona).toHaveBeenCalledWith('S1');
  });

  it('引擎异常被 AgentLoop 吞 → 用 error 事件文本作失败原因', async () => {
    const { executor, emit, completeSink, reportStore } = mockDeps(async () => {
      emit({ botId: 'S1', type: 'error', text: 'engine down' } as AgentLoopEvent);
      // 无 assistant 事件——AgentLoop 的 catch 分支形态
    });
    const handle = mkHandle('S1', 'security', 'batch-swallow', 'prompt');
    await expect(executor(handle)).rejects.toThrow('engine down');
    expect(completeSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-complete', ok: false, error: 'engine down' }),
    );
    // 降级报告带上失败原因（不是空串）
    const report = reportStore.getSubReport('batch-swallow', 'S1');
    expect(report!.findings[0].description).toContain('engine down');
  });

  it('槽无窗口 → 即时失败（不空转到超时），原因写明无窗口', async () => {
    const { executor, completeSink, progressSink, slotRuntime } = mockDeps(async () => {
      // 不该走到这里——预检在 slotRuntime.run 之前就抛
    });
    const guarded = createOfflineRunExecutor({
      registry: {
        get: vi.fn(() => ({ id: 'S1', loop: { send: vi.fn() }, engine: {} })),
        getState: vi.fn(() => ({
          toolCallCounter: { current: 0 },
          stopFlag: { stopped: false },
          lastAutoReply: { text: '' } as never,
          sessionAllowlist: new Set<string>(),
        })),
      } as unknown as BotRegistryInternal,
      slotRuntime: (slotRuntime as unknown) as SlotRuntime,
      onAgentEvent: () => () => {},
      reportStore: new InMemoryReportStore(),
      hasWindowFor: () => false,
      onTaskProgress: progressSink,
      onTaskComplete: completeSink,
    });
    const handle = mkHandle('S1', 'security', 'batch-nowin', 'prompt');

    await expect(guarded(handle)).rejects.toThrow('无可用窗口');
    expect(slotRuntime.run).not.toHaveBeenCalled();      // 没白跑 120s
    expect(completeSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-complete', ok: false, error: expect.stringContaining('无可用窗口') }),
    );
    expect(progressSink).toHaveBeenCalled();            // running 先推，生命周期完整
    expect(executor).toBeTruthy();
  });

  it('模型输出非结构化（真机"原始工具标签"形态）→ 报告落盘但 ok=false', async () => {
    const { executor, emit, completeSink, reportStore } = mockDeps(async () => {
      // 真机抓到：模型末尾吐未被页端拦截器解析的原始工具标签
      emit({ botId: 'S1', type: 'assistant', text: '<shell_exec>{"command":"echo x"}</shell_exec>' } as AgentLoopEvent);
    });
    const handle = mkHandle('S1', 'security', 'batch-degraded', 'prompt');
    await executor(handle);

    // 报告仍落盘（不丢原始输出）
    const report = reportStore.getSubReport('batch-degraded', 'S1');
    expect(report).toBeTruthy();
    expect(report!.findings[0].description).toContain('shell_exec');
    // 但 ok=false —— 不能把"降级"当成"审计完成、无问题"
    expect(completeSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-complete', ok: false, error: expect.stringContaining('结构化 JSON') }),
    );
  });

  it('超时 → task-complete ok=false + 仍 unloadPersona', async () => {
    const { completeSink } = mockDeps(() => new Promise(() => {})); // 永不 resolve
    const executorWithShortTimeout = createOfflineRunExecutor({
      registry: {
        get: vi.fn(() => ({ id: 'S1', loop: { send: vi.fn() }, engine: {} })),
        getState: vi.fn(() => ({
          toolCallCounter: { current: 0 },
          stopFlag: { stopped: false },
          lastAutoReply: { text: '' } as never,
          sessionAllowlist: new Set<string>(),
        })),
      } as unknown as BotRegistryInternal,
      slotRuntime: {
        loadPersona: vi.fn(async () => makePersona('audit-expert')),
        unloadPersona: vi.fn(async () => {}),
        loaded: vi.fn(() => undefined),
        executorFor: vi.fn(() => undefined),
        run: vi.fn(() => new Promise(() => {})),
        renderPersonaBlock: vi.fn(() => ''),
        renderTaskText: vi.fn(() => ''),
      },
      onAgentEvent: () => () => {},
      reportStore: new InMemoryReportStore(),
      timeoutMs: 50,
      onTaskComplete: completeSink,
    });
    const handle = mkHandle('S1', 'security', 'batch-to', 'prompt');

    await expect(executorWithShortTimeout(handle)).rejects.toThrow('timeout');
    expect(completeSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-complete', ok: false, error: expect.stringContaining('timeout') }),
    );
  });

  it('失败仍写降级报告 + 推 ok=false', async () => {
    const { executor, reportStore, completeSink } = mockDeps(async () => {
      throw new Error('engine crash');
    });
    const handle = mkHandle('S1', 'security', 'batch-err', 'prompt');

    await expect(executor(handle)).rejects.toThrow('engine crash');
    expect(completeSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-complete', ok: false, error: 'engine crash' }),
    );
    const report = reportStore.getSubReport('batch-err', 'S1');
    expect(report).toBeTruthy();
    expect(report!.findings).toHaveLength(1);
    expect(report!.findings[0].severity).toBe('medium');
  });

  it('推 task-progress running 事件', async () => {
    const { executor, emit, progressSink } = mockDeps(async () => {
      emit({ botId: 'S1', type: 'assistant', text: '{"summary":"s","findings":[]}' } as AgentLoopEvent);
    });
    const handle = mkHandle('S1', 'security', 'batch-prog', 'prompt');
    await executor(handle);
    expect(progressSink).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task-progress', status: 'running', slotId: 'S1', dimension: 'security' }),
    );
  });

  it('放行 chat-insert/chat-send sessionAllowlist', async () => {
    const { executor, emit, state } = mockDeps(async () => {
      emit({ botId: 'S1', type: 'assistant', text: '{"summary":"s","findings":[]}' } as AgentLoopEvent);
    });
    const handle = mkHandle('S1', 'security', 'batch-allow', 'prompt');
    await executor(handle);
    expect(state.sessionAllowlist.has('chat-insert')).toBe(true);
    expect(state.sessionAllowlist.has('chat-send')).toBe(true);
  });
});
