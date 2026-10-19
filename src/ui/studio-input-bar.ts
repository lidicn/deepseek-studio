/**
 * StudioUI 输入框增强栏（v1.0）
 *
 * 注入到 deepseek 输入框上方，提供：
 * - 本地电脑开关（控制是否启用本地工具）
 * - 项目选择（显示当前项目，点击弹出项目选择器）
 * - 权限模式（全部允许/每次询问）
 * - 技能按钮（弹出技能管理面板）
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState } from './studio-ui-core';

const barStyles = `
  .studio-input-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 12px;
    color: #666;
    flex-wrap: nowrap;
    pointer-events: auto;
  }
  .studio-bar-item {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 14px;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
    border: 1px solid transparent;
  }
  .studio-bar-item:hover { background: #eef1ff; }
  .studio-bar-item.active { background: #e8edff; color: #4D6BFE; border-color: #c5d0ff; }
  .studio-bar-item svg { flex-shrink: 0; }
  .studio-bar-divider { width: 1px; height: 16px; background: #e0e0e0; margin: 0 2px; }
  .studio-bar-label { white-space: nowrap; }
  .studio-mode-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    padding: 4px;
    min-width: 140px;
    z-index: 100;
  }
  .studio-mode-option {
    padding: 8px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .studio-mode-option:hover { background: #f5f7ff; }
  .studio-mode-option.selected { color: #4D6BFE; font-weight: 500; }
`;

export function createInputBar(): { container: HTMLElement } {
  const { container, shadow } = createShadowContainer('studio-input-bar-root');
  injectStyles(shadow, barStyles);

  const bar = el('div', { className: 'studio-input-bar' });

  // 本地电脑开关
  const localToggle = el('div', { className: 'studio-bar-item active' }, [
    icon(Icons.cpu, 14),
    el('span', { className: 'studio-bar-label', text: '本地电脑' }),
  ]);
  localToggle.addEventListener('click', () => {
    globalState.localToolsEnabled = !globalState.localToolsEnabled;
    localToggle.classList.toggle('active', globalState.localToolsEnabled);
    globalEvents.emit('ui:local-tools-toggled', globalState.localToolsEnabled);
  });
  bar.appendChild(localToggle);

  // 项目选择
  const projectBtn = el('div', { className: 'studio-bar-item' }, [
    icon(Icons.folder, 14),
    el('span', { className: 'studio-bar-label', text: globalState.currentProject ?? '选择项目' }),
    icon(Icons.chevronDown, 12),
  ]);
  projectBtn.addEventListener('click', () => globalEvents.emit('ui:project-picker'));
  bar.appendChild(projectBtn);

  bar.appendChild(el('div', { className: 'studio-bar-divider' }));

  // 权限模式
  const modeLabels: Record<string, string> = { full: '全部允许', auto: '自动审批', ask: '每次询问' };
  const modeBtn = el('div', { className: 'studio-bar-item', style: { position: 'relative' as const } }, [
    icon(Icons.check, 14),
    el('span', { className: 'studio-bar-label', text: modeLabels[globalState.policyMode] ?? '全部允许' }),
    icon(Icons.chevronDown, 12),
  ]);

  const modeDropdown = el('div', { className: 'studio-mode-dropdown', style: { display: 'none' } });
  for (const [mode, label] of Object.entries(modeLabels)) {
    const option = el('div', { className: `studio-mode-option${mode === globalState.policyMode ? ' selected' : ''}` }, [
      mode === globalState.policyMode ? icon(Icons.check, 12) : el('span', { style: { width: '12px', display: 'inline-block' } }),
      el('span', { text: label }),
    ]);
    option.addEventListener('click', () => {
      globalState.policyMode = mode as 'full' | 'auto' | 'ask';
      modeBtn.querySelector('.studio-bar-label')!.textContent = label;
      modeDropdown.style.display = 'none';
      globalEvents.emit('ui:policy-changed', mode);
      // 更新选中状态
      modeDropdown.querySelectorAll('.studio-mode-option').forEach((o) => o.classList.remove('selected'));
      option.classList.add('selected');
    });
    modeDropdown.appendChild(option);
  }
  modeBtn.appendChild(modeDropdown);

  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = modeDropdown.style.display !== 'none';
    modeDropdown.style.display = isVisible ? 'none' : 'block';
  });
  document.addEventListener('click', () => { modeDropdown.style.display = 'none'; });
  bar.appendChild(modeBtn);

  bar.appendChild(el('div', { className: 'studio-bar-divider' }));

  // 技能按钮
  const skillsBtn = el('div', { className: 'studio-bar-item' }, [
    icon(Icons.book, 14),
    el('span', { className: 'studio-bar-label', text: '技能' }),
  ]);
  skillsBtn.addEventListener('click', () => globalEvents.emit('ui:skills-panel'));
  bar.appendChild(skillsBtn);

  shadow.appendChild(bar);

  // 监听项目切换更新显示
  globalEvents.on('ui:project-switched', (payload) => {
    const p = payload as { name: string };
    projectBtn.querySelector('.studio-bar-label')!.textContent = p.name;
  });

  return { container };
}
