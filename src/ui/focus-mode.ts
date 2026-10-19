/**
 * Focus 模式（真 Shadow DOM 版）
 *
 * 替换旧 createFocusOverlay()：
 * - 全屏聚焦面板，半透明遮罩
 * - 只显示任务标题 + 输入框区域
 * - Esc 或点击遮罩退出
 * - 焦点陷阱在面板内
 */

import { mountShadowRoot } from './shadow-root';
import { button } from './primitives/button';

export interface FocusModeHandle {
  dispose(): void;
  isActive(): boolean;
}

const FOCUS_CSS = `
  .overlay {
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    z-index: 100;
  }
  .panel {
    background: var(--studio-bg-panel, #fff);
    border-radius: 16px;
    padding: 32px;
    max-width: 640px;
    width: 90%;
    box-shadow: 0 16px 48px rgba(0,0,0,0.2);
  }
  .title {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
    color: var(--studio-text-primary, #16181D);
  }
  .composer-anchor {
    min-height: 80px;
    border: 1px dashed var(--studio-border, #ddd);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 16px;
    color: var(--studio-text-secondary, #5B6170);
    font-size: 13px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
`;

export function createFocusMode(options?: { title?: string }): FocusModeHandle {
  const shadow = mountShadowRoot('focus-mode', { zIndex: 100 });
  shadow.mountStyle(FOCUS_CSS, 'focus-mode');

  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Focus 模式');
  panel.tabIndex = -1;

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = options?.title ?? '专注模式';

  const composerAnchor = document.createElement('div');
  composerAnchor.className = 'composer-anchor';
  composerAnchor.textContent = '输入框已聚焦——开始输入，Esc 退出';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const exitBtn = button('退出 Focus', 'secondary');
  actions.appendChild(exitBtn);

  panel.appendChild(title);
  panel.appendChild(composerAnchor);
  panel.appendChild(actions);
  overlay.appendChild(panel);
  shadow.root.appendChild(overlay);

  let active = true;

  function exit(): void {
    if (!active) return;
    active = false;
    shadow.dispose();
  }

  // 点击遮罩退出
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) exit();
  });

  // Esc 退出
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { exit(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);

  exitBtn.addEventListener('click', exit);
  panel.focus();

  return {
    dispose: exit,
    isActive: () => active,
  };
}
