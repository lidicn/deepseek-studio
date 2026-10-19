/** 基础按钮组件 */
export function button(label: string, variant: 'primary' | 'secondary' | 'danger' = 'secondary'): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.style.cssText = [
    'padding: 6px 14px',
    'border-radius: 8px',
    'border: none',
    'font-size: 13px',
    'cursor: pointer',
    'transition: background 0.15s',
    variant === 'primary' ? 'background: var(--studio-primary-fill, #4D6BFE); color: #fff;' : '',
    variant === 'secondary' ? 'background: var(--studio-bg-subtle, #F5F6F8); color: var(--studio-text-primary, #16181D);' : '',
    variant === 'danger' ? 'background: #C43A3A; color: #fff;' : '',
  ].join('; ');
  return el;
}
