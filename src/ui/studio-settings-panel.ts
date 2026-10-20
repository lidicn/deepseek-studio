/**
 * StudioUI 设置面板（v1.0）
 *
 * 模态弹窗，Tab 切换：
 * - 通用：版本信息、日志路径
 * - 工作区：当前工作区路径、修改
 * - 策略：workspace/auto/full 三选一（档位来自共享契约 PANEL_POLICY_MODES）
 * - MCP：服务器列表、添加/编辑/删除
 * - 技能：技能目录、扫描
 * - 记忆：记忆列表、删除
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState, callHostTool } from './studio-ui-core';
import { escapeHtml } from './sanitizer';
import { PANEL_POLICY_MODES, POLICY_MODE_LABELS, type PolicyMode } from '../shared/policy-contract';

const panelStyles = `
  .studio-settings-modal { width: 640px; }
  .studio-settings-tabs { display: flex; gap: 2px; border-bottom: 1px solid #f0f0f0; margin-bottom: 20px; }
  .studio-settings-tab {
    padding: 10px 16px; border: none; background: transparent; cursor: pointer;
    font-size: 13px; color: #666; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .studio-settings-tab.active { color: #4D6BFE; border-bottom-color: #4D6BFE; font-weight: 500; }
  .studio-tab-content { display: none; }
  .studio-tab-content.active { display: block; }
  .studio-info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f5f5f5; font-size: 13px; }
  .studio-info-label { color: #888; }
  .studio-info-value { color: #333; font-family: monospace; font-size: 12px; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
  .studio-workspace-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .studio-workspace-input { flex: 1; }
  .studio-policy-options { display: flex; flex-direction: column; gap: 8px; }
  .studio-policy-option {
    display: flex; align-items: flex-start; gap: 10px; padding: 12px;
    border: 1px solid #e8e8e8; border-radius: 8px; cursor: pointer; transition: all 0.15s;
  }
  .studio-policy-option:hover { border-color: #c5d0ff; background: #f8f9ff; }
  .studio-policy-option.selected { border-color: #4D6BFE; background: #f0f3ff; }
  .studio-policy-radio { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #ccc; margin-top: 1px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .studio-policy-option.selected .studio-policy-radio { border-color: #4D6BFE; }
  .studio-policy-option.selected .studio-policy-radio::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #4D6BFE; }
  .studio-policy-title { font-weight: 500; font-size: 13px; color: #333; margin-bottom: 2px; }
  .studio-policy-desc { font-size: 12px; color: #888; }
  .studio-mcp-server-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 8px;
  }
  .studio-mcp-server-info { flex: 1; min-width: 0; }
  .studio-mcp-server-name { font-weight: 500; font-size: 13px; color: #333; }
  .studio-mcp-transport {
    display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 4px;
    font-size: 10px; font-weight: 600; vertical-align: middle;
    background: #eef2ff; color: #4D6BFE; border: 1px solid #dbe3ff;
  }
  .studio-mcp-server-cmd { font-size: 11px; color: #999; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-mcp-server-actions { display: flex; gap: 4px; }
  .studio-mcp-add-btn { width: 100%; padding: 10px; border: 1px dashed #d0d0d0; border-radius: 8px; background: transparent; cursor: pointer; color: #888; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .studio-mcp-add-btn:hover { border-color: #4D6BFE; color: #4D6BFE; }
  .studio-memory-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px; border-bottom: 1px solid #f5f5f5; }
  .studio-memory-type { flex-shrink: 0; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .studio-memory-type.user { background: #e3f2fd; color: #1565c0; }
  .studio-memory-type.project { background: #f3e5f5; color: #7b1fa2; }
  .studio-memory-content { flex: 1; min-width: 0; }
  .studio-memory-name { font-size: 13px; font-weight: 500; color: #333; margin-bottom: 2px; }
  .studio-memory-text { font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .studio-empty-state { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;

export function createSettingsPanel(): { container: HTMLElement; open: () => void; close: () => void } {
  const { container, shadow } = createShadowContainer('studio-settings-root');
  injectStyles(shadow, panelStyles);

  let isOpen = false;

  const overlay = el('div', { className: 'studio-modal-overlay', style: { display: 'none' } });
  const modal = el('div', { className: 'studio-modal studio-settings-modal' });

  // Header
  const header = el('div', { className: 'studio-modal-header' }, [
    el('h2', { className: 'studio-modal-title', text: 'Studio 设置' }),
  ]);
  const closeBtn = el('button', { className: 'studio-close-btn' }, [icon(Icons.x, 18)]);
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body
  const body = el('div', { className: 'studio-modal-body' });

  // Tabs
  const tabs = el('div', { className: 'studio-settings-tabs' });
  const tabDefs = [
    { id: 'general', label: '通用' },
    { id: 'workspace', label: '工作区' },
    { id: 'policy', label: '策略' },
    { id: 'mcp', label: 'MCP' },
    { id: 'skills', label: '技能' },
    { id: 'memory', label: '记忆' },
    { id: 'leverhub', label: '投喂' },
  ];
  const tabContents: Record<string, HTMLElement> = {};

  for (const tabDef of tabDefs) {
    const tabBtn = el('button', { className: `studio-settings-tab${tabDef.id === 'general' ? ' active' : ''}`, text: tabDef.label });
    tabBtn.addEventListener('click', () => {
      tabs.querySelectorAll('.studio-settings-tab').forEach((t) => t.classList.remove('active'));
      tabBtn.classList.add('active');
      Object.values(tabContents).forEach((c) => c.classList.remove('active'));
      tabContents[tabDef.id].classList.add('active');
    });
    tabs.appendChild(tabBtn);
  }
  body.appendChild(tabs);

  // General tab
  const generalTab = el('div', { className: 'studio-tab-content active' });
  generalTab.innerHTML = `
    <div class="studio-info-row"><span class="studio-info-label">版本</span><span class="studio-info-value">v1.0.0</span></div>
    <div class="studio-info-row"><span class="studio-info-label">日志路径</span><span class="studio-info-value">E:\\NAS\\deepseek-studio\\tauri-real.log</span></div>
    <div class="studio-info-row"><span class="studio-info-label">配置路径</span><span class="studio-info-value">~/.config/deepseek-studio/</span></div>
    <div class="studio-info-row"><span class="studio-info-label">宿主端口</span><span class="studio-info-value">8760</span></div>
  `;
  tabContents['general'] = generalTab;
  body.appendChild(generalTab);

  // Workspace tab
  const workspaceTab = el('div', { className: 'studio-tab-content' });
  const workspaceRow = el('div', { className: 'studio-workspace-row' });
  const workspaceInput = el('input', { className: 'studio-input studio-workspace-input', attrs: { value: globalState.workspaceRoot ?? '', placeholder: '工作区根目录路径，如 E:/NAS' } });
  const workspaceSaveBtn = el('button', { className: 'studio-btn primary sm', text: '保存' });
  const workspaceHint = el('p', { className: 'studio-form-hint', text: '工作区是工具操作的根目录。文件读写和命令执行默认限制在此目录内。' });
  workspaceSaveBtn.addEventListener('click', async () => {
    const root = (workspaceInput as HTMLInputElement).value.trim();
    const result = await callHostTool('workspace.set', { root });
    if (result.ok) {
      const saved = (result.data as { root?: string } | undefined)?.root ?? root;
      (workspaceInput as HTMLInputElement).value = saved;
      globalState.workspaceRoot = saved;
      workspaceHint.textContent = '已保存到配置文件，重启后仍然生效。';
      workspaceSaveBtn.textContent = '已保存';
      setTimeout(() => { workspaceSaveBtn.textContent = '保存'; }, 1500);
    } else {
      // 失败必须可见：原实现只在 ok 分支更新按钮，失败时界面毫无反应，看起来像"点了没反应"。
      workspaceHint.textContent = `保存失败：${result.error ?? '未知错误'}`;
      workspaceSaveBtn.textContent = '保存失败';
      setTimeout(() => { workspaceSaveBtn.textContent = '保存'; }, 2000);
    }
  });
  workspaceRow.appendChild(workspaceInput);
  workspaceRow.appendChild(workspaceSaveBtn);
  workspaceTab.appendChild(workspaceRow);
  workspaceTab.appendChild(workspaceHint);
  tabContents['workspace'] = workspaceTab;
  body.appendChild(workspaceTab);

  // Policy tab
  const policyTab = el('div', { className: 'studio-tab-content' });
  const policyOptions = el('div', { className: 'studio-policy-options' });
  // 档位只遍历共享契约 PANEL_POLICY_MODES（workspace/auto/full），标题取 POLICY_MODE_LABELS；
  // 后端旧档「询问审批」不在面板暴露。desc 为面板侧说明文案。
  const policyDesc: Record<(typeof PANEL_POLICY_MODES)[number], string> = {
    workspace: '文件读写与命令执行仅限工作区根目录，越界一律拒绝。最收敛。',
    auto: '低风险操作自动执行，高风险操作弹出确认。默认档。',
    full: '所有工具调用自动执行，无需确认。适合完全信任的环境。',
  };
  for (const mode of PANEL_POLICY_MODES) {
    const option = el('div', { className: `studio-policy-option${mode === globalState.policyMode ? ' selected' : ''}`, attrs: { 'data-mode': mode } });
    option.innerHTML = `<div class="studio-policy-radio"></div><div><div class="studio-policy-title">${escapeHtml(POLICY_MODE_LABELS[mode])}</div><div class="studio-policy-desc">${escapeHtml(policyDesc[mode])}</div></div>`;
    option.addEventListener('click', async () => {
      policyOptions.querySelectorAll('.studio-policy-option').forEach((o) => o.classList.remove('selected'));
      option.classList.add('selected');
      const chosen: PolicyMode = mode;
      globalState.policyMode = chosen;
      const r = await callHostTool('policy.set', { mode: chosen });
      if (!r.ok) {
        // 回滚选中态并提示，避免"看着选上了其实没存"
        option.classList.remove('selected');
        policyHint.textContent = `保存失败：${r.error ?? '未知错误'}`;
        globalState.policyMode = (r.data as { mode?: PolicyMode } | undefined)?.mode ?? globalState.policyMode;
      } else {
        policyHint.textContent = `已保存：${POLICY_MODE_LABELS[chosen]}。重启后仍然生效。`;
      }
    });
    policyOptions.appendChild(option);
  }
  policyTab.appendChild(policyOptions);
  const policyHint = el('p', { className: 'studio-form-hint', text: '' });
  policyTab.appendChild(policyHint);
  tabContents['policy'] = policyTab;
  body.appendChild(policyTab);

  // MCP tab
  const mcpTab = el('div', { className: 'studio-tab-content' });
  const mcpServerList = el('div', { className: 'studio-mcp-server-list' });
  const mcpError = el('p', { className: 'studio-form-hint', text: '' });
  const mcpAddBtn = el('button', { className: 'studio-mcp-add-btn' }, [icon(Icons.plus, 16), el('span', { text: '添加 MCP 服务器' })]);
  mcpAddBtn.addEventListener('click', () => globalEvents.emit('ui:mcp-add'));
  mcpTab.appendChild(mcpServerList);
  mcpTab.appendChild(mcpError);
  mcpTab.appendChild(mcpAddBtn);

  function renderMcpServers(): void {
    mcpServerList.replaceChildren();
    if (globalState.mcpServers.length === 0) {
      mcpServerList.appendChild(el('div', { className: 'studio-empty-state', text: '暂无配置的 MCP 服务器' }));
      return;
    }
    for (const serverId of globalState.mcpServers) {
      const item = el('div', { className: 'studio-mcp-server-item' });
      // 传输类型与目标取自宿主回传的真实配置。原实现把这段写死成 "stdio"，
      // 所以 HTTP 服务器在列表里永远显示 stdio。
      const cfg = globalState.mcpConfigs.find((c) => c.id === serverId);
      const transport = (cfg?.transport ?? 'stdio').toUpperCase();
      const target = cfg?.url || cfg?.command || '';
      // W4：全部经 escapeHtml 转义
      item.innerHTML = `
        <div class="studio-mcp-server-info">
          <div class="studio-mcp-server-name">${escapeHtml(serverId)} <span class="studio-mcp-transport">${escapeHtml(transport)}</span></div>
          <div class="studio-mcp-server-cmd">${escapeHtml(target)}</div>
        </div>
        <div class="studio-mcp-server-actions"></div>
      `;
      const actions = item.querySelector('.studio-mcp-server-actions')!;
      const editBtn = el('button', { className: 'studio-btn sm' }, [icon(Icons.edit, 12)]);
      editBtn.addEventListener('click', () => globalEvents.emit('ui:mcp-edit', serverId));
      const delBtn = el('button', { className: 'studio-btn sm danger' }, [icon(Icons.trash, 12)]);
      delBtn.addEventListener('click', async () => {
        const r = await callHostTool('mcp.remove', { serverId });
        if (!r.ok) {
          mcpError.textContent = `删除失败：${r.error ?? '未知错误'}`;
          return;
        }
        mcpError.textContent = '';
        globalState.mcpServers = globalState.mcpServers.filter((s) => s !== serverId);
        renderMcpServers();
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      mcpServerList.appendChild(item);
    }
  }
  renderMcpServers();
  tabContents['mcp'] = mcpTab;
  body.appendChild(mcpTab);

  // Skills tab
  const skillsTab = el('div', { className: 'studio-tab-content' });
  const skillsDirRow = el('div', { className: 'studio-workspace-row' });
  const skillsDirInput = el('input', { className: 'studio-input studio-workspace-input', attrs: { placeholder: '技能目录路径（留空用默认 ~/.agents/skills）' } });
  const skillsScanBtn = el('button', { className: 'studio-btn primary sm', text: '扫描' });

  async function loadSkills(): Promise<void> {
    const dir = (skillsDirInput as HTMLInputElement).value.trim();
    const result = await callHostTool('skill.list', dir ? { dir } : {});
    if (result.ok && result.data) {
      const data = result.data as { dir?: string; skills: Array<{ id: string; name: string; description: string }> };
      // 回填解析后的真实目录，让用户看到扫描的是哪里。
      if (typeof data.dir === 'string' && data.dir) (skillsDirInput as HTMLInputElement).value = data.dir;
      globalState.skills = data.skills ?? [];
      renderSkillsList();
    }
  }
  skillsScanBtn.addEventListener('click', () => void loadSkills());
  skillsDirRow.appendChild(skillsDirInput);
  skillsDirRow.appendChild(skillsScanBtn);
  skillsTab.appendChild(skillsDirRow);
  const skillsList = el('div', { className: 'studio-skills-list' });
  skillsTab.appendChild(skillsList);

  function renderSkillsList(): void {
    skillsList.replaceChildren();
    if (globalState.skills.length === 0) {
      skillsList.appendChild(el('div', { className: 'studio-empty-state', text: '暂无技能，点击扫描按钮扫描技能目录' }));
      return;
    }
    for (const skill of globalState.skills) {
      const item = el('div', { className: 'studio-mcp-server-item' });
      // W4：skill.name / description 经 escapeHtml 转义
      item.innerHTML = `
        <div class="studio-mcp-server-info">
          <div class="studio-mcp-server-name">${escapeHtml(skill.name)}</div>
          <div class="studio-mcp-server-cmd">${escapeHtml(skill.description)}</div>
        </div>
      `;
      skillsList.appendChild(item);
    }
  }
  renderSkillsList();
  tabContents['skills'] = skillsTab;
  body.appendChild(skillsTab);

  // Memory tab
  const memoryTab = el('div', { className: 'studio-tab-content' });
  const memoryList = el('div', { className: 'studio-memory-list' });
  memoryTab.appendChild(memoryList);

  function renderMemories(): void {
    memoryList.replaceChildren();
    if (globalState.memories.length === 0) {
      memoryList.appendChild(el('div', { className: 'studio-empty-state', text: '暂无保存的记忆' }));
      return;
    }
    for (const mem of globalState.memories) {
      const item = el('div', { className: 'studio-memory-item' });
      // W4：mem.type / name / content 经 escapeHtml 转义
      item.innerHTML = `
        <span class="studio-memory-type ${escapeHtml(mem.type)}">${escapeHtml(mem.type)}</span>
        <div class="studio-memory-content">
          <div class="studio-memory-name">${escapeHtml(mem.name)}</div>
          <div class="studio-memory-text">${escapeHtml(mem.content)}</div>
        </div>
      `;
      const delBtn = el('button', { className: 'studio-btn sm danger' }, [icon(Icons.trash, 12)]);
      delBtn.addEventListener('click', async () => {
        await callHostTool('memory.delete', { id: mem.id });
        globalState.memories = globalState.memories.filter((m) => m.id !== mem.id);
        renderMemories();
      });
      item.appendChild(delBtn);
      memoryList.appendChild(item);
    }
  }
  renderMemories();
  tabContents['memory'] = memoryTab;
  body.appendChild(memoryTab);

  // Lever-Hub tab（v0.15：MiMo 投喂）
  const leverTab = el('div', { className: 'studio-tab-content' });
  leverTab.innerHTML = `
    <div class="studio-info-row"><span class="studio-info-label">服务</span><span class="studio-info-value">http://127.0.0.1:8762</span></div>
    <div class="studio-info-row"><span class="studio-info-label">状态</span><span class="studio-info-value" id="lh-status">检测中…</span></div>
  `;
  const lhAppList = el('div', { className: 'studio-memory-list', attrs: { style: 'max-height:240px;overflow:auto;margin:12px 0' } });
  leverTab.appendChild(lhAppList);

  const lhRefresh = el('button', { className: 'studio-btn sm', text: '刷新申请单' });
  leverTab.appendChild(lhRefresh);

  async function loadLeverHub(): Promise<void> {
    try {
      const h = await fetch('http://127.0.0.1:8762/healthz').then((r) => r.json());
      leverTab.querySelector('#lh-status')!.textContent = h.ok ? '运行中' : '异常';
      const data = await fetch('http://127.0.0.1:8762/v1/applications').then((r) => r.json());
      lhAppList.replaceChildren();
      for (const app of data.applications.slice(0, 20)) {
        const row = el('div', { className: 'studio-memory-item' });
        // W4：app.name 走 textContent，不进 innerHTML 插值
        const content = document.createElement('div');
        content.className = 'studio-memory-content';
        const nameEl = document.createElement('div');
        nameEl.className = 'studio-memory-name';
        nameEl.textContent = app.name ?? '';
        const sizeEl = document.createElement('div');
        sizeEl.className = 'studio-memory-text';
        sizeEl.textContent = `${Math.round(app.size / 10) / 100} KB`;
        content.appendChild(nameEl);
        content.appendChild(sizeEl);
        row.appendChild(content);
        lhAppList.appendChild(row);
      }
    } catch {
      leverTab.querySelector('#lh-status')!.textContent = '未启动';
    }
  }
  lhRefresh.addEventListener('click', () => void loadLeverHub());
  tabContents['leverhub'] = leverTab;
  body.appendChild(leverTab);

  modal.appendChild(body);

  // Footer
  const footer = el('div', { className: 'studio-modal-footer' });
  const doneBtn = el('button', { className: 'studio-btn primary', text: '完成' });
  doneBtn.addEventListener('click', close);
  footer.appendChild(doneBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  // 点击弹窗外空白处**不**关闭：面板里有输入框/多 Tab，误点即关会丢操作。
  // 关闭只走右上角 × 或底部「完成」。
  shadow.appendChild(overlay);

  /**
   * 从宿主读回**真实生效**的设置。
   * 原实现只渲染 globalState（出厂默认值），面板每次打开都显示 "E:\" + "auto"，
   * 用户改完再打开又看到旧值，看起来就是"设置没保存"。真相源在宿主，必须每次读。
   */
  async function loadSettings(): Promise<void> {
    const r = await callHostTool('settings.get', {});
    if (!r.ok || !r.data) return;
    const data = r.data as {
      workspaceRoot?: string | null;
      policyMode?: PolicyMode;
      mcpServers?: string[];
    };
    if (typeof data.workspaceRoot === 'string' && data.workspaceRoot) {
      (workspaceInput as HTMLInputElement).value = data.workspaceRoot;
      globalState.workspaceRoot = data.workspaceRoot;
    }
    if (data.policyMode) {
      globalState.policyMode = data.policyMode;
      policyOptions.querySelectorAll<HTMLElement>('.studio-policy-option').forEach((o) => {
        o.classList.toggle('selected', o.dataset.mode === data.policyMode);
      });
    }
    if (Array.isArray(data.mcpServers)) {
      globalState.mcpServers = [...data.mcpServers];
      renderMcpServers();
    }
    // 单独再拉一次带 configs 的列表（settings.get 只给 id 列表）。
    const mcp = await callHostTool('mcp.list', {});
    if (mcp.ok && mcp.data) {
      const md = mcp.data as {
        servers?: string[];
        configs?: Array<{ id: string; transport: 'stdio' | 'http' | 'sse'; url?: string; command?: string; args?: string[] }>;
      };
      if (Array.isArray(md.servers)) globalState.mcpServers = [...md.servers];
      if (Array.isArray(md.configs)) globalState.mcpConfigs = md.configs;
      renderMcpServers();
    }
  }

  function open(): void {
    isOpen = true;
    overlay.style.display = 'flex';
    renderMcpServers();
    void loadSettings();
    void loadSkills();
    renderMemories();
    void loadLeverHub();
  }

  function close(): void {
    isOpen = false;
    overlay.style.display = 'none';
  }

  // 监听全局事件
  globalEvents.on('ui:settings', () => { isOpen ? close() : open(); });

  return { container, open, close };
}
