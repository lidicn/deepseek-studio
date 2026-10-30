/**
 * 主题层：把 `ds-studio-vis-*` 类名映射成 CSS。
 *
 * 设计要点（与仓内既有约定对齐）：
 * 1. **token 化**：颜色/间距/圆角全走 `--ds-studio-vis-*` 变量，换主题只改变量、不重渲染；
 * 2. **离线**：不引字体、不引外部图片、不出现 `@import` —— 与 dpp「预览不出网」的口径一致；
 * 3. **深浅色**：`[data-ds-studio-vis-theme="dark"]` 覆盖变量；同时尊重 `prefers-reduced-motion`；
 * 4. **唯一产出点**：注入层只调 `buildVisCss()`，不在别处拼样式，避免样式漂移。
 */

export type VisThemeName = 'light' | 'dark';

export interface VisThemeTokens {
  radius: string;
  gap: string;
  surface: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  font: string;
}

export const VIS_THEME_TOKENS: Record<VisThemeName, VisThemeTokens> = {
  light: {
    radius: '12px',
    gap: '12px',
    surface: 'transparent',
    panel: '#ffffff',
    border: 'rgba(0, 0, 0, 0.10)',
    text: 'rgba(0, 0, 0, 0.88)',
    muted: 'rgba(0, 0, 0, 0.55)',
    accent: '#2f6feb',
    accentText: '#ffffff',
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  dark: {
    radius: '12px',
    gap: '12px',
    surface: 'transparent',
    panel: '#161b22',
    border: 'rgba(255, 255, 255, 0.12)',
    text: 'rgba(255, 255, 255, 0.92)',
    muted: 'rgba(255, 255, 255, 0.60)',
    accent: '#4c8dff',
    accentText: '#0b1020',
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
};

function tokenBlock(t: VisThemeTokens): string {
  return [
    `  --ds-studio-vis-radius: ${t.radius};`,
    `  --ds-studio-vis-gap: ${t.gap};`,
    `  --ds-studio-vis-surface: ${t.surface};`,
    `  --ds-studio-vis-panel: ${t.panel};`,
    `  --ds-studio-vis-border: ${t.border};`,
    `  --ds-studio-vis-text: ${t.text};`,
    `  --ds-studio-vis-muted: ${t.muted};`,
    `  --ds-studio-vis-accent: ${t.accent};`,
    `  --ds-studio-vis-accent-text: ${t.accentText};`,
    `  --ds-studio-vis-font: ${t.font};`,
    '  --ds-studio-vis-hue: 210;',
  ].join('\n');
}

/**
 * 生成完整 CSS（含两套主题 token 与全部组件样式）。
 * `scope` 用于把样式限制在容器内（注入层传 `.ds-studio-vis-root` 的宿主选择器）。
 */
export function buildVisCss(options: { scope?: string } = {}): string {
  const scope = options.scope ?? '.ds-studio-vis-root';
  return `${scope} {
${tokenBlock(VIS_THEME_TOKENS.light)}
  color: var(--ds-studio-vis-text);
  font-family: var(--ds-studio-vis-font);
  font-size: 14px;
  line-height: 1.55;
}
${scope}[data-ds-studio-vis-theme="dark"] {
${tokenBlock(VIS_THEME_TOKENS.dark)}
}
${scope} .ds-studio-vis-column { display: flex; flex-direction: column; gap: var(--ds-studio-vis-gap); }
${scope} .ds-studio-vis-row {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: calc(var(--ds-studio-vis-gap) + 4px);
}
/* Fixed image width inside Row: a 2:3 poster must not stretch to full width (card would reach ~800px tall) */
${scope} .ds-studio-vis-row > .ds-studio-vis-img,
${scope} .ds-studio-vis-row > .ds-studio-vis-img--placeholder {
  flex: 0 0 132px;
  width: 132px;
}
${scope} .ds-studio-vis-row > .ds-studio-vis-column {
  flex: 1 1 auto;
  min-width: 0;
}
${scope} .ds-studio-vis-text { margin: 0; overflow-wrap: anywhere; }
${scope} .ds-studio-vis-text--title { font-size: 18px; font-weight: 650; letter-spacing: -0.01em; }
${scope} .ds-studio-vis-text--subtitle { font-size: 13px; font-weight: 600; color: var(--ds-studio-vis-muted); }
${scope} .ds-studio-vis-text--body { font-size: 14px; }
${scope} .ds-studio-vis-text--meta { font-size: 12px; color: var(--ds-studio-vis-muted); }
${scope} .ds-studio-vis-img {
  position: relative;
  display: block;
  width: 100%;
  overflow: hidden;
  border-radius: var(--ds-studio-vis-radius);
  border: 1px solid var(--ds-studio-vis-border);
  background: var(--ds-studio-vis-panel);
  object-fit: cover;
}
${scope} .ds-studio-vis-ratio-2x3 { aspect-ratio: 2 / 3; }
${scope} .ds-studio-vis-ratio-16x9 { aspect-ratio: 16 / 9; }
/* Placeholder uses hsl vars only: fully offline, zero network requests */
${scope} .ds-studio-vis-img--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background-image: linear-gradient(
    145deg,
    hsl(var(--ds-studio-vis-hue) 42% 24%),
    hsl(calc(var(--ds-studio-vis-hue) + 48) 38% 12%)
  );
}
${scope} .ds-studio-vis-skeleton {
  display: flex;
  gap: calc(var(--ds-studio-vis-gap) + 4px);
  align-items: flex-start;
}
${scope} .ds-studio-vis-skeleton__poster {
  flex: 0 0 132px;
  width: 132px;
  aspect-ratio: 2 / 3;
  border-radius: var(--ds-studio-vis-radius);
  background: linear-gradient(100deg, rgba(127,127,127,.14) 20%, rgba(127,127,127,.24) 40%, rgba(127,127,127,.14) 60%);
  background-size: 220% 100%;
  animation: ds-studio-vis-shimmer 1.5s ease-in-out infinite;
}
${scope} .ds-studio-vis-skeleton__col {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}
${scope} .ds-studio-vis-skeleton__bar {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(100deg, rgba(127,127,127,.14) 20%, rgba(127,127,127,.24) 40%, rgba(127,127,127,.14) 60%);
  background-size: 220% 100%;
  animation: ds-studio-vis-shimmer 1.5s ease-in-out infinite;
}
${scope} .ds-studio-vis-skeleton__bar--title { height: 18px; width: 62%; }
${scope} .ds-studio-vis-skeleton__bar--line { width: 100%; }
${scope} .ds-studio-vis-skeleton__bar--short { width: 44%; }
@keyframes ds-studio-vis-shimmer {
  from { background-position: 140% 0; }
  to { background-position: -40% 0; }
}
${scope} .ds-studio-vis-img--needpermission {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.94);
  background: linear-gradient(145deg, rgba(43,55,72,.92), rgba(24,30,42,.96));
  text-align: center;
}
${scope} .ds-studio-vis-img--needpermission:hover { filter: brightness(1.12); }
${scope} .ds-studio-vis-img--needpermission:focus-visible { outline: 2px solid var(--ds-studio-vis-accent); outline-offset: 2px; }
${scope} .ds-studio-vis-img__hint {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.66);
  overflow-wrap: anywhere;
}
${scope} .ds-studio-vis-img__alt {
  padding: 8px 12px;
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  ${scope} * { transition: none !important; animation: none !important; }
}
`;
}
