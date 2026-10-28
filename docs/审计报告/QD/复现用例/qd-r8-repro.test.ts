// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  renderExecutionIndex,
  renderExecutionSession,
} from '../../src/ui/workbench/workbench-execution-view';
import {
  createEmptyStudioExecutionSession,
  type StudioExecutionIndex,
  type StudioExecutionSession,
} from '../../src/shared/studio-execution';
import { createStudioTraceCollector } from '../../src/shared/studio-trace';

function shells(): { canvas: HTMLElement; inspector: HTMLElement; drawer: HTMLElement } {
  const canvas = document.createElement('section');
  const inspector = document.createElement('aside');
  const drawer = document.createElement('aside');
  document.body.append(canvas, inspector, drawer);
  return { canvas, inspector, drawer };
}

function baseSession(): StudioExecutionSession {
  const s = createEmptyStudioExecutionSession('chat:one', 10);
  s.events = [
    { type: 'user-message', at: 10, turnId: 't1', text: '查看目录' },
    { type: 'tool-start', at: 20, turnId: 't1', callId: 'c1', toolName: 'shell_exec', params: { command: 'ls' } },
    { type: 'tool-result', at: 30, turnId: 't1', callId: 'c1', toolName: 'shell_exec', ok: true, durationMs: 12, result: { stdout: 'a' } },
    { type: 'final-answer', at: 40, turnId: 't1', text: '完成' },
  ];
  return s;
}

describe('QD-R8 执行视图与 trace 一致性', () => {
  it('CONTROL: 执行会话渲染用户消息、工具终态与最终答复', () => {
    const { canvas, inspector } = shells();
    renderExecutionSession(canvas, [inspector], baseSession());
    expect(canvas.textContent).toContain('查看目录');
    expect(canvas.textContent).toContain('完成');
    expect(inspector.querySelector('[data-run-id="c1"]')?.getAttribute('data-phase')).toBe('succeeded');
  });

  it('REPRO-A: 工作台丢弃 final-answer.truncationMarker，截断回答在远端看起来完整', () => {
    const { canvas, inspector } = shells();
    const session = baseSession();
    const final = session.events[session.events.length - 1];
    if (final.type === 'final-answer') {
      final.truncationMarker = '\n\n> 回答过长，已截断（原始 90000 字节，仅保留前 65536 字节预览）。';
    }
    renderExecutionSession(canvas, [inspector], session);

    // 正控：把标记写进正文时，渲染器会原样显示。
    const control = baseSession();
    const controlFinal = control.events[control.events.length - 1];
    if (controlFinal.type === 'final-answer') controlFinal.text = '完成 > 回答过长，已截断（CONTROL）';
    const other = shells();
    renderExecutionSession(other.canvas, [other.inspector], control);
    expect(other.canvas.textContent).toContain('CONTROL');

    console.log('[R8-A] workbench text =', JSON.stringify(canvas.textContent));
    expect(canvas.textContent).toContain('回答过长');
  });

  it('REPRO-B: 同一索引/同一会话重渲染会销毁并重建节点（每次事件都全量重建）', () => {
    const list = document.createElement('div');
    const index: StudioExecutionIndex = {
      version: 2,
      sessions: [{ key: 'chat:one', title: '查看目录', updatedAt: 40 }],
    };
    renderExecutionIndex(list, index, 'chat:one', () => {});
    const firstButton = list.querySelector('.session-item');
    renderExecutionIndex(list, index, 'chat:one', () => {});
    const secondButton = list.querySelector('.session-item');

    const { canvas, inspector } = shells();
    renderExecutionSession(canvas, [inspector], baseSession());
    const firstMessage = canvas.querySelector('.msg-user') ?? canvas.querySelector('.msg') ?? canvas.firstElementChild;
    renderExecutionSession(canvas, [inspector], baseSession());
    const secondMessage = canvas.querySelector('.msg-user') ?? canvas.querySelector('.msg') ?? canvas.firstElementChild;

    console.log('[R8-B] list node reused =', firstButton === secondButton, '| message node reused =', firstMessage === secondMessage);
    expect(secondButton).toBe(firstButton);
    expect(secondMessage).toBe(firstMessage);
  });

  it('REPRO-C: trace 环形缓冲先丢 turn.start/request.sent，长回合取证拿不到请求开头', () => {
    const collector = createStudioTraceCollector(20);
    collector.record({ t: 'turn.start', turnId: 't1' });
    collector.record({ t: 'request.sent', turnId: 't1', bytes: 8192, powMs: 120 });
    for (let i = 0; i < 40; i += 1) {
      collector.record({ t: 'sse.frame', turnId: 't1', kind: 'text', count: 10 });
    }
    const types = collector.snapshot().map((event) => event.t);
    console.log('[R8-C] first types =', JSON.stringify(types.slice(0, 5)), '| size =', collector.size());
    expect(types).toContain('turn.start');
    expect(types).toContain('request.sent');
  });
});
