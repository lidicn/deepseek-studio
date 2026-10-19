import { describe, it, expect } from 'vitest';
import { UI_MODE, TOOL_RUN_PHASES, WORKBENCH_BREAKPOINTS } from '../../src/ui/ui-contract';

describe('ui-contract', () => {
  it('UI_MODE has focus and workbench', () => {
    expect(UI_MODE.focus).toBe('focus');
    expect(UI_MODE.workbench).toBe('workbench');
  });

  it('TOOL_RUN_PHASES has 5 phases', () => {
    expect(TOOL_RUN_PHASES).toHaveLength(5);
    expect(TOOL_RUN_PHASES).toContain('started');
    expect(TOOL_RUN_PHASES).toContain('succeeded');
    expect(TOOL_RUN_PHASES).toContain('failed');
    expect(TOOL_RUN_PHASES).toContain('denied');
    expect(TOOL_RUN_PHASES).toContain('cancelled');
  });

  it('WORKBENCH_BREAKPOINTS has wide/medium/compact', () => {
    expect(WORKBENCH_BREAKPOINTS.wide).toBe(1440);
    expect(WORKBENCH_BREAKPOINTS.compact).toBe(900);
  });
});
