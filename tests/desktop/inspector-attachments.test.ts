// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendToolRun,
  attachToolRunAttachments,
} from '../../src/ui/workbench/workbench-inspector';
import { toolRunCard } from '../../src/ui/primitives/tool-run-card';
import type { ToolRunEvent } from '../../src/shared/tool-run-event';

function evt(patch: Partial<ToolRunEvent>): ToolRunEvent {
  return { type: 'tool-run', runId: 'r1', tool: 'file.edit', phase: 'started', ...patch };
}

function inspector(): HTMLElement {
  document.body.innerHTML =
    '<aside class="right-inspector"><div class="pane-body inspector-body"></div></aside>';
  return document.querySelector('.right-inspector') as HTMLElement;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('P1 · 附属卡挂在主卡片内部', () => {
  it('artifact-card 渲染进主卡片内，不是右栏顶层节点', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'succeeded', artifactPaths: ['E:/a.ts'] }));
    const main = insp.querySelector('[data-run-id]') as HTMLElement;
    expect(main).not.toBeNull();
    const art = main.querySelector('.wb-artifact-card');
    expect(art).not.toBeNull();
    // 顶层只有一个 data-run-id 节点（附属卡在里面）
    expect(insp.querySelectorAll(':scope > .pane-body > [data-run-id]')).toHaveLength(1);
    expect(insp.querySelectorAll('.wb-artifact-card')).toHaveLength(1);
  });

  it('diff-review 只在 details 命中白名单时渲染', () => {
    const insp = inspector();
    appendToolRun(insp, evt({
      phase: 'succeeded',
      details: { path: 'E:/a.ts', replacements: 3, bytesBefore: 100, bytesAfter: 80 },
    }));
    const main = insp.querySelector('[data-run-id]') as HTMLElement;
    expect(main.querySelector('.wb-diff-review')).not.toBeNull();
    expect(main.querySelector('.wb-diff-path')?.textContent).toContain('E:/a.ts');
    expect(main.querySelector('.wb-diff-meta')?.textContent).toContain('替换 3 处');
  });

  it('details 为空对象 → 不渲染 diff-review', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'succeeded', details: {} }));
    const main = insp.querySelector('[data-run-id]') as HTMLElement;
    expect(main.querySelector('.wb-diff-review')).toBeNull();
  });

  it('error-card 只在 failed/denied 且有 errorCode 时渲染', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'failed', errorCode: 'tool-timeout' }));
    const main = insp.querySelector('[data-run-id]') as HTMLElement;
    expect(main.querySelector('.wb-error-card')).not.toBeNull();
  });

  it('succeeded 带 errorCode 也不渲染 error-card（不误导）', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'succeeded', errorCode: 'tool-timeout' }));
    const main = insp.querySelector('[data-run-id]') as HTMLElement;
    expect(main.querySelector('.wb-error-card')).toBeNull();
  });

  it('shell 事件无 artifactPaths → 不产生产物卡（无源不猜）', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ tool: 'shell', phase: 'succeeded' }));
    const main = insp.querySelector('[data-run-id]') as HTMLElement;
    expect(main.querySelector('.wb-artifact-card')).toBeNull();
  });

  it('artifactPaths 为空数组 → 不产生产物卡', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'succeeded', artifactPaths: [] }));
    const main = insp.querySelector('[data-run-id]') as HTMLElement;
    expect(main.querySelector('.wb-artifact-card')).toBeNull();
  });
});

describe('P1 · 终态替换不叠加', () => {
  it('started → succeeded 更新主卡片，附属卡不重复', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'started', artifactPaths: ['E:/a.ts'] }));
    appendToolRun(insp, evt({ phase: 'succeeded', artifactPaths: ['E:/a.ts'] }));
    expect(insp.querySelectorAll('[data-run-id]')).toHaveLength(1);
    expect(insp.querySelectorAll('.wb-artifact-card')).toHaveLength(1);
  });

  it('失败后迟到的 started 不覆盖终态，附属卡保持终态版本', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'failed', errorCode: 'tool-timeout' }));
    appendToolRun(insp, evt({ phase: 'started' }));
    expect(insp.querySelectorAll('[data-run-id]')).toHaveLength(1);
    expect(insp.querySelector('[data-run-id]')?.getAttribute('data-phase')).toBe('failed');
    expect(insp.querySelectorAll('.wb-error-card')).toHaveLength(1);
  });

  it('同一 runId 连续多次 succeeded，附属卡仍只有一份', () => {
    const insp = inspector();
    appendToolRun(insp, evt({ phase: 'succeeded', artifactPaths: ['E:/a.ts', 'E:/b.ts'] }));
    appendToolRun(insp, evt({ phase: 'succeeded', artifactPaths: ['E:/a.ts', 'E:/b.ts'] }));
    expect(insp.querySelectorAll('[data-run-id]')).toHaveLength(1);
    expect(insp.querySelectorAll('.wb-artifact-card')).toHaveLength(1);
  });
});

describe('P1 · attachToolRunAttachments 独立可用', () => {
  it('对独立主卡片挂载三类附属卡', () => {
    const card = toolRunCard(evt({ phase: 'failed' }));
    attachToolRunAttachments(card, evt({
      phase: 'failed',
      errorCode: 'policy-denied',
      artifactPaths: ['E:/a.ts'],
      details: { path: 'E:/a.ts', replacements: 1 },
    }));
    expect(card.querySelector('.wb-artifact-card')).not.toBeNull();
    expect(card.querySelector('.wb-diff-review')).not.toBeNull();
    expect(card.querySelector('.wb-error-card')).not.toBeNull();
  });

  it('无任何附属数据时不产生子节点', () => {
    const card = toolRunCard(evt({ phase: 'succeeded' }));
    attachToolRunAttachments(card, evt({ phase: 'succeeded' }));
    expect(card.querySelectorAll('.wb-artifact-card, .wb-diff-review, .wb-error-card')).toHaveLength(0);
  });
});
