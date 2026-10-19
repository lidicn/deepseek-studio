/** 小标签/徽章 */
export function badge(text: string, tone: 'default' | 'primary' | 'success' | 'warning' | 'danger' = 'default'): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  const colors: Record<string, string> = {
    default: 'background: var(--studio-bg-subtle, #F5F6F8); color: var(--studio-text-secondary, #5B6170);',
    primary: 'background: var(--studio-primary-soft, rgba(77,107,254,0.08)); color: var(--studio-primary-text, #2F4FD8);',
    success: 'background: rgba(31,122,82,0.1); color: var(--studio-success, #1F7A52);',
    warning: 'background: rgba(138,90,0,0.1); color: var(--studio-warning, #8A5A00);',
    danger: 'background: rgba(196,58,58,0.1); color: var(--studio-danger, #C43A3A);',
  };
  el.style.cssText = [
    'display: inline-block',
    'padding: 2px 8px',
    'border-radius: 4px',
    'font-size: 11px',
    'line-height: 1.5',
    colors[tone],
  ].join('; ');
  return el;
}
