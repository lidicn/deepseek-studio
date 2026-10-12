// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createStepFlowContainer } from '../../src/inject/step-flow-ui';

describe('StepFlowContainer (v0.18)', () => {
  it('不同步骤的工具进入不同分组，同步骤工具合并', () => {
    const sf = createStepFlowContainer();
    sf.addToolEntry(0, 'shell_exec', { command: 'ls' });
    sf.addToolEntry(0, 'local_file_read', { path: 'a' });
    sf.addToolEntry(1, 'shell_exec', { command: 'pwd' });

    const groups = sf.container.querySelectorAll('.ds-sf-tool-group');
    expect(groups).toHaveLength(2);
    expect(groups[0].getAttribute('data-step-index')).toBe('0');
    expect(groups[1].getAttribute('data-step-index')).toBe('1');
    expect(groups[0].querySelectorAll('.ds-sf-tool-item')).toHaveLength(2);
    expect(groups[1].querySelectorAll('.ds-sf-tool-item')).toHaveLength(1);
    sf.destroy();
  });

  it('工具组标题显示调用次数', () => {
    const sf = createStepFlowContainer();
    sf.addToolEntry(0, 'a');
    sf.addToolEntry(0, 'b');
    const title = sf.container.querySelector('.ds-sf-tool-group-title');
    expect(title?.textContent).toBe('已调用2次工具');
    sf.destroy();
  });

  it('resolveToolEntry 按顺序更新工具状态为 ok/err', () => {
    const sf = createStepFlowContainer();
    sf.addToolEntry(0, 'a');
    sf.addToolEntry(0, 'b');
    sf.resolveToolEntry(0, true, 'out');
    sf.resolveToolEntry(0, false, 'boom');
    const items = sf.container.querySelectorAll('.ds-sf-tool-item');
    expect(items[0].getAttribute('data-tool-status')).toBe('ok');
    expect(items[1].getAttribute('data-tool-status')).toBe('err');
    expect(items[0].querySelector('.ds-sf-tool-state')?.textContent).toBe('OK');
    expect(items[1].querySelector('.ds-sf-tool-state')?.textContent).toBe('Error');
    // 详情写入
    expect(items[1].querySelector('.ds-sf-tool-summary')?.textContent).toBe('boom');
    sf.destroy();
  });

  it('addReasoningNote 创建笔记并可流式更新，不同步骤各自独立', () => {
    const sf = createStepFlowContainer();
    sf.addReasoningNote(0, '初步');
    sf.addReasoningNote(0, '初步思考完成');
    let notes = sf.container.querySelectorAll('.ds-sf-reasoning-note');
    expect(notes).toHaveLength(1);
    const body = notes[0].querySelector('.ds-sf-reasoning-note-body');
    expect(body?.textContent).toBe('初步思考完成');

    sf.addReasoningNote(1, '第二步');
    notes = sf.container.querySelectorAll('.ds-sf-reasoning-note');
    expect(notes).toHaveLength(2);
    sf.destroy();
  });

  it('setPhase running 状态栏含步数/工具数/耗时，finish 后 complete 并折叠', () => {
    const sf = createStepFlowContainer();
    sf.addToolEntry(0, 'a');
    sf.setPhase('running', 0, 1, 5);
    const statusText = sf.container.querySelector('.ds-sf-status-text')?.textContent ?? '';
    expect(statusText).toContain('第1步');
    expect(statusText).toContain('1次工具');
    expect(statusText).toContain('5s');

    sf.finish(1, 1, 5);
    expect(sf.container.getAttribute('data-phase')).toBe('complete');
    const group = sf.container.querySelector('.ds-sf-tool-group');
    expect(group?.getAttribute('data-collapsed')).toBe('true');
    sf.destroy();
  });

  it('停止按钮接线 onStop', () => {
    const onStop = vi.fn();
    const sf = createStepFlowContainer(onStop);
    const btn = sf.container.querySelector('.ds-sf-stop-btn') as HTMLButtonElement;
    btn.click();
    expect(onStop).toHaveBeenCalledOnce();
    sf.destroy();
  });

  it('未传 onStop 时不渲染停止按钮', () => {
    const sf = createStepFlowContainer();
    expect(sf.container.querySelector('.ds-sf-stop-btn')).toBeNull();
    sf.destroy();
  });
});
