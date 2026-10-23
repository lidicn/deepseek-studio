// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  applyState,
  applySocketOpen,
  applySocketClose,
  applyLoopEvent,
  applyToolRun,
  canSend,
  canStop,
  shouldReconnect,
} from '../../src/ui/workbench/workbench-state';
import type { StatePayload } from '../../src/ui/workbench/workbench-types';

const statePayload = (over: Partial<StatePayload> = {}): StatePayload => ({
  type: 'state',
  policyMode: 'auto',
  panelModes: ['workspace', 'auto', 'full'],
  workspaceRoot: null,
  running: false,
  ...over,
});

describe('WorkbenchState · applyState', () => {
  it('更新后 connection/running/policy/workspace 正确', () => {
    let s = createInitialState();
    s = applySocketOpen(s);
    s = applyState(s, statePayload({ policyMode: 'full', running: true, workspaceRoot: 'E:/proj' }));
    expect(s.connection).toBe('connected');
    expect(s.running).toBe(true);
    expect(s.policyMode).toBe('full');
    expect(s.workspaceRoot).toBe('E:/proj');
  });
});

describe('WorkbenchState · 断线', () => {
  it('普通断线后 running=false，发送禁用', () => {
    let s = applySocketOpen(createInitialState());
    s = applyState(s, statePayload({ running: true }));
    expect(canSend(s)).toBe(false); // 运行中也禁发
    s = applySocketClose(s, 1006);
    expect(s.running).toBe(false);
    expect(s.connection).toBe('disconnected');
    expect(canSend(s)).toBe(false);
    expect(canStop(s)).toBe(false);
  });

  it('1008 鉴权失败不自动重连，running=false', () => {
    let s = applySocketOpen(createInitialState());
    s = applySocketClose(s, 1008);
    expect(s.connection).toBe('auth-failed');
    expect(shouldReconnect(1008)).toBe(false);
    expect(shouldReconnect(1006)).toBe(true);
    expect(s.running).toBe(false);
    expect(s.lastError).toBe('鉴权失败，请重启应用');
  });
});

describe('WorkbenchState · loop event', () => {
  it('done 把 running 置 false；error 写 lastError', () => {
    let s = applySocketOpen(createInitialState());
    s = applyState(s, statePayload({ running: true }));
    s = applyLoopEvent(s, { type: 'done' });
    expect(s.running).toBe(false);

    let e = applyState(applySocketOpen(createInitialState()), statePayload({ running: true }));
    e = applyLoopEvent(e, { type: 'error', text: 'boom' });
    expect(e.running).toBe(false);
    expect(e.lastError).toBe('boom');
  });

  it('聊天室与子 bot 事件不污染工作台主对话状态', () => {
    let s = applySocketOpen(createInitialState());
    s = applyState(s, statePayload({ running: true }));

    const roomEvent = applyLoopEvent(s, { type: 'done', roomId: 'room-a', botId: 'main' });
    expect(roomEvent).toBe(s);

    const subBotEvent = applyLoopEvent(s, { type: 'error', text: 'sub failed', botId: 'bot-a' });
    expect(subBotEvent).toBe(s);
    expect(subBotEvent.running).toBe(true);
    expect(subBotEvent.lastError).toBeNull();
  });

  it('记忆后端默认 sqlite，state 可显式切到 memory', () => {
    let s = createInitialState();
    expect(s.memoryBackend).toBe('sqlite');
    s = applyState(s, statePayload({ memoryBackend: 'memory' }));
    expect(s.memoryBackend).toBe('memory');
  });
});

describe('WorkbenchState · tool-run 终态去重', () => {
  it('同一 runId 终态不被后续进行中事件覆盖', () => {
    let s = createInitialState();
    s = applyToolRun(s, { type: 'tool-run', runId: 'r1', tool: 'shell_exec', phase: 'started' });
    s = applyToolRun(s, { type: 'tool-run', runId: 'r1', tool: 'shell_exec', phase: 'succeeded', durationMs: 120 });
    const before = s.toolRuns.find((r) => r.runId === 'r1');
    expect(before?.phase).toBe('succeeded');
    s = applyToolRun(s, { type: 'tool-run', runId: 'r1', tool: 'shell_exec', phase: 'started' });
    const after = s.toolRuns.find((r) => r.runId === 'r1');
    expect(after?.phase).toBe('succeeded');
    expect(after?.durationMs).toBe(120);
  });
});
