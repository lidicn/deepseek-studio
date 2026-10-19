/**
 * StudioUI 项目选择器（v1.0）
 *
 * 参考豆包工作项目选择界面：
 * - 对话/工作 模式切换
 * - 项目列表（名称+路径）
 * - 创建新项目
 * - 通过本地文件夹创建项目
 * - 搜索项目
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState, callHostTool } from './studio-ui-core';
import { escapeHtml } from './sanitizer';

const pickerStyles = `
  .studio-picker-modal { width: 520px; }
  .studio-picker-mode-toggle {
    display: flex; justify-content: center; gap: 0; margin-bottom: 20px;
  }
  .studio-picker-mode-btn {
    padding: 8px 24px; border: 1px solid #e0e0e0; background: #fff;
    cursor: pointer; font-size: 14px; color: #666; transition: all 0.15s;
  }
  .studio-picker-mode-btn:first-child { border-radius: 8px 0 0 8px; }
  .studio-picker-mode-btn:last-child { border-radius: 0 8px 8px 0; border-left: none; }
  .studio-picker-mode-btn.active { background: #4D6BFE; color: #fff; border-color: #4D6BFE; font-weight: 500; }
  .studio-picker-search { margin-bottom: 12px; position: relative; }
  .studio-picker-search input { padding-left: 36px; }
  .studio-picker-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #aaa; }
  .studio-picker-list { max-height: 300px; overflow-y: auto; margin-bottom: 12px; }
  .studio-picker-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-radius: 8px; cursor: pointer; transition: all 0.15s; margin-bottom: 4px;
  }
  .studio-picker-item:hover { background: #f5f7ff; }
  .studio-picker-item.active { background: #eef1ff; }
  .studio-picker-item-icon { flex-shrink: 0; color: #4D6BFE; }
  .studio-picker-item-info { flex: 1; min-width: 0; }
  .studio-picker-item-name { font-size: 14px; font-weight: 500; color: #333; }
  .studio-picker-item-path { font-size: 11px; color: #999; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-picker-item-check { color: #4D6BFE; flex-shrink: 0; }
  .studio-picker-actions { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #f0f0f0; padding-top: 12px; }
  .studio-picker-action-btn {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: none; background: transparent; cursor: pointer; border-radius: 8px;
    font-size: 13px; color: #555; transition: all 0.15s; text-align: left;
  }
  .studio-picker-action-btn:hover { background: #f5f7ff; color: #4D6BFE; }
  .studio-picker-empty { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

export function createProjectPicker(): { container: HTMLElement; open: () => void; close: () => void } {
  const { container, shadow } = createShadowContainer('studio-project-picker-root');
  injectStyles(shadow, pickerStyles);

  let isOpen = false;
  let searchQuery = '';

  const overlay = el('div', { className: 'studio-modal-overlay', style: { display: 'none' } });
  const modal = el('div', { className: 'studio-modal studio-picker-modal' });

  // Header
  const header = el('div', { className: 'studio-modal-header' }, [
    el('h2', { className: 'studio-modal-title', text: '选择项目' }),
  ]);
  const closeBtn = el('button', { className: 'studio-close-btn' }, [icon(Icons.x, 18)]);
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body
  const body = el('div', { className: 'studio-modal-body' });

  // Mode toggle
  const modeToggle = el('div', { className: 'studio-picker-mode-toggle' });
  const chatBtn = el('button', { className: 'studio-picker-mode-btn', text: '对话' });
  const workBtn = el('button', { className: 'studio-picker-mode-btn active', text: '工作' });
  chatBtn.addEventListener('click', () => {
    chatBtn.classList.add('active');
    workBtn.classList.remove('active');
  });
  workBtn.addEventListener('click', () => {
    workBtn.classList.add('active');
    chatBtn.classList.remove('active');
  });
  modeToggle.appendChild(chatBtn);
  modeToggle.appendChild(workBtn);
  body.appendChild(modeToggle);

  // Search
  const searchBox = el('div', { className: 'studio-picker-search' });
  const searchIcon = el('span', { className: 'studio-picker-search-icon' });
  searchIcon.appendChild(icon(Icons.search, 16));
  const searchInput = el('input', { className: 'studio-input', attrs: { placeholder: '搜索项目...' } });
  searchInput.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
    renderProjectList();
  });
  searchBox.appendChild(searchIcon);
  searchBox.appendChild(searchInput);
  body.appendChild(searchBox);

  // Project list
  const projectList = el('div', { className: 'studio-picker-list' });
  body.appendChild(projectList);

  // Actions
  const actions = el('div', { className: 'studio-picker-actions' });
  const newProjectBtn = el('button', { className: 'studio-picker-action-btn' }, [
    icon(Icons.plus, 16),
    el('span', { text: '创建新项目' }),
  ]);
  newProjectBtn.addEventListener('click', () => {
    close();
    globalEvents.emit('ui:new-project');
  });
  const fromFolderBtn = el('button', { className: 'studio-picker-action-btn' }, [
    icon(Icons.folder, 16),
    el('span', { text: '通过本地文件夹创建项目' }),
  ]);
  fromFolderBtn.addEventListener('click', async () => {
    const result = await callHostTool('folder.pick', {});
    if (result.ok && result.data) {
      const folderPath = (result.data as { path: string }).path;
      const name = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? '新项目';
      await callHostTool('project.create', { name, path: folderPath });
      globalEvents.emit('ui:project-created', { id: name, name, path: folderPath });
      close();
    }
  });
  actions.appendChild(newProjectBtn);
  actions.appendChild(fromFolderBtn);
  body.appendChild(actions);

  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  shadow.appendChild(overlay);

  // 项目数据
  let projects: ProjectInfo[] = [
    { id: 'deepseek-studio', name: 'deepseek-studio', path: 'E:\\NAS\\deepseek-studio' },
  ];

  async function loadProjects(): Promise<void> {
    try {
      const result = await callHostTool('project.list', {});
      if (result.ok && result.data) {
        projects = (result.data as { projects: ProjectInfo[] }).projects;
      }
    } catch {
      // 使用默认项目
    }
    renderProjectList();
  }

  function renderProjectList(): void {
    projectList.replaceChildren();
    const filtered = projects.filter((p) =>
      !searchQuery || p.name.toLowerCase().includes(searchQuery) || p.path.toLowerCase().includes(searchQuery),
    );
    if (filtered.length === 0) {
      projectList.appendChild(el('div', { className: 'studio-picker-empty', text: searchQuery ? '没有匹配的项目' : '暂无项目' }));
      return;
    }
    for (const p of filtered) {
      const isActive = p.id === globalState.currentProject;
      const item = el('div', { className: `studio-picker-item${isActive ? ' active' : ''}` });
      // W4：p.name / p.path 经 escapeHtml 转义后再进 innerHTML
      item.innerHTML = `
        <span class="studio-picker-item-icon"></span>
        <div class="studio-picker-item-info">
          <div class="studio-picker-item-name">${escapeHtml(p.name)}</div>
          <div class="studio-picker-item-path">${escapeHtml(p.path)}</div>
        </div>
      `;
      item.querySelector('.studio-picker-item-icon')!.appendChild(icon(Icons.folder, 18));
      if (isActive) {
        const check = el('span', { className: 'studio-picker-item-check' });
        check.appendChild(icon(Icons.check, 16));
        item.appendChild(check);
      }
      item.addEventListener('click', () => {
        globalState.currentProject = p.id;
        globalEvents.emit('ui:project-switched', p);
        close();
      });
      projectList.appendChild(item);
    }
  }

  function open(): void {
    isOpen = true;
    overlay.style.display = 'flex';
    searchQuery = '';
    (searchInput as HTMLInputElement).value = '';
    loadProjects();
  }

  function close(): void {
    isOpen = false;
    overlay.style.display = 'none';
  }

  globalEvents.on('ui:project-picker', () => { isOpen ? close() : open(); });
  globalEvents.on('ui:new-project', () => { isOpen ? close() : open(); });

  return { container, open, close };
}
