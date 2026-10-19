/** 空状态占位 */
export function emptyState(message: string, hint?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'display: flex',
    'flex-direction: column',
    'align-items: center',
    'justify-content: center',
    'padding: 40px 20px',
    'color: var(--studio-text-weak, #6B7280)',
    'text-align: center',
  ].join('; ');

  const msg = document.createElement('div');
  msg.textContent = message;
  msg.style.cssText = 'font-size: 14px; margin-bottom: 4px;';
  el.appendChild(msg);

  if (hint) {
    const h = document.createElement('div');
    h.textContent = hint;
    h.style.cssText = 'font-size: 12px; opacity: 0.7;';
    el.appendChild(h);
  }
  return el;
}
