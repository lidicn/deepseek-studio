/**
 * StudioUI 左侧边栏（v1.0）
 *
 * 参考豆包工作左侧栏布局：
 * - 顶部导航：新工作任务、定时任务、插件·技能·伙伴
 * - 项目列表：可切换项目
 * - 底部：用户信息 + 设置按钮
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState } from './studio-ui-core';

const sidebarStyles = `
  .studio-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    width: 240px;
    height: 100vh;
    background: #fafbfc;
    border-right: 1px solid #e8e8e8;
    display: flex;
    flex-direction: column;
    z-index: 2147483645;
    pointer-events: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    color: #333;
    overflow: hidden;
    box-shadow: 2px 0 8px rgba(0,0,0,0.05);
  }
  .studio-sidebar-header {
    padding: 12px 16px;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .studio-logo {
    width: 28px;
    height: 28px;
    background: linear-gradient(135deg, #4D6BFE, #7B8FFF);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
  }
  .studio-logo-text { font-weight: 600; font-size: 15px; color: #1a1a2e; }
  .studio-nav-section {
    padding: 8px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .studio-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    cursor: pointer;
    color: #555;
    transition: all 0.15s;
    user-select: none;
  }
  .studio-nav-item:hover { background: #f0f2ff; color: #4D6BFE; }
  .studio-nav-item svg { flex-shrink: 0; opacity: 0.7; }
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
    padding: 7px 16px;
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
  .studio-project-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-project-path { font-size: 11px; color: #aaa; padding: 0 16px 4px 42px; }
  .studio-sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .studio-user-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    flex-shrink: 0;
  }
  .studio-user-info { flex: 1; min-width: 0; }
  .studio-user-name { font-weight: 500; font-size: 13px; color: #333; }
  .studio-user-plan { font-size: 11px; color: #999; }
  .studio-settings-btn {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 6px;
    color: #666;
    flex-shrink: 0;
  }
  .studio-settings-btn:hover { background: #f0f0f0; color: #4D6BFE; }
  .studio-new-project-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    margin: 4px 8px;
    border: 1px dashed #d0d0d0;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    color: #888;
    font-size: 12px;
    width: calc(100% - 16px);
    transition: all 0.15s;
  }
  .studio-new-project-btn:hover { border-color: #4D6BFE; color: #4D6BFE; background: #f8f9ff; }
`;

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

export function createSidebar(): { container: HTMLElement; show: () => void; hide: () => void } {
  const { container, shadow } = createShadowContainer('studio-sidebar-root');
  injectStyles(shadow, sidebarStyles);

  const sidebar = el('div', { className: 'studio-sidebar' });

  // Header
  const header = el('div', { className: 'studio-sidebar-header' }, [
    el('div', { className: 'studio-logo', text: 'S' }),
    el('span', { className: 'studio-logo-text', text: 'Studio' }),
  ]);
  sidebar.appendChild(header);

  // Nav section
  const navSection = el('div', { className: 'studio-nav-section' });
  const navItems = [
    { icon: Icons.plus, label: '新工作任务', action: () => globalEvents.emit('ui:new-task') },
    { icon: Icons.clock, label: '定时任务', action: () => globalEvents.emit('ui:scheduled-tasks') },
    { icon: Icons.puzzle, label: '插件·技能·伙伴', action: () => globalEvents.emit('ui:skills') },
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
  newProjectBtn.addEventListener('click', () => globalEvents.emit('ui:new-project'));
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
  settingsBtn.addEventListener('click', () => globalEvents.emit('ui:settings'));
  footer.appendChild(settingsBtn);
  sidebar.appendChild(footer);

  shadow.appendChild(sidebar);

  // 渲染项目列表
  function renderProjects(projects: ProjectInfo[], currentId: string | null): void {
    projectList.innerHTML = '';
    for (const p of projects) {
      const item = el('div', { className: `studio-project-item${p.id === currentId ? ' active' : ''}` }, [
        icon(Icons.folder, 14),
        el('span', { className: 'studio-project-name', text: p.name }),
      ]);
      item.addEventListener('click', () => {
        globalState.currentProject = p.id;
        globalEvents.emit('ui:project-switched', p);
        renderProjects(projects, p.id);
      });
      projectList.appendChild(item);
      if (p.path) {
        projectList.appendChild(el('div', { className: 'studio-project-path', text: p.path }));
      }
    }
  }

  // 初始项目列表（从配置读取，暂时用默认项目）
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
    show: () => { container.style.display = 'block'; },
    hide: () => { container.style.display = 'none'; },
  };
}
