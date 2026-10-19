/**
 * UI 契约（跨组件共享的常量与类型）
 */

export const UI_MODE = { focus: 'focus', workbench: 'workbench' } as const;
export type UiMode = (typeof UI_MODE)[keyof typeof UI_MODE];

export const TOOL_RUN_PHASES = [
  'started',
  'succeeded',
  'failed',
  'denied',
  'cancelled',
] as const;
export type ToolRunPhase = (typeof TOOL_RUN_PHASES)[number];

export const WORKBENCH_BREAKPOINTS = {
  wide: 1440,
  medium: 1200,
  compact: 900,
} as const;
