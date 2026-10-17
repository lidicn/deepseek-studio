/**
 * StudioUI 左侧边栏（v2.0 · 融入式）
 *
 * v2.0 改进：不再用 fixed 定位覆盖整个网页左侧，改为：
 * - 默认收起成左上角浮动按钮（不遮挡网页原 UI）
 * - 点击按钮展开侧边栏面板（overlay 方式，带遮罩）
 * - 点击遮罩或关闭按钮收起
 * - 样式贴近 DeepSeek 网页设计语言
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState } from './studio-ui-core';

const sidebarStyles = `
  /* 浮动触发按钮 */
  .studio-fab {
    position: fixed;
    top: 12px;
    left: 12px;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: rgba(255,255,255,0.9);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(0,0,0,0.08);
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 2147483646;
    transition: all 0.2s ease;
    color: #4D6BFE;
    user-select: none;
  }
  .studio-fab:hover {
    background: #fff;
    box-shadow: 0 4px 12px rgba(77,107,254,0.2);
    transform: scale(1.05);
  }
  .studio-fab svg { width: 18px; height: 18px; }

  /* 遮罩层 */
  .studio-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.3);
    z-index: 2147483644;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s ease, visibility 0.2s ease;
  }
  .studio-overlay.visible {
    opacity: 1;
    visibility: visible;
  }

  /* 侧边栏面板 */
  .studio-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    width: 260px;
    height: 100vh;
    background: #ffffff;
    border-right: 1px solid #e8e8e8;
    display: flex;
    flex-direction: column;
    z-index: 2147483645;
    pointer-events: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    color: #333;
    overflow: hidden;
    box-shadow: 4px 0 16px rgba(0,0,0,0.1);
    transform: translateX(-100%);
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .studio-sidebar.visible {
    transform: translateX(0);
  }
  .studio-sidebar-header {
    padding: 14px 16px;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .studio-logo {
    width: 30px;
    height: 30px;
    background: linear-gradient(135deg, #4D6BFE, #7B8FFF);
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    flex-shrink: 0;
  }
  .studio-logo-text { font-weight: 600; font-size: 15px; color: #1a1a2e; flex: 1; }
  .studio-close-btn {
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: transparent; cursor: pointer;
    border-radius: 6px; color: #999; flex-shrink: 0;
    transition: all 0.15s;
  }
  .studio-close-btn:hover { background: #f5f5f5; color: #333; }
  .studio-close-btn svg { width: 16px; height: 16px; }

  .studio-nav-section {
    padding: 8px 0;
    border-bottom: 1px solid #f0f0f0;
    flex-shrink: 0;
  }
  .studio-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 16px;
    cursor: pointer;
    color: #555;
    transition: all 0.15s;
    user-select: none;
  }
  .studio-nav-item:hover { background: #f0f2ff; color: #4D6BFE; }
  .studio-nav-item svg { flex-shrink: 0; opacity: 0.7; width: 16px; height: 16px; }

  .studio-projects-section {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .studio-section-title {
    padding: 4px 16px 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: #999;
    letter-spacing: 0.5px;
  }
  .studio-project-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    cursor: pointer;
    color: #555;
    transition: all 0.15s;
    border-left: 2px solid transparent;
    user-select: none;
  }
  .studio-project-item:hover { background: #f0f2ff; }
  .studio-project-item.active {
    background: #eef1ff;
    color: #4D6BFE;
    border-left-color: #4D6BFE;
    font-weight: 500;
  }
  .studio-project-item svg { width: 14px; height: 14px; flex-shrink: 0; }
  .studio-project-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-project-path { font-size: 11px; color: #aaa; padding: 0 16px 4px 42px; }

  .studio-sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .studio-user-avatar {
    width: 32px; height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 600; font-size: 13px; flex-shrink: 0;
  }
  .studio-user-info { flex: 1; min-width: 0; }
  .studio-user-name { font-weight: 500; font-size: 13px; color: #333; }
  .studio-user-plan { font-size: 11px; color: #999; }
  .studio-settings-btn {
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    border: none; background: transparent; cursor: pointer;
    border-radius: 6px; color: #666; flex-shrink: 0;
    transition: all 0.15s;
  }
  .studio-settings-btn:hover { background: #f0f0f0; color: #4D6BFE; }
  .studio-settings-btn svg { width: 18px; height: 18px; }

  .studio-new-project-btn {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 16px; margin: 4px 8px;
    border: 1px dashed #d0d0d0; border-radius: 6px;
    background: transparent; cursor: pointer;
    color: #888; font-size: 12px; width: calc(100% - 16px);
    transition: all 0.15s;
  }
  .studio-new-project-btn:hover { border-color: #4D6BFE; color: #4D6BFE; background: #f8f9ff; }
  .studio-new-project-btn svg { width: 14px; height: 14px; }
`;

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

export function createSidebar(): { container: HTMLElement; show: () => void; hide: () => void; toggle: () => void } {
  const { container, shadow } = createShadowContainer('studio-sidebar-root');
  injectStyles(shadow, sidebarStyles);

  let isOpen = false;

  // 浮动触发按钮
  const fab = el('button', { className: 'studio-fab', attrs: { title: 'Studio 面板' } }, [
    icon(Icons.folder, 18),
  ]);

  // 遮罩层
  const overlay = el('div', { className: 'studio-overlay' });

  // 侧边栏面板
  const sidebar = el('div', { className: 'studio-sidebar' });

  // Header
  const header = el('div', { className: 'studio-sidebar-header' }, [
    el('div', { className: 'studio-logo', text: 'S' }),
    el('span', { className: 'studio-logo-text', text: 'Studio' }),
  ]);
  const closeBtn = el('button', { className: 'studio-close-btn', attrs: { title: '关闭' } }, [icon(Icons.x, 16)]);
  header.appendChild(closeBtn);
  sidebar.appendChild(header);

  // Nav section
  const navSection = el('div', { className: 'studio-nav-section' });
  const navItems = [
    { icon: Icons.plus, label: '新工作任务', action: () => { hide(); globalEvents.emit('ui:new-task'); } },
    { icon: Icons.clock, label: '定时任务', action: () => { hide(); globalEvents.emit('ui:scheduled-tasks'); } },
    { icon: Icons.puzzle, label: '插件·技能·伙伴', action: () => { hide(); globalEvents.emit('ui:skills'); } },
  ];
  for (const item of navItems) {
    const navItem = el('div', { className: 'studio-nav-item' }, [
      icon(item.icon, 16),
      el('span', { text: item.label }),
    ]);
    navItem.addEventListener('click', item.action);
    navSection.appendChild(navItem);
  }
  sidebar.appendChild(navSection);

  // Projects section
  const projectsSection = el('div', { className: 'studio-projects-section' });
  projectsSection.appendChild(el('div', { className: 'studio-section-title', text: '项目' }));

  const projectList = el('div', { className: 'studio-project-list' });
  projectsSection.appendChild(projectList);

  const newProjectBtn = el('button', { className: 'studio-new-project-btn' }, [
    icon(Icons.plus, 14),
    el('span', { text: '创建新项目' }),
  ]);
  newProjectBtn.addEventListener('click', () => { hide(); globalEvents.emit('ui:new-project'); });
  projectsSection.appendChild(newProjectBtn);

  sidebar.appendChild(projectsSection);

  // Footer
  const footer = el('div', { className: 'studio-sidebar-footer' }, [
    el('div', { className: 'studio-user-avatar', text: 'U' }),
    el('div', { className: 'studio-user-info' }, [
      el('div', { className: 'studio-user-name', text: '用户' }),
      el('div', { className: 'studio-user-plan', text: 'Studio v1.0' }),
    ]),
  ]);
  const settingsBtn = el('button', { className: 'studio-settings-btn' }, [icon(Icons.settings, 18)]);
  settingsBtn.addEventListener('click', () => { hide(); globalEvents.emit('ui:settings'); });
  footer.appendChild(settingsBtn);
  sidebar.appendChild(footer);

  shadow.appendChild(fab);
  shadow.appendChild(overlay);
  shadow.appendChild(sidebar);

  function show(): void {
    isOpen = true;
    sidebar.classList.add('visible');
    overlay.classList.add('visible');
  }

  function hide(): void {
    isOpen = false;
    sidebar.classList.remove('visible');
    overlay.classList.remove('visible');
  }

  function toggle(): void {
    if (isOpen) hide();
    else show();
  }

  fab.addEventListener('click', toggle);
  overlay.addEventListener('click', hide);
  closeBtn.addEventListener('click', hide);

  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) hide();
  });

  // 渲染项目列表
  function renderProjects(projects: ProjectInfo[], currentId: string | null): void {
    projectList.replaceChildren();
    for (const p of projects) {
      const item = el('div', { className: `studio-project-item${p.id === currentId ? ' active' : ''}` }, [
        icon(Icons.folder, 14),
        el('span', { className: 'studio-project-name', text: p.name }),
      ]);
      item.addEventListener('click', () => {
        globalState.currentProject = p.id;
        globalEvents.emit('ui:project-switched', p);
        renderProjects(projects, p.id);
        hide();
      });
      projectList.appendChild(item);
      if (p.path) {
        projectList.appendChild(el('div', { className: 'studio-project-path', text: p.path }));
      }
    }
  }

  // 初始项目列表
  const defaultProjects: ProjectInfo[] = [
    { id: 'deepseek-studio', name: 'deepseek-studio', path: 'E:\\NAS\\deepseek-studio' },
  ];
  renderProjects(defaultProjects, globalState.currentProject ?? 'deepseek-studio');

  // 监听项目列表更新
  globalEvents.on('ui:projects-updated', (payload) => {
    const data = payload as { projects: ProjectInfo[]; current: string | null };
    renderProjects(data.projects, data.current);
  });

  return {
    container,
    show,
    hide,
    toggle,
  };
}
