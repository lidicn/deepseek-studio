import { describe, expect, it } from 'vitest';

import { createHarnessMetrics } from '../../src/shared/harness-metrics';
import type { HarnessMetricsSnapshot } from '../../src/shared/harness-metrics';
import { createToolEventBus } from '../../src/shared/tool-event-bus';
import type { ToolEventInput } from '../../src/shared/tool-event-bus';
import type { AgentLoopEvent } from '../../src/host/agent-loop';

// ---------------------------------------------------------------- helpers

function makeInput(over: Partial<ToolEventInput> = {}): ToolEventInput {
  return {
    toolName: over.toolName ?? 'shell.exec',
    params: over.params ?? { cmd: 'ls' },
    ...over,
  };
}

function ev(type: AgentLoopEvent['type'], extra: Partial<AgentLoopEvent> = {}): AgentLoopEvent {
  return { type, ...extra };
}

/** 跑一个完整的「用户消息 → 工具 → 最终回答」回合。 */
function runNormalRound(m: ReturnType<typeof createHarnessMetrics>, toolCalls = 1): void {
  m.onEvent(ev('user', { text: '读一下文件' }));
  m.onEvent(ev('status', { text: '已发送，等待模型回复…', step: 1 }));
  m.onEvent(ev('tool', { text: `工具执行完成（${toolCalls} 次调用）`, step: 1, toolCalls }));
  m.onEvent(ev('assistant', { text: '文件内容如下…', step: 2 }));
  m.onEvent(ev('done'));
}

// ---------------------------------------------------------------- tests

describe('harness-metrics · 工具回合埋点', () => {
  it('正常工具回合：计一个工具回合，不计 nudge', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);
    bus.emit('after-call', makeInput({ result: { ok: true }, durationMs: 3 }));

    runNormalRound(m, 1);

    const s = m.snapshot();
    expect(s.toolRounds).toBe(1);
    expect(s.nudgeRounds).toBe(0);
    expect(s.nudgeRate).toBe(0);
    expect(s.noNudgeCompletionRate).toBe(1);
    expect(s.successCount).toBe(1);
    m.dispose();
  });

  it('一个 tool 事件带多次工具调用：只算一个回合（不按调用次数拆）', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);
    // bus 侧 3 次调用结局
    bus.emit('after-call', makeInput({ toolName: 'a', result: { ok: true } }));
    bus.emit('after-call', makeInput({ toolName: 'b', result: { ok: true } }));
    bus.emit('after-call', makeInput({ toolName: 'c', result: { ok: true } }));

    runNormalRound(m, 3);

    const s = m.snapshot();
    // 回合计数按 loop 的 tool 事件，不按 bus 调用次数
    expect(s.toolRounds).toBe(1);
    expect(s.nudgeRounds).toBe(0);
    // bus 侧仍如实记录 3 次调用结局
    expect(s.toolCallsTotal).toBe(3);
    expect(s.successCount).toBe(3);
    m.dispose();
  });

  it('无工具回合（纯问答）：不计入分母，nudgeRate=0，完成率=1', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);

    m.onEvent(ev('user', { text: '你好' }));
    m.onEvent(ev('status', { text: '已发送，等待模型回复…', step: 1 }));
    m.onEvent(ev('assistant', { text: '你好！有什么可以帮你？', step: 1 }));
    m.onEvent(ev('done'));

    const s = m.snapshot();
    expect(s.toolRounds).toBe(0);
    expect(s.nudgeRounds).toBe(0);
    expect(s.nudgeRate).toBe(0);
    expect(s.noNudgeCompletionRate).toBe(1);
    m.dispose();
  });

  it('snapshot 形状稳定：键集合固定、可 JSON 序列化', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);
    bus.emit('after-call', makeInput({ result: { ok: true } }));
    runNormalRound(m, 1);

    const s = m.snapshot();
    expect(Object.keys(s).sort()).toEqual(
      [
        'failureCount',
        'nudgeRate',
        'nudgeRounds',
        'noNudgeCompletionRate',
        'skipCount',
        'successCount',
        'toolCallsTotal',
        'toolRounds',
      ].sort(),
    );
    // 往返序列化无损
    const restored: HarnessMetricsSnapshot = JSON.parse(JSON.stringify(s));
    expect(restored).toEqual(s);
    m.dispose();
  });

  it('bus 事件与 loop 事件正确关联：成功/失败/跳过分桶，total=三者之和', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);

    bus.emit('after-call', makeInput({ result: { ok: true }, durationMs: 2 }));
    bus.emit('after-call', makeInput({ toolName: 'b', result: { ok: true }, durationMs: 5 }));
    bus.emit('call-error', makeInput({ toolName: 'c', error: new Error('boom'), reason: 'throw' }));
    bus.emit('call-skip', makeInput({ toolName: 'd', reason: 'before-hook-deny' }));

    runNormalRound(m, 1);

    const s = m.snapshot();
    expect(s.successCount).toBe(2);
    expect(s.failureCount).toBe(1);
    expect(s.skipCount).toBe(1);
    expect(s.toolCallsTotal).toBe(4);
    m.dispose();
  });

  it('工具回合后出现「格式纠偏」status：该回合计为需 nudge', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);

    m.onEvent(ev('user', { text: '改一下配置' }));
    m.onEvent(ev('tool', { text: '工具执行完成（1 次调用）', step: 1, toolCalls: 1 }));
    m.onEvent(ev('status', { text: '工具结果已回填，等待页端续跑…', step: 2 }));
    m.onEvent(ev('status', { text: '检测到未解析的工具调用，发送格式纠偏（第 1 次）…', step: 2 }));
    m.onEvent(ev('assistant', { text: '已改好', step: 3 }));
    m.onEvent(ev('done'));

    const s = m.snapshot();
    expect(s.toolRounds).toBe(1);
    expect(s.nudgeRounds).toBe(1);
    expect(s.nudgeRate).toBe(1);
    expect(s.noNudgeCompletionRate).toBe(0);
    m.dispose();
  });

  it('同一回合连续多次纠偏：只计一次 nudge（防 MAX_CORRECTION_ATTEMPTS 重复计数）', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);

    m.onEvent(ev('user', { text: '任务' }));
    m.onEvent(ev('tool', { text: '工具执行完成（1 次调用）', step: 1, toolCalls: 1 }));
    m.onEvent(ev('status', { text: '检测到未解析的工具调用，发送格式纠偏（第 1 次）…', step: 2 }));
    m.onEvent(ev('status', { text: '检测到未解析的工具调用，发送格式纠偏（第 2 次）…', step: 2 }));
    m.onEvent(ev('status', { text: '检测到未解析的工具调用，发送格式纠偏（第 3 次）…', step: 2 }));
    m.onEvent(ev('assistant', { text: '完成', step: 3 }));
    m.onEvent(ev('done'));

    const s = m.snapshot();
    expect(s.toolRounds).toBe(1);
    expect(s.nudgeRounds).toBe(1);
    m.dispose();
  });

  it('多步工具链：tool → tool → assistant，两个回合都不计 nudge', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);

    m.onEvent(ev('user', { text: '先读再写' }));
    m.onEvent(ev('tool', { text: '工具执行完成（1 次调用）', step: 1, toolCalls: 1 }));
    m.onEvent(ev('tool', { text: '工具执行完成（1 次调用）', step: 2, toolCalls: 1 }));
    m.onEvent(ev('assistant', { text: '读完已写', step: 3 }));
    m.onEvent(ev('done'));

    const s = m.snapshot();
    expect(s.toolRounds).toBe(2);
    expect(s.nudgeRounds).toBe(0);
    expect(s.nudgeRate).toBe(0);
    m.dispose();
  });

  it('error 事件关闭打开的回合，不计 nudge', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);

    m.onEvent(ev('user', { text: '任务' }));
    m.onEvent(ev('tool', { text: '工具执行完成（1 次调用）', step: 1, toolCalls: 1 }));
    m.onEvent(ev('error', { text: '全局看门狗触发', step: 2 }));
    m.onEvent(ev('done'));

    const s = m.snapshot();
    expect(s.toolRounds).toBe(1);
    expect(s.nudgeRounds).toBe(0);
    m.dispose();
  });

  it('onEvent 包装后仍转发原始面板回调（顺序与形状不变）', () => {
    const bus = createToolEventBus();
    const forwarded: AgentLoopEvent[] = [];
    const m = createHarnessMetrics(bus, (e) => forwarded.push(e));

    runNormalRound(m, 1);

    expect(forwarded).toHaveLength(5);
    expect(forwarded[0].type).toBe('user');
    expect(forwarded[3].type).toBe('assistant');
    // 转发的事件形状与入参一致（含 toolCalls）
    expect(forwarded[2]).toMatchObject({ type: 'tool', toolCalls: 1 });
    m.dispose();
  });

  it('dispose 后退订 bus：后续 emit 不再改变计数', () => {
    const bus = createToolEventBus();
    const m = createHarnessMetrics(bus);
    bus.emit('after-call', makeInput({ result: { ok: true } }));
    expect(m.snapshot().successCount).toBe(1);

    m.dispose();
    bus.emit('after-call', makeInput({ result: { ok: true } }));
    bus.emit('call-error', makeInput({ error: new Error('x') }));

    const s = m.snapshot();
    expect(s.successCount).toBe(1);
    expect(s.failureCount).toBe(0);
    expect(s.toolCallsTotal).toBe(1);
  });
});
