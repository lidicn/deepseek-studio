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
import { createStudioControlsStore, type StudioControlsStore } from './studio-controls-store';
import type { ComposerSettingsTab } from './studio-composer-actions';

const panelStyles = `
  .studio-settings-modal { width: 760px; max-width: min(92vw, 760px); }
  .studio-settings-body { display: flex; min-height: 420px; padding: 0; }
  .studio-settings-tabs {
    width: 172px; flex: 0 0 172px; display: flex; flex-direction: column; gap: 3px;
    padding: 14px 10px; border-right: 1px solid #f0f0f0; background: #fafbfe;
  }
  .studio-settings-tab {
    width: 100%; padding: 10px 12px; border: none; border-radius: 8px;
    background: transparent; cursor: pointer; text-align: left;
    font-size: 13px; color: #666;
  }
  .studio-settings-tab:hover { background: #f0f3ff; color: #4059d6; }
  .studio-settings-tab.active { color: #4D6BFE; background: #e9eeff; font-weight: 600; }
  .studio-settings-content { flex: 1; min-width: 0; padding: 20px; overflow-y: auto; }
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
  .studio-memory-toolbar { display: flex; gap: 6px; margin-bottom: 8px; }
  .studio-memory-toolbar .studio-btn[data-active="true"] { background: #eef2ff; color: #4D6BFE; border-color: #dbe3ff; }
  .studio-memory-type { flex-shrink: 0; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .studio-memory-type.user { background: #e3f2fd; color: #1565c0; }
  .studio-memory-type.project { background: #f3e5f5; color: #7b1fa2; }
  .studio-memory-content { flex: 1; min-width: 0; }
  .studio-memory-name { font-size: 13px; font-weight: 500; color: #333; margin-bottom: 2px; }
  .studio-memory-text { font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .studio-empty-state { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;

export interface StudioSettingsPanelOptions {
  controls?: StudioControlsStore;
}

export interface StudioSettingsPanelHandle {
  container: HTMLElement;
  open(tab?: ComposerSettingsTab): void;
  close(): void;
  destroy(): void;
}

export function createSettingsPanel(options: StudioSettingsPanelOptions = {}): StudioSettingsPanelHandle {
  const { container, shadow } = createShadowContainer('studio-settings-root');
  injectStyles(shadow, panelStyles);

  let isOpen = false;
  const ownsControls = !options.controls;
  const controls = options.controls ?? createStudioControlsStore({
    call: (invocationName, params) => callHostTool(invocationName, params),
  });

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
  const body = el('div', { className: 'studio-modal-body studio-settings-body' });

  // Left navigation
  const tabs = el('div', { className: 'studio-settings-tabs' });
  const tabDefs = [
    { id: 'general', label: '通用 / 连接' },
    { id: 'workspace', label: '工作区与项目' },
    { id: 'policy', label: '审批与安全' },
    { id: 'skills', label: '技能' },
    { id: 'mcp', label: 'MCP' },
    { id: 'memory', label: '记忆与执行记录' },
    { id: 'diagnostics', label: '诊断与关于' },
  ] as const satisfies ReadonlyArray<{ id: ComposerSettingsTab; label: string }>;
  const tabContents: Record<string, HTMLElement> = {};
  const tabButtons = new Map<ComposerSettingsTab, HTMLButtonElement>();
  const contentPane = el('div', { className: 'studio-settings-content' });

  function selectTab(tabId: ComposerSettingsTab): void {
    for (const [id, button] of tabButtons) {
      button.classList.toggle('active', id === tabId);
    }
    for (const [id, content] of Object.entries(tabContents)) {
      content.classList.toggle('active', id === tabId);
    }
    if (tabId === 'policy' && typeof reloadWhitelist === 'function') void reloadWhitelist();
  }

  for (const tabDef of tabDefs) {
    const tabBtn = el('button', {
      className: `studio-settings-tab${tabDef.id === 'general' ? ' active' : ''}`,
      text: tabDef.label,
      attrs: { 'data-tab-id': tabDef.id },
    });
    tabBtn.addEventListener('click', () => selectTab(tabDef.id));
    tabButtons.set(tabDef.id, tabBtn);
    tabs.appendChild(tabBtn);
  }
  body.appendChild(tabs);
  body.appendChild(contentPane);

  // General tab
  const generalTab = el('div', { className: 'studio-tab-content active' });
  generalTab.dataset.tabPanel = 'general';
  generalTab.innerHTML = `
    <div class="studio-info-row"><span class="studio-info-label">版本</span><span class="studio-info-value">v1.0.0</span></div>
    <div class="studio-info-row"><span class="studio-info-label">日志路径</span><span class="studio-info-value">E:\\NAS\\deepseek-studio\\tauri-real.log</span></div>
    <div class="studio-info-row"><span class="studio-info-label">配置路径</span><span class="studio-info-value">~/.config/deepseek-studio/</span></div>
    <div class="studio-info-row"><span class="studio-info-label">宿主端口</span><span class="studio-info-value">8760</span></div>
  `;
  tabContents['general'] = generalTab;
  contentPane.appendChild(generalTab);

  // Workspace tab
  const workspaceTab = el('div', { className: 'studio-tab-content' });
  workspaceTab.dataset.tabPanel = 'workspace';
  const workspaceRow = el('div', { className: 'studio-workspace-row' });
  const workspaceInput = el('input', { className: 'studio-input studio-workspace-input', attrs: { value: globalState.workspaceRoot ?? '', placeholder: '工作区根目录路径，如 E:/NAS' } });
  const workspaceSaveBtn = el('button', { className: 'studio-btn primary sm', text: '保存' });
  const workspaceHint = el('p', { className: 'studio-form-hint', text: '工作区是工具操作的根目录。文件读写和命令执行默认限制在此目录内。' });
  workspaceSaveBtn.addEventListener('click', async () => {
    const root = (workspaceInput as HTMLInputElement).value.trim();
    const ok = await controls.setWorkspace(root);
    if (ok) {
      const saved = controls.getSnapshot().workspaceRoot ?? root;
      (workspaceInput as HTMLInputElement).value = saved;
      globalState.workspaceRoot = saved;
      workspaceHint.textContent = '已保存到配置文件，重启后仍然生效。';
      workspaceSaveBtn.textContent = '已保存';
      setTimeout(() => { workspaceSaveBtn.textContent = '保存'; }, 1500);
    } else {
      // 失败必须可见：原实现只在 ok 分支更新按钮，失败时界面毫无反应，看起来像"点了没反应"。
      workspaceHint.textContent = `保存失败：${controls.getSnapshot().error ?? '未知错误'}`;
      workspaceSaveBtn.textContent = '保存失败';
      setTimeout(() => { workspaceSaveBtn.textContent = '保存'; }, 2000);
    }
  });
  const projectPickerBtn = el('button', { className: 'studio-btn sm', text: '选择项目' });
  projectPickerBtn.addEventListener('click', () => globalEvents.emit('ui:project-picker'));
  workspaceRow.appendChild(workspaceInput);
  workspaceRow.appendChild(workspaceSaveBtn);
  workspaceTab.appendChild(workspaceRow);
  workspaceTab.appendChild(projectPickerBtn);
  workspaceTab.appendChild(workspaceHint);
  tabContents['workspace'] = workspaceTab;
  contentPane.appendChild(workspaceTab);

  // Policy tab
  const policyTab = el('div', { className: 'studio-tab-content' });
  policyTab.dataset.tabPanel = 'policy';
  const policyOptions = el('div', { className: 'studio-policy-options' });
  // 档位只遍历共享契约 PANEL_POLICY_MODES（workspace/auto/full），标题取 POLICY_MODE_LABELS；
  // 后端旧档「询问审批」不在面板暴露。desc 为面板侧说明文案。
  const policyDesc: Record<(typeof PANEL_POLICY_MODES)[number], string> = {
    workspace: '文件读写与命令执行仅限工作区根目录，越界一律拒绝。最收敛。',
    auto: '低风险操作自动执行，高风险操作弹出确认。默认档。',
    // A1（交接单_20261026 §1.2）：full 是"执行范围放开"，不是"审批永久关闭"。
    // 文案必须同时说清两件事，否则用户会以为高风险动作也不再询问。
    full: '执行范围完全放开：文件与命令类工具不再逐次确认；高风险动作仍需确认或直接拒绝。',
  };
  for (const mode of PANEL_POLICY_MODES) {
    const option = el('div', { className: `studio-policy-option${mode === globalState.policyMode ? ' selected' : ''}`, attrs: { 'data-mode': mode } });
    option.innerHTML = `<div class="studio-policy-radio"></div><div><div class="studio-policy-title">${escapeHtml(POLICY_MODE_LABELS[mode])}</div><div class="studio-policy-desc">${escapeHtml(policyDesc[mode])}</div></div>`;
    option.addEventListener('click', async () => {
      const chosen: PolicyMode = mode;
      const ok = await controls.setPolicy(chosen);
      if (!ok) {
        policyHint.textContent = `保存失败：${controls.getSnapshot().error ?? '未知错误'}`;
        syncControls();
      } else {
        policyHint.textContent = `已保存：${POLICY_MODE_LABELS[chosen]}。重启后仍然生效。`;
      }
    });
    policyOptions.appendChild(option);
  }
  policyTab.appendChild(policyOptions);
  const policyHint = el('p', { className: 'studio-form-hint', text: '' });
  policyTab.appendChild(policyHint);

  // A4：持久项目规则（v2 白名单）撤销列表。
  const wlSection = el('div', { style: 'margin-top:18px;border-top:1px solid #eef0f5;padding-top:12px;' });
  wlSection.appendChild(el('div', { style: 'font-size:13px;font-weight:600;color:#333;margin-bottom:6px;', text: '项目规则（已自动放行）' }));
  const wlList = el('div', { className: 'studio-memory-list' });
  const wlHint = el('p', { className: 'studio-form-hint', text: '' });
  wlSection.appendChild(wlList);
  wlSection.appendChild(wlHint);
  policyTab.appendChild(wlSection);

  type WlRow = { id: string; toolId: string; action: string; targetPattern: string; grantScope: string; createdAt: number };
  async function reloadWhitelist(): Promise<void> {
    const r = await callHostTool('consent.whitelist.list', {});
    const rows = r.ok && r.data && typeof r.data === 'object'
      ? (r.data as { entries?: unknown }).entries
      : undefined;
    wlList.replaceChildren();
    if (!Array.isArray(rows) || rows.length === 0) {
      wlList.appendChild(el('div', { className: 'studio-empty-state', style: 'padding:16px 0;', text: '暂无项目规则' }));
      return;
    }
    for (const row of rows as WlRow[]) {
      const item = el('div', { className: 'studio-mcp-server-item' });
      item.innerHTML = `
        <div class="studio-mcp-server-info">
          <div class="studio-mcp-server-name">${escapeHtml(row.toolId)} <span class="studio-mcp-transport">${escapeHtml(row.grantScope)}</span></div>
          <div class="studio-mcp-server-cmd">${escapeHtml(row.action)} · ${escapeHtml(row.targetPattern)}</div>
        </div>
        <div class="studio-mcp-server-actions"></div>
      `;
      const actions = item.querySelector('.studio-mcp-server-actions')!;
      const revokeBtn = el('button', { className: 'studio-btn sm danger', text: '撤销' });
      revokeBtn.addEventListener('click', async () => {
        const rr = await callHostTool('consent.whitelist.revoke', { id: row.id });
        if (!rr.ok) {
          wlHint.textContent = `撤销失败：${rr.error ?? '未知错误'}`;
          return;
        }
        wlHint.textContent = '';
        void reloadWhitelist();
      });
      actions.appendChild(revokeBtn);
      wlList.appendChild(item);
    }
  }
  tabContents['policy'] = policyTab;
  contentPane.appendChild(policyTab);

  // MCP tab
  const mcpTab = el('div', { className: 'studio-tab-content' });
  mcpTab.dataset.tabPanel = 'mcp';
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
  contentPane.appendChild(mcpTab);

  // Skills tab
  const skillsTab = el('div', { className: 'studio-tab-content' });
  skillsTab.dataset.tabPanel = 'skills';
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
  contentPane.appendChild(skillsTab);

  // Memory tab（M10-5：生效中 / 已归档 两态；删除改为归档，真删走 memory.purge）
  const memoryTab = el('div', { className: 'studio-tab-content' });
  memoryTab.dataset.tabPanel = 'memory';

  type MemoryRowView = { id: string; type: string; name: string; content: string };
  let memoryMode: 'active' | 'archived' = 'active';
  let archivedRows: MemoryRowView[] = [];

  const memoryToolbar = el('div', { className: 'studio-memory-toolbar' });
  const activeModeBtn = el('button', { className: 'studio-btn sm', text: '生效中' });
  const archivedModeBtn = el('button', { className: 'studio-btn sm', text: '已归档' });
  memoryToolbar.appendChild(activeModeBtn);
  memoryToolbar.appendChild(archivedModeBtn);
  const memoryList = el('div', { className: 'studio-memory-list' });
  memoryTab.appendChild(memoryToolbar);
  memoryTab.appendChild(memoryList);

  function syncModeButtons(): void {
    activeModeBtn.dataset.active = String(memoryMode === 'active');
    archivedModeBtn.dataset.active = String(memoryMode === 'archived');
  }

  /** 从宿主拉一次生效中列表。RPC 失败时保留现有缓存，不清空界面。 */
  async function reloadActive(): Promise<void> {
    const r = await callHostTool('memory.list', {});
    const rows = r.ok && r.data && typeof r.data === 'object'
      ? (r.data as { memories?: unknown }).memories
      : undefined;
    if (Array.isArray(rows)) globalState.memories = rows as MemoryRowView[];
    if (memoryMode === 'active') renderMemories();
  }

  async function reloadArchived(): Promise<void> {
    const r = await callHostTool('memory.listArchived', {});
    const rows = r.ok && r.data && typeof r.data === 'object'
      ? (r.data as { memories?: unknown }).memories
      : undefined;
    archivedRows = Array.isArray(rows) ? (rows as MemoryRowView[]) : [];
    if (memoryMode === 'archived') renderMemories();
  }

  function renderMemories(): void {
    syncModeButtons();
    memoryList.replaceChildren();
    const rows: MemoryRowView[] = memoryMode === 'active' ? globalState.memories : archivedRows;
    if (rows.length === 0) {
      memoryList.appendChild(el('div', {
        className: 'studio-empty-state',
        text: memoryMode === 'active' ? '暂无保存的记忆' : '暂无已归档的记忆',
      }));
      return;
    }
    for (const mem of rows) {
      const item = el('div', { className: 'studio-memory-item' });
      // W4：mem.type / name / content 经 escapeHtml 转义
      item.innerHTML = `
        <span class="studio-memory-type ${escapeHtml(mem.type)}">${escapeHtml(mem.type)}</span>
        <div class="studio-memory-content">
          <div class="studio-memory-name">${escapeHtml(mem.name)}</div>
          <div class="studio-memory-text">${escapeHtml(mem.content)}</div>
        </div>
      `;
      if (memoryMode === 'active') {
        const archiveBtn = el('button', { className: 'studio-btn sm danger' }, [icon(Icons.trash, 12)]);
        archiveBtn.title = '归档（可在「已归档」里恢复）';
        archiveBtn.addEventListener('click', async () => {
          const r = await callHostTool('memory.delete', { id: mem.id });
          if (r.ok) {
            globalState.memories = globalState.memories.filter((m) => m.id !== mem.id);
            await reloadArchived();
            renderMemories();
          }
        });
        item.appendChild(archiveBtn);
      } else {
        const restoreBtn = el('button', { className: 'studio-btn sm', text: '恢复' });
        restoreBtn.addEventListener('click', async () => {
          const r = await callHostTool('memory.unarchive', { id: mem.id });
          if (r.ok) await reloadArchived();
        });
        const purgeBtn = el('button', { className: 'studio-btn sm danger', text: '彻底删除' });
        purgeBtn.addEventListener('click', async () => {
          const r = await callHostTool('memory.purge', { id: mem.id });
          if (r.ok) await reloadArchived();
        });
        item.appendChild(restoreBtn);
        item.appendChild(purgeBtn);
      }
      memoryList.appendChild(item);
    }
  }

  activeModeBtn.addEventListener('click', () => {
    memoryMode = 'active';
    renderMemories();
    void reloadActive();
  });
  archivedModeBtn.addEventListener('click', () => {
    memoryMode = 'archived';
    renderMemories();
    void reloadArchived();
  });
  renderMemories();
  tabContents['memory'] = memoryTab;
  contentPane.appendChild(memoryTab);

  // Diagnostics and archive information.
  const diagnosticsTab = el('div', { className: 'studio-tab-content' });
  diagnosticsTab.dataset.tabPanel = 'diagnostics';
  diagnosticsTab.innerHTML = `
    <div class="studio-info-row"><span class="studio-info-label">日志路径</span><span class="studio-info-value">E:\\NAS\\deepseek-studio\\tauri-real.log</span></div>
    <div class="studio-info-row"><span class="studio-info-label">配置路径</span><span class="studio-info-value">~/.config/deepseek-studio/</span></div>
    <div class="studio-info-row"><span class="studio-info-label">归档位置</span><span class="studio-info-value">archive/legacy/</span></div>
    <p class="studio-form-hint">旧外部集成入口已归档；安全执行审计和聊天室审计会议仍保留。</p>
  `;
  tabContents['diagnostics'] = diagnosticsTab;
  contentPane.appendChild(diagnosticsTab);

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

  function syncControls(): void {
    const snapshot = controls.getSnapshot();
    (workspaceInput as HTMLInputElement).value = snapshot.workspaceRoot ?? '';
    globalState.workspaceRoot = snapshot.workspaceRoot;
    globalState.policyMode = snapshot.policyMode;
    policyOptions.querySelectorAll<HTMLElement>('.studio-policy-option').forEach((option) => {
      option.classList.toggle('selected', option.dataset.mode === snapshot.policyMode);
    });
  }

  const unsubscribeControls = controls.subscribe(syncControls);
  syncControls();

  async function loadMcp(): Promise<void> {
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

  function open(tab: ComposerSettingsTab = 'general'): void {
    isOpen = true;
    overlay.style.display = 'flex';
    selectTab(tab);
    workspaceHint.textContent = '工作区是工具操作的根目录。文件读写和命令执行默认限制在此目录内。';
    policyHint.textContent = '';
    mcpError.textContent = '';
    renderMcpServers();
    void controls.refresh();
    void loadMcp();
    void loadSkills();
    // M10-5：面板打开就从宿主拉一次，别只等广播（否则打开早于首帧广播时永远空）。
    void reloadActive();
    void reloadArchived();
  }

  function close(): void {
    isOpen = false;
    overlay.style.display = 'none';
  }

  // 监听全局事件
  const unsubscribeSettings = globalEvents.on('ui:settings', () => {
    if (isOpen) close();
    else open('general');
  });
  // 宿主推来新的生效列表 → 直接重渲染（载具在 entry.ts 的 onMemoriesUpdate）
  const unsubscribeMemories = globalEvents.on('ui:memories-updated', () => {
    if (memoryMode === 'active') renderMemories();
  });

  return {
    container,
    open,
    close,
    destroy() {
      unsubscribeControls();
      unsubscribeSettings();
      unsubscribeMemories();
      if (ownsControls) controls.destroy();
      container.remove();
    },
  };
}
