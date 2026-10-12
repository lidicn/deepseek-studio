/**
 * StudioUI 技能管理面板（v1.0）
 *
 * 侧边弹窗（从右侧滑入）：
 * - 技能列表（名称+描述+启用开关）
 * - 点击技能展开详情（SKILL.md 内容预览）
 * - 打开技能目录、添加技能
 */

import { el, icon, Icons, injectStyles, createShadowContainer, globalEvents, globalState, callHostTool } from './studio-ui-core';

const panelStyles = `
  .studio-skills-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.3);
    z-index: 2147483500; display: none;
  }
  .studio-skills-panel {
    position: fixed; top: 0; right: 0; width: 420px; height: 100vh;
    background: #fff; box-shadow: -4px 0 20px rgba(0,0,0,0.1);
    z-index: 2147483501; display: flex; flex-direction: column;
    transform: translateX(100%); transition: transform 0.25s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .studio-skills-panel.open { transform: translateX(0); }
  .studio-skills-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid #f0f0f0;
  }
  .studio-skills-title { font-size: 16px; font-weight: 600; color: #1a1a2e; margin: 0; }
  .studio-skills-body { flex: 1; overflow-y: auto; padding: 12px; }
  .studio-skills-search { margin-bottom: 12px; position: relative; }
  .studio-skills-search input { padding-left: 36px; }
  .studio-skills-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #aaa; }
  .studio-skill-card {
    border: 1px solid #e8e8e8; border-radius: 10px; margin-bottom: 8px;
    overflow: hidden; transition: all 0.15s;
  }
  .studio-skill-card:hover { border-color: #c5d0ff; }
  .studio-skill-card.expanded { border-color: #4D6BFE; }
  .studio-skill-header {
    display: flex; align-items: center; gap: 10px; padding: 12px; cursor: pointer;
  }
  .studio-skill-icon {
    width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;
  }
  .studio-skill-info { flex: 1; min-width: 0; }
  .studio-skill-name { font-size: 14px; font-weight: 500; color: #333; }
  .studio-skill-desc { font-size: 12px; color: #888; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-skill-toggle { flex-shrink: 0; }
  .studio-skill-detail {
    display: none; padding: 0 12px 12px; border-top: 1px solid #f0f0f0;
  }
  .studio-skill-card.expanded .studio-skill-detail { display: block; }
  .studio-skill-detail-content {
    margin-top: 12px; padding: 12px; background: #f8f9fc; border-radius: 8px;
    font-size: 12px; color: #555; line-height: 1.6; max-height: 200px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
  }
  .studio-skill-detail-actions { display: flex; gap: 8px; margin-top: 12px; }
  .studio-skills-footer {
    padding: 12px 20px; border-top: 1px solid #f0f0f0; display: flex; gap: 8px;
  }
  .studio-skills-footer .studio-btn { flex: 1; justify-content: center; }
  .studio-empty-state { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;

export function createSkillsPanel(): { container: HTMLElement; open: () => void; close: () => void } {
  const { container, shadow } = createShadowContainer('studio-skills-panel-root');
  injectStyles(shadow, panelStyles);

  let isOpen = false;
  let expandedSkillId: string | null = null;
  let searchQuery = '';

  const overlay = el('div', { className: 'studio-skills-overlay' });
  const panel = el('div', { className: 'studio-skills-panel' });

  // Header
  const header = el('div', { className: 'studio-skills-header' }, [
    el('h2', { className: 'studio-skills-title', text: '技能管理' }),
  ]);
  const closeBtn = el('button', { className: 'studio-close-btn' }, [icon(Icons.x, 18)]);
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Body
  const body = el('div', { className: 'studio-skills-body' });

  // Search
  const searchBox = el('div', { className: 'studio-skills-search' });
  const searchIcon = el('span', { className: 'studio-skills-search-icon' });
  searchIcon.appendChild(icon(Icons.search, 16));
  const searchInput = el('input', { className: 'studio-input', attrs: { placeholder: '搜索技能...' } });
  searchInput.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
    renderSkills();
  });
  searchBox.appendChild(searchIcon);
  searchBox.appendChild(searchInput);
  body.appendChild(searchBox);

  // Skill list
  const skillList = el('div', { className: 'studio-skill-list' });
  body.appendChild(skillList);

  panel.appendChild(body);

  // Footer
  const footer = el('div', { className: 'studio-skills-footer' });
  const refreshBtn = el('button', { className: 'studio-btn' }, [icon(Icons.refresh, 14), el('span', { text: '刷新' })]);
  refreshBtn.addEventListener('click', loadSkills);
  const openDirBtn = el('button', { className: 'studio-btn' }, [icon(Icons.folder, 14), el('span', { text: '打开目录' })]);
  openDirBtn.addEventListener('click', async () => {
    await callHostTool('shell.exec', { command: 'explorer "%USERPROFILE%\\.config\\deepseek-studio\\skills"' });
  });
  footer.appendChild(refreshBtn);
  footer.appendChild(openDirBtn);
  panel.appendChild(footer);

  overlay.appendChild(panel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  shadow.appendChild(overlay);

  interface SkillWithContent {
    id: string;
    name: string;
    description: string;
    skillMdPath: string;
    content?: string;
    enabled: boolean;
  }

  let skills: SkillWithContent[] = [];

  async function loadSkills(): Promise<void> {
    try {
      const result = await callHostTool('skill.list', {});
      if (result.ok && result.data) {
        const list = (result.data as { skills: Array<{ id: string; name: string; description: string; skillMdPath: string }> }).skills;
        skills = list.map((s) => ({ ...s, enabled: true }));
        globalState.skills = list;
      }
    } catch {
      // ignore
    }
    renderSkills();
  }

  async function loadSkillContent(skillId: string): Promise<string> {
    const skill = skills.find((s) => s.id === skillId);
    if (!skill) return '';
    if (skill.content) return skill.content;
    try {
      const result = await callHostTool('file.read', { path: skill.skillMdPath });
      if (result.ok && result.data) {
        skill.content = (result.data as { content: string }).content;
        return skill.content;
      }
    } catch {
      // ignore
    }
    return '（无法加载 SKILL.md 内容）';
  }

  function renderSkills(): void {
    skillList.innerHTML = '';
    const filtered = skills.filter((s) =>
      !searchQuery || s.name.toLowerCase().includes(searchQuery) || s.description.toLowerCase().includes(searchQuery),
    );
    if (filtered.length === 0) {
      skillList.appendChild(el('div', { className: 'studio-empty-state', text: searchQuery ? '没有匹配的技能' : '暂无技能，请在技能目录中添加' }));
      return;
    }
    for (const skill of filtered) {
      const isExpanded = expandedSkillId === skill.id;
      const card = el('div', { className: `studio-skill-card${isExpanded ? ' expanded' : ''}` });

      const cardHeader = el('div', { className: 'studio-skill-header' });
      const skillIcon = el('div', { className: 'studio-skill-icon' });
      skillIcon.appendChild(icon(Icons.book, 18));
      const skillInfo = el('div', { className: 'studio-skill-info' });
      skillInfo.innerHTML = `<div class="studio-skill-name">${skill.name}</div><div class="studio-skill-desc">${skill.description}</div>`;
      const toggle = el('div', { className: `studio-switch${skill.enabled ? ' on' : ''}` });
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        skill.enabled = !skill.enabled;
        toggle.classList.toggle('on', skill.enabled);
      });
      cardHeader.appendChild(skillIcon);
      cardHeader.appendChild(skillInfo);
      cardHeader.appendChild(toggle);
      cardHeader.addEventListener('click', async () => {
        expandedSkillId = isExpanded ? null : skill.id;
        renderSkills();
        if (!isExpanded) {
          await loadSkillContent(skill.id);
          const detailEl = card.querySelector('.studio-skill-detail-content');
          if (detailEl) detailEl.textContent = skill.content ?? '加载中...';
        }
      });
      card.appendChild(cardHeader);

      const detail = el('div', { className: 'studio-skill-detail' });
      const detailContent = el('div', { className: 'studio-skill-detail-content', text: isExpanded ? (skill.content ?? '加载中...') : '' });
      detail.appendChild(detailContent);
      const detailActions = el('div', { className: 'studio-skill-detail-actions' });
      const readFullBtn = el('button', { className: 'studio-btn sm', text: '读取完整内容' });
      readFullBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const content = await loadSkillContent(skill.id);
        detailContent.textContent = content;
      });
      detailActions.appendChild(readFullBtn);
      detail.appendChild(detailActions);
      card.appendChild(detail);

      skillList.appendChild(card);
    }
  }

  function open(): void {
    isOpen = true;
    overlay.style.display = 'block';
    requestAnimationFrame(() => panel.classList.add('open'));
    searchQuery = '';
    (searchInput as HTMLInputElement).value = '';
    expandedSkillId = null;
    loadSkills();
  }

  function close(): void {
    isOpen = false;
    panel.classList.remove('open');
    setTimeout(() => { overlay.style.display = 'none'; }, 250);
  }

  globalEvents.on('ui:skills-panel', () => { isOpen ? close() : open(); });
  globalEvents.on('ui:skills', () => { isOpen ? close() : open(); });

  return { container, open, close };
}
