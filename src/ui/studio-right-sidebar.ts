/**
 * StudioUI 右侧边栏（v1.0）
 *
 * 参考豆包工作右侧栏：
 * - 对话产物（本次对话生成/修改的文件）
 * - 后台任务（正在执行的工具调用）
 * - 任务规划（Agent 任务分解）
 * - 技能列表
 * - 最近文件
 *
 * 默认折叠，可通过按钮展开/收起。
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState } from './studio-ui-core';

const sidebarStyles = `
  .studio-right-sidebar {
    position: fixed; top: 0; right: 0; width: 280px; height: 100vh;
    background: #fafbfc; border-left: 1px solid #e8e8e8;
    display: flex; flex-direction: column; z-index: 2147482000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px; color: #333;
    transform: translateX(100%); transition: transform 0.25s ease;
  }
  .studio-right-sidebar.open { transform: translateX(0); }
  .studio-right-toggle {
    position: fixed; top: 50%; right: 0; transform: translateY(-50%);
    width: 24px; height: 48px; background: #4D6BFE; border: none;
    border-radius: 8px 0 0 8px; cursor: pointer; z-index: 2147481999;
    display: flex; align-items: center; justify-content: center; color: #fff;
    transition: all 0.25s ease;
  }
  .studio-right-toggle:hover { background: #3a58e8; }
  .studio-right-sidebar.open ~ .studio-right-toggle { right: 280px; }
  .studio-right-header {
    padding: 12px 16px; border-bottom: 1px solid #f0f0f0;
    display: flex; align-items: center; justify-content: space-between;
  }
  .studio-right-title { font-weight: 600; font-size: 14px; color: #1a1a2e; }
  .studio-right-body { flex: 1; overflow-y: auto; }
  .studio-right-section { padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
  .studio-right-section-title {
    padding: 0 16px 8px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; color: #999; letter-spacing: 0.5px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .studio-right-section-count {
    background: #e8edff; color: #4D6BFE; padding: 1px 6px;
    border-radius: 8px; font-size: 10px; font-weight: 500;
  }
  .studio-right-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 16px;
    cursor: pointer; transition: background 0.15s;
  }
  .studio-right-item:hover { background: #f0f2ff; }
  .studio-right-item-icon { flex-shrink: 0; color: #666; }
  .studio-right-item-info { flex: 1; min-width: 0; }
  .studio-right-item-name { font-size: 12px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-right-item-meta { font-size: 10px; color: #999; margin-top: 1px; }
  .studio-right-empty { padding: 12px 16px; font-size: 12px; color: #bbb; }
  .studio-task-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 16px;
  }
  .studio-task-status {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    animation: pulse 1.5s infinite;
  }
  .studio-task-status.running { background: #4D6BFE; }
  .studio-task-status.done { background: #4caf50; animation: none; }
  .studio-task-status.error { background: #f44336; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .studio-task-name { flex: 1; font-size: 12px; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-skill-tag {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 8px; background: #f0f2ff; border-radius: 10px;
    font-size: 11px; color: #4D6BFE; margin: 2px;
  }
  .studio-skills-tags { padding: 0 16px; display: flex; flex-wrap: wrap; gap: 4px; }
`;

export interface ArtifactItem {
  name: string;
  path: string;
  type: 'file' | 'folder';
  modified: string;
}

export interface TaskItem {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
}

export function createRightSidebar(): { container: HTMLElement; toggle: HTMLElement; show: () => void; hide: () => void; addArtifact: (item: ArtifactItem) => void; addTask: (task: TaskItem) => void; updateTask: (id: string, status: TaskItem['status']) => void } {
  const { container, shadow } = createShadowContainer('studio-right-sidebar-root');
  injectStyles(shadow, sidebarStyles);

  let isOpen = false;
  const artifacts: ArtifactItem[] = [];
  const tasks: TaskItem[] = [];

  const sidebar = el('div', { className: 'studio-right-sidebar' });

  // Header
  const header = el('div', { className: 'studio-right-header' }, [
    el('span', { className: 'studio-right-title', text: '工作台' }),
  ]);
  const collapseBtn = el('button', { className: 'studio-close-btn' }, [icon(Icons.chevronRight, 16)]);
  collapseBtn.addEventListener('click', hide);
  header.appendChild(collapseBtn);
  sidebar.appendChild(header);

  // Body
  const body = el('div', { className: 'studio-right-body' });

  // 对话产物
  const artifactSection = el('div', { className: 'studio-right-section' });
  const artifactTitle = el('div', { className: 'studio-right-section-title' });
  artifactTitle.innerHTML = `<span>对话产物</span><span class="studio-right-section-count" id="artifact-count">0</span>`;
  artifactSection.appendChild(artifactTitle);
  const artifactList = el('div', { className: 'studio-artifact-list' });
  artifactSection.appendChild(artifactList);
  body.appendChild(artifactSection);

  // 后台任务
  const taskSection = el('div', { className: 'studio-right-section' });
  const taskTitle = el('div', { className: 'studio-right-section-title' });
  taskTitle.innerHTML = `<span>后台任务</span><span class="studio-right-section-count" id="task-count">0</span>`;
  taskSection.appendChild(taskTitle);
  const taskList = el('div', { className: 'studio-task-list' });
  taskSection.appendChild(taskList);
  body.appendChild(taskSection);

  // 技能
  const skillSection = el('div', { className: 'studio-right-section' });
  const skillTitle = el('div', { className: 'studio-right-section-title' });
  skillTitle.innerHTML = `<span>已启用技能</span>`;
  skillSection.appendChild(skillTitle);
  const skillTags = el('div', { className: 'studio-skills-tags' });
  skillSection.appendChild(skillTags);
  body.appendChild(skillSection);

  // 元宝审计（v0.16）
  const auditSection = el('div', { className: 'studio-right-section' });
  const auditTitle = el('div', { className: 'studio-right-section-title' });
  auditTitle.innerHTML = `<span>元宝审计</span><span id="audit-state-badge" style="background:#f0f0f0;color:#888;padding:1px 6px;border-radius:8px;font-size:10px">—</span>`;
  auditSection.appendChild(auditTitle);
  const auditBodyEl = el('div', { attrs: { style: 'padding:0 16px' } });
  auditBodyEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
      <span style="color:#888">进度</span><span id="audit-rounds" style="color:#333">—</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
      <span style="color:#888">已见轮次</span><span id="audit-seen" style="color:#666">—</span>
    </div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin:8px 0">
      <button class="studio-btn sm" data-cmd="continue">继续</button>
      <button class="studio-btn sm" data-cmd="pause">暂停</button>
      <button class="studio-btn sm" data-cmd="stop">停止</button>
      <button class="studio-btn sm" data-cmd="reset">重置</button>
    </div>
    <div id="audit-log-toggle" style="font-size:11px;color:#4D6BFE;cursor:pointer;margin-bottom:4px">查看最近日志</div>
    <pre id="audit-log-box" style="display:none;max-height:140px;overflow:auto;background:#f7f7f8;border-radius:6px;padding:6px;font-size:10px;color:#646a73;white-space:pre-wrap;word-break:break-all"></pre>
  `;
  auditSection.appendChild(auditBodyEl);
  body.appendChild(auditSection);

  // 最近文件
  const recentSection = el('div', { className: 'studio-right-section' });
  recentSection.appendChild(el('div', { className: 'studio-right-section-title', text: '最近文件' }));
  const recentList = el('div', { className: 'studio-recent-list' });
  recentSection.appendChild(recentList);
  body.appendChild(recentSection);

  sidebar.appendChild(body);
  shadow.appendChild(sidebar);

  // Toggle button
  const toggle = el('button', { className: 'studio-right-toggle' });
  toggle.appendChild(icon(Icons.chevronRight, 14));
  toggle.addEventListener('click', () => { isOpen ? hide() : show(); });

  function renderArtifacts(): void {
    artifactList.replaceChildren();
    if (artifacts.length === 0) {
      artifactList.appendChild(el('div', { className: 'studio-right-empty', text: '暂无产物' }));
      return;
    }
    for (const item of artifacts.slice(-10).reverse()) {
      const row = el('div', { className: 'studio-right-item' });
      const iconEl = el('span', { className: 'studio-right-item-icon' });
      iconEl.appendChild(icon(item.type === 'folder' ? Icons.folder : Icons.file, 14));
      const info = el('div', { className: 'studio-right-item-info' });
      // W4：item.name / item.modified 走 textContent，不进 innerHTML 插值
      const nameEl = document.createElement('div');
      nameEl.className = 'studio-right-item-name';
      nameEl.textContent = item.name ?? '';
      const metaEl = document.createElement('div');
      metaEl.className = 'studio-right-item-meta';
      metaEl.textContent = item.modified ?? '';
      info.appendChild(nameEl);
      info.appendChild(metaEl);
      row.appendChild(iconEl);
      row.appendChild(info);
      row.addEventListener('click', () => globalEvents.emit('ui:open-file', item.path));
      artifactList.appendChild(row);
    }
    artifactTitle.querySelector('#artifact-count')!.textContent = String(artifacts.length);
  }

  function renderTasks(): void {
    taskList.replaceChildren();
    if (tasks.length === 0) {
      taskList.appendChild(el('div', { className: 'studio-right-empty', text: '暂无任务' }));
      return;
    }
    for (const task of tasks.slice(-10).reverse()) {
      const row = el('div', { className: 'studio-task-item' });
      row.appendChild(el('span', { className: `studio-task-status ${task.status}` }));
      row.appendChild(el('span', { className: 'studio-task-name', text: task.name }));
      taskList.appendChild(row);
    }
    taskTitle.querySelector('#task-count')!.textContent = String(tasks.length);
  }

  function renderSkills(): void {
    skillTags.replaceChildren();
    if (globalState.skills.length === 0) {
      skillTags.appendChild(el('span', { className: 'studio-right-empty', text: '暂无', style: { padding: '0' } }));
      return;
    }
    for (const skill of globalState.skills.slice(0, 8)) {
      const tag = el('span', { className: 'studio-skill-tag' });
      tag.appendChild(icon(Icons.book, 10));
      tag.appendChild(el('span', { text: skill.name }));
      skillTags.appendChild(tag);
    }
  }

  function renderRecent(): void {
    recentList.replaceChildren();
    if (artifacts.length === 0) {
      recentList.appendChild(el('div', { className: 'studio-right-empty', text: '暂无最近文件' }));
      return;
    }
    for (const item of artifacts.slice(-5).reverse()) {
      const row = el('div', { className: 'studio-right-item' });
      const iconEl = el('span', { className: 'studio-right-item-icon' });
      iconEl.appendChild(icon(Icons.file, 12));
      row.appendChild(iconEl);
      row.appendChild(el('span', { className: 'studio-right-item-name', text: item.name, style: { fontSize: '11px' } }));
      recentList.appendChild(row);
    }
  }

  // 元宝审计（v0.16）
  async function renderAudit(): Promise<void> {
    const badge = auditSection.querySelector('#audit-state-badge') as HTMLElement;
    const roundsEl = auditSection.querySelector('#audit-rounds') as HTMLElement;
    const seenEl = auditSection.querySelector('#audit-seen') as HTMLElement;
    try {
      const st = await fetch('http://127.0.0.1:8761/status').then((r) => {
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      });
      const colors: Record<string, string> = {
        running: '#e6f4ea;color:#34a853',
        paused: '#fef7e0;color:#b06000',
        stopped: '#fce8e6;color:#e5484d',
        done: '#e6f4ea;color:#34a853',
        idle: '#f0f0f0;color:#888',
      };
      badge.textContent = st.state;
      badge.style.cssText = `padding:1px 6px;border-radius:8px;font-size:10px;${colors[st.state] ?? colors.idle}`;
      roundsEl.textContent = `${st.rounds} / ${st.target}`;
      const seen = Array.isArray(st.seenRounds) ? st.seenRounds : [];
      seenEl.textContent = seen.length ? seen.join(', ') : '无';
    } catch {
      badge.textContent = '未启动';
      badge.style.cssText = 'padding:1px 6px;border-radius:8px;font-size:10px;#f0f0f0;color:#888';
      roundsEl.textContent = '—';
      seenEl.textContent = '—';
    }
  }

  auditBodyEl.querySelectorAll('button[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const command = (btn as HTMLElement).dataset.cmd;
      try {
        const r = await fetch('http://127.0.0.1:8761/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command }),
        });
        if (!r.ok) throw new Error('cmd ' + r.status);
        await renderAudit();
      } catch {
        /* 审计内核未运行 */
      }
    });
  });

  const logToggle = auditBodyEl.querySelector('#audit-log-toggle') as HTMLElement;
  const logBox = auditBodyEl.querySelector('#audit-log-box') as HTMLElement;
  logToggle.addEventListener('click', async () => {
    if (logBox.style.display !== 'none') {
      logBox.style.display = 'none';
      logToggle.textContent = '查看最近日志';
      return;
    }
    logBox.style.display = 'block';
    logToggle.textContent = '收起日志';
    try {
      const r = await fetch('http://127.0.0.1:8761/v1/audit-log?lines=15');
      const data = await r.json();
      const lines: string[] = Array.isArray(data.lines) ? data.lines : [];
      logBox.textContent = lines.length
        ? lines.map((l) => { try { return JSON.stringify(JSON.parse(l)); } catch { return l; } }).join('\n')
        : '暂无日志';
    } catch {
      logBox.textContent = '审计内核未运行';
    }
  });

  function show(): void {
    isOpen = true;
    sidebar.classList.add('open');
    toggle.querySelector('svg')?.remove();
    toggle.appendChild(icon(Icons.chevronRight, 14));
    renderArtifacts();
    renderTasks();
    renderSkills();
    renderRecent();
    void renderAudit();
  }

  function hide(): void {
    isOpen = false;
    sidebar.classList.remove('open');
  }

  function addArtifact(item: ArtifactItem): void {
    artifacts.push(item);
    if (isOpen) { renderArtifacts(); renderRecent(); }
  }

  function addTask(task: TaskItem): void {
    tasks.push(task);
    if (isOpen) renderTasks();
  }

  function updateTask(id: string, status: TaskItem['status']): void {
    const task = tasks.find((t) => t.id === id);
    if (task) {
      task.status = status;
      if (isOpen) renderTasks();
    }
  }

  // 监听全局事件
  globalEvents.on('ui:artifact-added', (payload) => addArtifact(payload as ArtifactItem));
  globalEvents.on('ui:task-added', (payload) => addTask(payload as TaskItem));
  globalEvents.on('ui:task-updated', (payload) => {
    const { id, status } = payload as { id: string; status: TaskItem['status'] };
    updateTask(id, status);
  });
  globalEvents.on('ui:skills-updated', () => { if (isOpen) renderSkills(); });

  return { container, toggle, show, hide, addArtifact, addTask, updateTask };
}
