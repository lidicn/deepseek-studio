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
  .studio-picker-hint { margin: 0 0 10px; font-size: 12px; color: #b42318; }
  .studio-picker-guide {
    display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
    border: 1px solid #ffe08a; background: #fffbe6; border-radius: 8px; margin-bottom: 12px;
  }
  .studio-picker-guide-text { flex: 1; font-size: 12px; color: #664d03; line-height: 1.5; }
  .studio-picker-guide-skip {
    border: none; background: transparent; color: #b42318; cursor: pointer;
    font-size: 12px; padding: 2px 8px; border-radius: 4px; flex-shrink: 0;
  }
  .studio-picker-guide-skip:hover { background: #fff1d6; }
  .studio-picker-create-form { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
  .studio-picker-create-form .studio-input { width: 100%; box-sizing: border-box; }
  .studio-picker-create-form-btns { display: flex; gap: 8px; align-items: center; }
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

  // 首启引导（卡②）：工作区根未设置时先说清「工作区是什么」，给出「下面创建/选择项目」
  // 的入口提示与一次「跳过」（本会话不再显示；设上工作区后自动复位）。
  // 不给工作区设任何默认值（安装目录子目录之类＝允许 AI 自改写，路线决定已否决）。
  const guide = el('div', { className: 'studio-picker-guide', attrs: { 'data-studio-workspace-guide': '1' } }, [
    el('span', {
      className: 'studio-picker-guide-text',
      text: '工作区＝AI 能读写哪个目录：文件类工具默认只能在它里面读写。下面创建一个项目并选中它，或去「Studio 设置 → 工作区与项目」直接粘贴目录路径。',
    }),
    el('button', { className: 'studio-picker-guide-skip', text: '跳过', attrs: { 'data-studio-guide-skip': '1' } }),
  ]);
  guide.hidden = true;
  const syncGuide = (): void => {
    guide.hidden = Boolean(globalState.workspaceRoot) || globalState.workspaceGuideDismissed === true;
  };
  guide.querySelector('.studio-picker-guide-skip')!.addEventListener('click', () => {
    globalState.workspaceGuideDismissed = true;
    syncGuide();
  });
  body.appendChild(guide);

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

  // 卡①：粘贴路径创建项目。接线后实况（#38 落地，2026-11-08）：
  // ① Tauri 侧未注册 dialog 插件；② 宿主另有原生选择器（src/host/folder-picker.ts，
  //    页面「打开文件夹」按钮走 WS pick-folder 在用）；③ 本按钮走的 folder.pick 工具已接入：
  //    STUDIO_PICK_FOLDER 命中即用、未设/无效回落 pickFolderViaDialog()（取消/超时返失败）。
  // 粘贴绝对路径仍是装版最可靠的创建入口；文本路径唯一可靠。
  // 旧行为「关面板＋emit ui:new-project → 重新打开同一空面板」是死循环且无输入入口。
  // 不写死任何默认项目/默认路径（2026-11-05 门禁 ui-display-truth 口径同样适用）。
  const createForm = el('div', { className: 'studio-picker-create-form', attrs: { 'data-studio-create-form': '1' } });
  createForm.hidden = true;
  const pathInput = el('input', { className: 'studio-input', attrs: { placeholder: '粘贴项目目录路径，如 D:\\dev\\my-project', 'data-studio-path-input': '1' } });
  const nameInput = el('input', { className: 'studio-input', attrs: { placeholder: '项目名（默认取路径末段，可改）', 'data-studio-name-input': '1' } });
  let nameTouched = false;
  nameInput.addEventListener('input', () => { nameTouched = true; });
  const lastSeg = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  pathInput.addEventListener('input', () => {
    // 用户没手动填过名字时，名字跟随路径末段自动补（填过就不再覆盖）。
    if (!nameTouched) nameInput.value = lastSeg(pathInput.value);
  });
  const createBtn = el('button', { className: 'studio-btn primary sm', text: '创建', attrs: { 'data-studio-create-btn': '1' } });
  const cancelCreateBtn = el('button', { className: 'studio-btn sm', text: '收起', attrs: { 'data-studio-cancel-create': '1' } });
  const formBtns = el('div', { className: 'studio-picker-create-form-btns' }, [createBtn, cancelCreateBtn]);
  createForm.appendChild(pathInput);
  createForm.appendChild(nameInput);
  createForm.appendChild(formBtns);
  body.appendChild(createForm);

  const pickerHint = el('p', { className: 'studio-picker-hint', text: '' });
  pickerHint.hidden = true;
  body.appendChild(pickerHint);

  // Actions
  const actions = el('div', { className: 'studio-picker-actions' });
  const newProjectBtn = el('button', { className: 'studio-picker-action-btn' }, [
    icon(Icons.plus, 16),
    el('span', { text: '创建新项目（粘贴路径）' }),
  ]);
  // 展开内联创建表单（不再关面板 emit ui:new-project 造成空面板死循环）；
  // 下方 `ui:new-project` 监听保留——侧边栏「新项目」按钮仍用它开面板。
  newProjectBtn.addEventListener('click', () => {
    createForm.hidden = !createForm.hidden;
    pickerHint.hidden = true;
    if (!createForm.hidden) pathInput.focus();
  });
  cancelCreateBtn.addEventListener('click', () => { createForm.hidden = true; });
  createBtn.addEventListener('click', async () => {
    const p = pathInput.value.trim().replace(/[\\/]+$/, '');
    if (!p) {
      pickerHint.hidden = false;
      pickerHint.textContent = '请先粘贴项目目录路径。';
      return;
    }
    const name = nameInput.value.trim() || lastSeg(p) || '新项目';
    pickerHint.hidden = true;
    const r = await callHostTool('project.create', { name, path: p });
    if (!r.ok) {
      pickerHint.hidden = false;
      pickerHint.textContent = `创建失败：${r.error ?? '未知错误'}`;
      return;
    }
    // 创建成功：宿主已写 projects.json，刷新列表让新项目出现（判据①），表单清空可连建
    // 「ui:project-created」死事件已删（#38 卡 A：全仓无监听方；侧栏项目区刷新走 ui:projects-updated 活链）
    await loadProjects();
    pathInput.value = '';
    nameInput.value = '';
    nameTouched = false;
  });
  const fromFolderBtn = el('button', { className: 'studio-picker-action-btn' }, [
    icon(Icons.folder, 16),
    el('span', { text: '通过本地文件夹创建项目' }),
  ]);
  fromFolderBtn.addEventListener('click', async () => {
    pickerHint.hidden = true;
    const result = await callHostTool('folder.pick', {});
    if (result.ok && result.data) {
      const folderPath = (result.data as { path: string }).path;
      const name = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? '新项目';
      await callHostTool('project.create', { name, path: folderPath });
      // 与粘贴路径同形：宿主重读并 emit「ui:projects-updated」刷新侧栏（「ui:project-created」死事件已删，#38 卡 A）
      await loadProjects();
      close();
      return;
    }
    // folder.pick 失败必须可见（原实现在这里静默什么都不发生，用户以为按钮坏了）：
    // 接线后实况（#38 落地）：folder.pick 工具＝STUDIO_PICK_FOLDER 命中即用、未设/无效回落
    // 宿主原生目录选择器（src/host/folder-picker.ts，PowerShell FolderBrowserDialog）；
    // 失败原因＝用户取消／180s 超时／无 GUI 环境 ⇒ 给用户可执行的下一步（粘贴绝对路径）。
    pickerHint.hidden = false;
    pickerHint.textContent = '未能取到文件夹（系统对话框已取消、超时或不可用）。可改用上方「创建新项目（粘贴路径）」，粘贴绝对路径创建。';
  });
  actions.appendChild(newProjectBtn);
  actions.appendChild(fromFolderBtn);
  body.appendChild(actions);

  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  shadow.appendChild(overlay);

  // 项目数据（2026-11-05 门禁 ui-display-truth）：初始为空数组——项目必须来自
  // **运行时发现**（loadProjects() → host `project.list`）或用户动作（「创建新项目」/
  // 「通过本地文件夹创建」→ folder.pick + project.create），不再写死任何默认条目
  // （写死的开发树路径对装版用户是指向不存在目录的假项目）。
  let projects: ProjectInfo[] = [];

  async function loadProjects(): Promise<void> {
    try {
      const result = await callHostTool('project.list', {});
      if (result.ok && result.data) {
        projects = (result.data as { projects: ProjectInfo[] }).projects;
        // 2026-11-05 门禁返工：默认项目已删（改空数组起步），侧边栏无宿主调用、
        // 其项目列表靠 `ui:projects-updated` 刷新（全仓唯一订阅方）——
        // picker 运行时发现后 emit，侧边栏随真实项目渲染，不再永久空白。
        globalEvents.emit('ui:projects-updated', {
          projects,
          current: globalState.currentProject ?? null,
        });
      }
    } catch {
      // 宿主不可达：维持当前列表（无写死默认项可回退，保持空）
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
      item.addEventListener('click', async () => {
        pickerHint.hidden = true;
        const result = await callHostTool('workspace.set', { root: p.path });
        if (!result.ok) {
          pickerHint.hidden = false;
          pickerHint.textContent = `切换工作区失败：${result.error ?? '未知错误'}`;
          return;
        }
        const saved = (result.data as { root?: string } | undefined)?.root ?? p.path;
        globalState.currentProject = p.id;
        globalState.workspaceRoot = saved;
        globalState.workspaceGuideDismissed = false; // 工作区已设：首启引导跳过态复位
        globalEvents.emit('ui:project-switched', p);
        globalEvents.emit('ui:workspace-changed', saved);
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
    syncGuide();
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
