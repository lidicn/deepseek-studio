/**
 * 设计 Token（唯一真源）
 *
 * 颜色分 light / dark，组件只引用 CSS 变量或 token，不硬编码色值。
 */

export const color = {
  light: {
    bgPage: '#F7F8FA',
    bgPanel: '#FFFFFF',
    bgSubtle: '#F5F6F8',
    textPrimary: '#16181D',
    textSecondary: '#5B6170',
    textWeak: '#6B7280',
    border: 'rgba(16,24,40,0.08)',
    primaryFill: '#4D6BFE',
    primaryHover: '#3B5BDB',
    primaryText: '#2F4FD8',
    primarySoft: 'rgba(77,107,254,0.08)',
    successText: '#1F7A52',
    warningText: '#8A5A00',
    dangerText: '#C43A3A',
  },
  dark: {
    bgPage: '#111318',
    bgPanel: '#181B21',
    bgSubtle: '#1E222B',
    textPrimary: '#E6E8EC',
    textSecondary: '#A7ADB8',
    textWeak: '#858B96',
    border: 'rgba(255,255,255,0.10)',
    primaryFill: '#6E8BFF',
    primaryHover: '#8DA3FF',
    primaryText: '#9BB0FF',
    primarySoft: 'rgba(110,139,255,0.12)',
    successText: '#55C995',
    warningText: '#E8B45A',
    dangerText: '#FF7A7A',
  },
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
} as const;

export const font = {
  family: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  mono: '"Cascadia Code", "JetBrains Mono", monospace',
  size: {
    xs: 11,
    sm: 12,
    md: 13,
    lg: 14,
    xl: 16,
    xxl: 20,
  },
} as const;

export const zLayer = {
  rail: 10,
  panel: 20,
  overlay: 30,
  dialog: 40,
  toast: 50,
  tooltip: 60,
} as const;

export function tokensToCssVars(theme: 'light' | 'dark'): string {
  const c = color[theme];
  return [
    `--studio-bg-page: ${c.bgPage}`,
    `--studio-bg-panel: ${c.bgPanel}`,
    `--studio-bg-subtle: ${c.bgSubtle}`,
    `--studio-text-primary: ${c.textPrimary}`,
    `--studio-text-secondary: ${c.textSecondary}`,
    `--studio-text-weak: ${c.textWeak}`,
    `--studio-border: ${c.border}`,
    `--studio-primary-fill: ${c.primaryFill}`,
    `--studio-primary-hover: ${c.primaryHover}`,
    `--studio-primary-text: ${c.primaryText}`,
    `--studio-primary-soft: ${c.primarySoft}`,
    `--studio-success: ${c.successText}`,
    `--studio-warning: ${c.warningText}`,
    `--studio-danger: ${c.dangerText}`,
  ].join(';\n  ');
}
