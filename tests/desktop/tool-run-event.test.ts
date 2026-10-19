// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { TERMINAL_PHASES } from '../../src/shared/tool-run-event';
import { TOOL_RUN_PHASES, type ToolRunPhase } from '../../src/ui/ui-contract';

describe('tool-run-event 终态集合与 phase 合法（W8）', () => {
  it('TERMINAL_PHASES 含 succeeded/failed/denied/cancelled，不含 started', () => {
    expect(TERMINAL_PHASES.has('succeeded')).toBe(true);
    expect(TERMINAL_PHASES.has('failed')).toBe(true);
    expect(TERMINAL_PHASES.has('denied')).toBe(true);
    expect(TERMINAL_PHASES.has('cancelled')).toBe(true);
    expect(TERMINAL_PHASES.has('started')).toBe(false);
  });

  it('五个合法 phase 与 TOOL_RUN_PHASES 一致', () => {
    expect([...TOOL_RUN_PHASES]).toEqual(['started', 'succeeded', 'failed', 'denied', 'cancelled']);
  });

  it('started 非终态；未知 phase 不被误判为终态（兜底）', () => {
    expect(TERMINAL_PHASES.has('started')).toBe(false);
    expect(TERMINAL_PHASES.has('unknown-phase' as ToolRunPhase)).toBe(false);
    expect(TERMINAL_PHASES.has('' as ToolRunPhase)).toBe(false);
  });
});
