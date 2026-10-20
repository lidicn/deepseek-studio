// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { appendToolRun, getInspectorBody } from '../../src/ui/workbench/workbench-inspector';
import type { ToolRunEvent } from '../../src/shared/tool-run-event';

function evt(patch: Partial<ToolRunEvent>): ToolRunEvent {
  return { type: 'tool-run', runId: 'r1', tool: 'file.edit', phase: 'started', ...patch };
}

/** 复刻 agent.html 的两个出口：宽屏右栏 + 窄屏抽屉，都是 .pane-body.inspector-body。 */
function buildTwoOutlets(): { right: HTMLElement; drawer: HTMLElement } {
  document.body.innerHTML = `
    <aside class="right-inspector" id="right-inspector"><div class="pane-body inspector-body"></div></aside>
    <aside class="inspector-drawer" id="inspector-drawer"><div class="pane-body inspector-body"></div></aside>
  `;
  return {
    right: document.getElementById('right-inspector') as HTMLElement,
    drawer: document.getElementById('inspector-drawer') as HTMLElement,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('Inspector 抽屉镜像 · 同一事件两个出口（X4）', () => {
  it('同一 tool-run 事件在右栏与抽屉各渲染一张卡', () => {
    const { right, drawer } = buildTwoOutlets();
    appendToolRun(right, evt({}));
    appendToolRun(drawer, evt({}));
    expect(right.querySelectorAll('[data-run-id]')).toHaveLength(1);
    expect(drawer.querySelectorAll('[data-run-id]')).toHaveLength(1);
  });

  it('两边的 data-run-id 一致', () => {
    const { right, drawer } = buildTwoOutlets();
    appendToolRun(right, evt({ runId: 'r1' }));
    appendToolRun(drawer, evt({ runId: 'r1' }));
    const a = right.querySelector('[data-run-id]')?.getAttribute('data-run-id');
    const b = drawer.querySelector('[data-run-id]')?.getAttribute('data-run-id');
    expect(a).toBe('r1');
    expect(b).toBe(a);
  });

  it('started → succeeded 更新同一 runId，不新增卡片', () => {
    const { right, drawer } = buildTwoOutlets();
    appendToolRun(right, evt({ phase: 'started' }));
    appendToolRun(drawer, evt({ phase: 'started' }));
    appendToolRun(right, evt({ phase: 'succeeded', durationMs: 12 }));
    appendToolRun(drawer, evt({ phase: 'succeeded', durationMs: 12 }));
    expect(right.querySelectorAll('[data-run-id]')).toHaveLength(1);
    expect(drawer.querySelectorAll('[data-run-id]')).toHaveLength(1);
    expect(right.querySelector('[data-run-id]')?.getAttribute('data-phase')).toBe('succeeded');
    expect(drawer.querySelector('[data-run-id]')?.getAttribute('data-phase')).toBe('succeeded');
  });

  it('终态后迟到的事件不覆盖终态（两边一致）', () => {
    const { right, drawer } = buildTwoOutlets();
    appendToolRun(right, evt({ phase: 'succeeded' }));
    appendToolRun(drawer, evt({ phase: 'succeeded' }));
    appendToolRun(right, evt({ phase: 'started' }));
    appendToolRun(drawer, evt({ phase: 'started' }));
    expect(right.querySelector('[data-run-id]')?.getAttribute('data-phase')).toBe('succeeded');
    expect(drawer.querySelector('[data-run-id]')?.getAttribute('data-phase')).toBe('succeeded');
  });

  it('不同 runId 在两个出口各留多条', () => {
    const { right, drawer } = buildTwoOutlets();
    appendToolRun(right, evt({ runId: 'r1', phase: 'succeeded' }));
    appendToolRun(right, evt({ runId: 'r2', phase: 'succeeded' }));
    appendToolRun(drawer, evt({ runId: 'r1', phase: 'succeeded' }));
    appendToolRun(drawer, evt({ runId: 'r2', phase: 'succeeded' }));
    expect(right.querySelectorAll('[data-run-id]')).toHaveLength(2);
    expect(drawer.querySelectorAll('[data-run-id]')).toHaveLength(2);
  });

  it('抽屉容器没有 .inspector-body 时自动补建', () => {
    document.body.innerHTML = '<aside class="inspector-drawer" id="d"></aside>';
    const drawer = document.getElementById('d') as HTMLElement;
    appendToolRun(drawer, evt({}));
    expect(drawer.querySelector('.inspector-body')).not.toBeNull();
    expect(drawer.querySelector('[data-run-id]')).not.toBeNull();
  });

  it('缺 tool 字段的畸形事件被忽略，不产生卡片', () => {
    const { right, drawer } = buildTwoOutlets();
    const bad = { type: 'tool-run', runId: 'r1', phase: 'started' } as unknown as ToolRunEvent;
    appendToolRun(right, bad);
    appendToolRun(drawer, bad);
    expect(right.querySelectorAll('[data-run-id]')).toHaveLength(0);
    expect(drawer.querySelectorAll('[data-run-id]')).toHaveLength(0);
  });

  it('getInspectorBody 幂等：重复取返回同一节点', () => {
    const { drawer } = buildTwoOutlets();
    const a = getInspectorBody(drawer);
    const b = getInspectorBody(drawer);
    expect(a).toBe(b);
  });
});
