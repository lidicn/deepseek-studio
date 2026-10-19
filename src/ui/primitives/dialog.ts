/** 对话框基元（焦点陷阱 + Esc + 遮罩） */

export interface DialogHandle {
  el: HTMLDivElement;
  close(): void;
}

export function dialog(title: string, content: HTMLElement, options?: { closable?: boolean }): DialogHandle {
  const closable = options?.closable ?? true;
  const activeElement = document.activeElement as HTMLElement | null;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position: fixed',
    'top: 0', 'left: 0', 'width: 100%', 'height: 100%',
    'background: rgba(0,0,0,0.4)',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'z-index: 100',
  ].join('; ');

  const box = document.createElement('div');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  box.style.cssText = [
    'background: var(--studio-bg-panel, #fff)',
    'border-radius: 12px',
    'padding: 20px',
    'max-width: 420px',
    'width: 90%',
    'box-shadow: 0 8px 32px rgba(0,0,0,0.15)',
  ].join('; ');

  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  titleEl.style.cssText = 'font-size: 15px; font-weight: 600; margin-bottom: 12px;';

  box.appendChild(titleEl);
  box.appendChild(content);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function close(): void {
    if (!overlay.parentNode) return;
    overlay.parentNode.removeChild(overlay);
    if (activeElement) activeElement.focus();
  }

  if (closable) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
  }

  box.focus();
  return { el: box, close };
}
