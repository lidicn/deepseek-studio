/**
 * strategy-generator 单测（v0.29 · Claude 主开发）
 *
 * 不依赖真模型 —— mock registry/onAgentEvent，构造 assistant 文本与 loop.send 行为，
 * 覆盖：正常 JSON、带 markdown 围栏、前后多余文字、非法 JSON、字段越界钳制、
 * bot 不可用兜底、超时兜底、空主题。
 */
import { describe, it, expect, vi } from 'vitest';
import { createStrategyGenerator } from '../../src/host/bot/strategy-generator';
import type { AgentLoopEvent } from '../../src/host/agent-loop';
import type { BotRegistryInternal, BotInternalState } from '../../src/host/bot/registry';
import { SessionAllowlist } from '../../src/host/bot/registry';
import type { RoomConfig } from '../../src/host/bot/types';

const ROOM: RoomConfig = {
  roomId: 'r1',
  roomName: '架构讨论',
  memberPersonas: ['frontend-expert', 'backend-expert'],
};

function mockBot(registrySend: (msg: string) => Promise<void>) {
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
    sessionAllowlist: new SessionAllowlist(),
  };
  const registry = {
    get: vi.fn(() => ({ id: 'main', loop: { send: registrySend }, engine: {} })),
    getState: vi.fn(() => state),
  } as unknown as BotRegistryInternal;
  return { registry, onAgentEvent, emit, state };
}

describe('createStrategyGenerator', () => {
  it('解析合法 JSON 输出为 MeetingStrategy', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '{"focusTopics":["接口契约","错误码"],"minRoundsBeforeAutoSummary":3,"summaryStyle":"分议题罗列"}' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('后端接口契约', ROOM);
    expect(s.focusTopics).toEqual(['接口契约', '错误码']);
    expect(s.minRoundsBeforeAutoSummary).toBe(3);
    expect(s.summaryStyle).toBe('分议题罗列');
  });

  it('剥离 markdown 代码围栏', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '```json\n{"focusTopics":["A"],"minRoundsBeforeAutoSummary":2}\n```' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('x', ROOM);
    expect(s.focusTopics).toEqual(['A']);
    expect(s.minRoundsBeforeAutoSummary).toBe(2);
  });

  it('前后多余文字仍能定位 JSON 子串', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '好的，这是策略：\n{"focusTopics":["A"],"minRoundsBeforeAutoSummary":4}\n以上请参考。' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('x', ROOM);
    expect(s.focusTopics).toEqual(['A']);
    expect(s.minRoundsBeforeAutoSummary).toBe(4);
  });

  it('非法 JSON → 兜底策略（保留主题）', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '这不是JSON{focusTopics:}' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('后端契约', ROOM);
    expect(s.focusTopics).toEqual(['后端契约']);
    expect(s.minRoundsBeforeAutoSummary).toBe(3);
  });

  it('minRoundsBeforeAutoSummary 越界被钳到 [1,20]', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '{"focusTopics":["A"],"minRoundsBeforeAutoSummary":99}' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('x', ROOM);
    expect(s.minRoundsBeforeAutoSummary).toBe(20);
  });

  it('focusTopics 缺失时回退到会议主题', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '{"minRoundsBeforeAutoSummary":5}' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('唯一主题', ROOM);
    expect(s.focusTopics).toEqual(['唯一主题']);
    expect(s.minRoundsBeforeAutoSummary).toBe(5);
  });

  it('bot 不可用 → 兜底策略', async () => {
    const onAgentEvent = vi.fn();
    const registry = { get: vi.fn(() => undefined), getState: vi.fn() } as unknown as BotRegistryInternal;
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('主题', ROOM);
    expect(s.focusTopics).toEqual(['主题']);
    expect(s.minRoundsBeforeAutoSummary).toBe(3);
  });

  it('空 assistant 文本 → 兜底策略', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('主题', ROOM);
    expect(s.focusTopics).toEqual(['主题']);
  });

  it('超时 → 兜底策略（loop.send 不 resolve）', async () => {
    const { registry, onAgentEvent } = mockBot(() => new Promise<void>(() => {})); // 永不 resolve
    const gen = createStrategyGenerator({ registry, onAgentEvent, timeoutMs: 50 });
    const s = await gen('超时主题', ROOM);
    expect(s.focusTopics).toEqual(['超时主题']);
    expect(s.minRoundsBeforeAutoSummary).toBe(3);
  });

  it('空主题 + 合法策略 → 空 topics 可接受', async () => {
    const { registry, onAgentEvent, emit } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '{"focusTopics":[],"minRoundsBeforeAutoSummary":2}' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    const s = await gen('', ROOM);
    expect(s.focusTopics).toEqual([]);
    expect(s.minRoundsBeforeAutoSummary).toBe(2);
  });

  it('放行 chat-insert/chat-send sessionAllowlist', async () => {
    const { registry, onAgentEvent, emit, state } = mockBot(async () => {
      emit({ botId: 'main', type: 'assistant', text: '{"focusTopics":["A"],"minRoundsBeforeAutoSummary":1}' } as AgentLoopEvent);
    });
    const gen = createStrategyGenerator({ registry, onAgentEvent });
    await gen('x', ROOM);
    expect(state.sessionAllowlist.has('chat-insert')).toBe(true);
    expect(state.sessionAllowlist.has('chat-send')).toBe(true);
  });
});
