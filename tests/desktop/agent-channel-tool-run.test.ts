// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ToolRunEvent } from '../../src/shared/tool-run-event';
import { failPendingRunsOnDisconnect, extractArtifactPaths } from '../../src/host/desktop-host';

describe('ToolRunEvent 契约', () => {
  it('started → succeeded 流转', () => {
    const started: ToolRunEvent = { type: 'tool-run', runId: 'r1', tool: 'echo', phase: 'started' };
    expect(started.phase).toBe('started');
    const succeeded: ToolRunEvent = { type: 'tool-run', runId: 'r1', tool: 'echo', phase: 'succeeded', durationMs: 50 };
    expect(succeeded.phase).toBe('succeeded');
  });

  it('failed 事件带 errorCode', () => {
    const failed: ToolRunEvent = { type: 'tool-run', runId: 'r2', tool: 'shell', phase: 'failed', errorCode: 'exit-code-1' };
    expect(failed.phase).toBe('failed');
    expect(failed.errorCode).toBe('exit-code-1');
  });

  it('denied 事件', () => {
    const denied: ToolRunEvent = { type: 'tool-run', runId: 'r3', tool: 'write-file', phase: 'denied', errorCode: 'policy-denied' };
    expect(denied.phase).toBe('denied');
  });

  it('WS 消息形状 {type:"tool-run", event}', () => {
    const wsMsg = { type: 'tool-run', event: { type: 'tool-run', runId: 'r4', tool: 'read-file', phase: 'succeeded' } };
    expect(wsMsg.type).toBe('tool-run');
    expect(wsMsg.event.runId).toBe('r4');
  });

  it('dispose 后不再广播（模拟 unsubscribe）', () => {
    const broadcasts: ToolRunEvent[] = [];
    let unsubscribed = false;
    const cb = (e: ToolRunEvent) => { if (!unsubscribed) broadcasts.push(e); };
    cb({ type: 'tool-run', runId: 'r5', tool: 'echo', phase: 'started' });
    unsubscribed = true;
    cb({ type: 'tool-run', runId: 'r5', tool: 'echo', phase: 'succeeded' });
    expect(broadcasts).toHaveLength(1);
  });
});

describe('T5 pendingRuns 断线兜底', () => {
  const makePending = () =>
    new Map<string, { tool: string; botId: string; startedAt: number }>([
      ['run-1', { tool: 'shell.exec', botId: 'main', startedAt: Date.now() - 120 }],
      ['run-2', { tool: 'file.read', botId: 'bot-a', startedAt: Date.now() - 60 }],
    ]);

  it('断开后每个未完成 runId 收到 phase=failed / errorCode=page-disconnected', () => {
    const pending = makePending();
    const events: ToolRunEvent[] = [];
    failPendingRunsOnDisconnect(pending, (e) => events.push(e));
    expect(events).toHaveLength(2);
    const byId = new Map(events.map((e) => [e.runId, e]));
    const r1 = byId.get('run-1');
    expect(r1?.phase).toBe('failed');
    expect(r1?.errorCode).toBe('page-disconnected');
    expect(r1?.tool).toBe('shell.exec');
    expect(r1?.botId).toBe('main');
    const r2 = byId.get('run-2');
    expect(r2?.phase).toBe('failed');
    expect(r2?.errorCode).toBe('page-disconnected');
    expect(r2?.botId).toBe('bot-a');
  });

  it('断开后 pendingRuns 被清空', () => {
    const pending = makePending();
    expect(pending.size).toBe(2);
    failPendingRunsOnDisconnect(pending, () => {});
    expect(pending.size).toBe(0);
  });
});

describe('X2 artifactPaths 数据源', () => {
  it('file.edit 成功且 details.path 为真实路径 → artifactPaths=[该路径]', () => {
    const paths = extractArtifactPaths('file.edit', {
      path: 'src/host/authority.ts',
      replacements: 2,
      bytesBefore: 120,
      bytesAfter: 132,
      sha256Before: 'a',
      sha256After: 'b',
    });
    expect(paths).toEqual(['src/host/authority.ts']);
  });

  it('shell 成功（无产物 details.path）→ artifactPaths 为 undefined', () => {
    expect(extractArtifactPaths('shell', { exitCode: 0, cwd: '/tmp', argv: ['ls'] })).toBeUndefined();
  });

  it('file.edit 但 details.path 缺失/空白 → artifactPaths 为 undefined（不猜）', () => {
    expect(extractArtifactPaths('file.edit', { replacements: 0 })).toBeUndefined();
    expect(extractArtifactPaths('file.edit', { path: '   ' })).toBeUndefined();
    expect(extractArtifactPaths('file.edit')).toBeUndefined();
  });
});
