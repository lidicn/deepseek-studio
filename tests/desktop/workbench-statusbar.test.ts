// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../src/ui/workbench/workbench-state';
import { renderStatusbar } from '../../src/ui/workbench/workbench-statusbar';

describe('workbench statusbar 记忆降级提示', () => {
  it('memory 后端显示重启丢失告警', () => {
    const bar = document.createElement('div');
    renderStatusbar(bar, { ...createInitialState(), memoryBackend: 'memory' });
    expect(bar.textContent).toContain('记忆库降级为内存，重启后丢失');
  });

  it('sqlite 后端不显示告警', () => {
    const bar = document.createElement('div');
    renderStatusbar(bar, createInitialState());
    expect(bar.textContent).not.toContain('记忆库降级为内存');
  });
});
