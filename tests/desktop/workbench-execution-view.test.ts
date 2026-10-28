// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  renderExecutionIndex,
  renderExecutionIndexSelect,
  renderExecutionSession,
} from '../../src/ui/workbench/workbench-execution-view';
import {
  createEmptyStudioExecutionSession,
  type StudioExecutionIndex,
  type StudioExecutionSession,
} from '../../src/shared/studio-execution';

function shells(): { canvas: HTMLElement; inspector: HTMLElement; drawer: HTMLElement } {
  const canvas = document.createElement('section');
  const inspector = document.createElement('aside');
  const drawer = document.createElement('aside');
  document.body.append(canvas, inspector, drawer);
  return { canvas, inspector, drawer };
}

function session(): StudioExecutionSession {
  const s = createEmptyStudioExecutionSession('chat:one', 10);
  s.events = [
    { type: 'user-message', at: 10, turnId: 't1', text: '查看目录' },
    { type: 'tool-start', at: 20, turnId: 't1', callId: 'c1', toolName: 'shell_exec', params: { command: 'ls' } },
    { type: 'tool-result', at: 30, turnId: 't1', callId: 'c1', toolName: 'shell_exec', ok: true, durationMs: 12, result: { stdout: 'a' } },
    { type: 'final-answer', at: 40, turnId: 't1', text: '**完成**' },
  ];
  return s;
}

describe('Workbench 远程端 · 统一执行会话渲染', () => {
  it('索引渲染真实会话，点击回调拿到 key', () => {
    const list = document.createElement('div');
    const index: StudioExecutionIndex = {
      version: 2,
      sessions: [{ key: 'chat:one', title: '查看目录', updatedAt: 40 }],
    };
    let selected = '';
    renderExecutionIndex(list, index, 'chat:one', (key) => { selected = key; });
    expect(list.querySelector('.session-item')?.getAttribute('aria-current')).toBe('true');
    list.querySelector<HTMLButtonElement>('.session-item')?.click();
    expect(selected).toBe('chat:one');
  });

  it('窄屏选择器复用同一索引，并标记当前会话', () => {
    const select = document.createElement('select');
    const index: StudioExecutionIndex = {
      version: 2,
      sessions: [
        { key: 'chat:one', title: '查看目录', updatedAt: 40 },
        { key: 'chat:two', title: '修复问题', updatedAt: 50 },
      ],
    };

    renderExecutionIndexSelect(select, index, 'chat:two');
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('chat:two');
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['chat:one', 'chat:two']);
  });

  it('窄屏选择器在无记录时禁用并显示明确空态', () => {
    const select = document.createElement('select');
    renderExecutionIndexSelect(select, null, null);
    expect(select.disabled).toBe(true);
    expect(select.options).toHaveLength(1);
    expect(select.options[0].textContent).toContain('暂无 Studio 执行记录');
  });

  it('用户消息、工具终态、最终答复来自同一份 StudioExecutionSession', () => {
    const { canvas, inspector, drawer } = shells();
    renderExecutionSession(canvas, [inspector, drawer], session());

    expect(canvas.textContent).toContain('查看目录');
    expect(canvas.querySelector('.ds-sc-markdown') ?? canvas.querySelector('.msg-assistant')?.innerHTML).toBeTruthy();
    expect(canvas.textContent).toContain('完成');
    expect(inspector.querySelector('[data-run-id="c1"]')?.getAttribute('data-phase')).toBe('succeeded');
    expect(drawer.querySelector('[data-run-id="c1"]')?.getAttribute('data-phase')).toBe('succeeded');
  });

  it('切换会话时整区替换，不叠加旧卡片', () => {
    const { canvas, inspector, drawer } = shells();
    renderExecutionSession(canvas, [inspector, drawer], session());
    const next = createEmptyStudioExecutionSession('chat:two', 50);
    next.events = [{ type: 'user-message', at: 50, turnId: 't2', text: '下一会话' }];

    renderExecutionSession(canvas, [inspector, drawer], next);
    expect(canvas.textContent).toContain('下一会话');
    expect(canvas.textContent).not.toContain('查看目录');
    expect(inspector.querySelector('[data-run-id="c1"]')).toBeNull();
  });
});
