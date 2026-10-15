/**
 * StudioUI 整合入口（v1.0）
 *
 * 将所有 UI 组件挂载到 deepseek 网页：
 * - 左侧边栏（固定定位）
 * - 输入框增强栏（注入到输入框上方）
 * - 设置面板（模态弹窗）
 * - 右侧边栏（可选，默认折叠）
 *
 * 通过宿主桥接对象与宿主通信。
 */

import { setHostBridge, globalEvents, globalState, callHostTool, type StudioHostBridge } from './studio-ui-core';
import { createSidebar } from './studio-sidebar';
import { createInputBar } from './studio-input-bar';
import { createSettingsPanel } from './studio-settings-panel';
import { createProjectPicker } from './studio-project-picker';
import { createSkillsPanel } from './studio-skills-panel';
import { createMcpConfigDialog } from './studio-mcp-dialog';
import { createRightSidebar } from './studio-right-sidebar';
import { createChatRoom, type ChatRoomRuntimeConfig } from './studio-chat-room';

export interface StudioUIOptions {
  host: StudioHostBridge;
  /** 是否启用左侧边栏，默认 true */
  enableSidebar?: boolean;
  /** 是否启用输入框增强栏，默认 true */
  enableInputBar?: boolean;
  /** deepseek 输入框的选择器（用于定位注入位置） */
  inputBoxSelector?: string;
}

export interface StudioUIHandle {
  /** 销毁所有 UI 元素 */
  destroy: () => void;
  /** 显示/隐藏左侧边栏 */
  toggleSidebar: () => void;
}

export function installStudioUI(options: StudioUIOptions): StudioUIHandle {
  console.log('[StudioUI] install start, document.body:', !!document.body);
  setHostBridge(options.host);

  const containers: HTMLElement[] = [];
  let sidebarHandle: { container: HTMLElement; show: () => void; hide: () => void; toggle: () => void } | null = null;
  let destroyed = false;

  function mount(): void {
    if (destroyed) return;
    if (!document.body) {
      console.log('[StudioUI] waiting for document.body...');
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    console.log('[StudioUI] mounting to document.body');

  // 1. 左侧边栏（v2.0 可折叠浮动面板，默认收起不遮挡网页）
  if (options.enableSidebar !== false) {
    try {
      sidebarHandle = createSidebar();
      document.body.appendChild(sidebarHandle.container);
      containers.push(sidebarHandle.container);
      console.log('[StudioUI] sidebar installed (collapsible floating panel)');
    } catch (e) {
      console.error('[StudioUI] sidebar failed:', e);
    }
  }

  // 2. 输入框增强栏（智能注入到 deepseek 输入框内部，融入原有对话框）
  if (options.enableInputBar !== false) {
    try {
      const inputBar = createInputBar();
      // 尝试立即注入，如果失败则用 MutationObserver 等待输入框渲染
      let injected = injectIntoChatInput(inputBar.container);
      if (!injected) {
        console.log('[StudioUI] input bar not injected yet, waiting for DOM...');
        const observer = new MutationObserver(() => {
          if (inputBar.container.isConnected) {
            observer.disconnect();
            return;
          }
          const ok = injectIntoChatInput(inputBar.container);
          if (ok) {
            console.log('[StudioUI] input bar injected via MutationObserver');
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // 10 秒后停止观察，避免内存泄漏
        setTimeout(() => observer.disconnect(), 10000);
      }
      // fallback：如果 2 秒后还没注入，用固定定位
      setTimeout(() => {
        if (!inputBar.container.isConnected) {
          console.log('[StudioUI] input bar fallback to fixed positioning');
          inputBar.container.style.position = 'fixed';
          inputBar.container.style.bottom = '115px';
          inputBar.container.style.left = '50%';
          inputBar.container.style.transform = 'translateX(-50%)';
          inputBar.container.style.zIndex = '2147483646';
          inputBar.container.style.pointerEvents = 'auto';
          inputBar.container.style.width = 'min(600px, 80vw)';
          document.body.appendChild(inputBar.container);
        }
      }, 2000);
      containers.push(inputBar.container);
      console.log('[StudioUI] input bar setup done');
    } catch (e) {
      console.error('[StudioUI] input bar failed:', e);
    }
  }

  // 3. 设置面板
  try {
    const settingsPanel = createSettingsPanel();
    document.body.appendChild(settingsPanel.container);
    containers.push(settingsPanel.container);
    console.log('[StudioUI] settings panel installed');
  } catch (e) {
    console.error('[StudioUI] settings panel failed:', e);
  }

  // 4. 项目选择器
  try {
    const projectPicker = createProjectPicker();
    document.body.appendChild(projectPicker.container);
    containers.push(projectPicker.container);
    console.log('[StudioUI] project picker installed');
  } catch (e) {
    console.error('[StudioUI] project picker failed:', e);
  }

  // 5. 技能管理面板
  try {
    const skillsPanel = createSkillsPanel();
    document.body.appendChild(skillsPanel.container);
    containers.push(skillsPanel.container);
    console.log('[StudioUI] skills panel installed');
  } catch (e) {
    console.error('[StudioUI] skills panel failed:', e);
  }

  // 6. MCP 配置弹窗
  try {
    const mcpDialog = createMcpConfigDialog();
    document.body.appendChild(mcpDialog.container);
    containers.push(mcpDialog.container);
    console.log('[StudioUI] mcp dialog installed');
  } catch (e) {
    console.error('[StudioUI] mcp dialog failed:', e);
  }

  // 7. 右侧边栏
  try {
    const rightSidebar = createRightSidebar();
    document.body.appendChild(rightSidebar.container);
    document.body.appendChild(rightSidebar.toggle);
    containers.push(rightSidebar.container);
    containers.push(rightSidebar.toggle);
    console.log('[StudioUI] right sidebar installed');
  } catch (e) {
    console.error('[StudioUI] right sidebar failed:', e);
  }

  // 8. 聊天室 UI（独立 overlay，经 /agent-ws 多 bot 编排）
  // v0.28 PoC：主窗口悬浮按钮 → 独立聊天室面板（与日常对话 overlay 隔离）。
  // Rust initialization_script 注入 window.__studioChatConfig（token + roomId + members）。
  // 无配置（config.json 无 chatRooms）→ 不挂载，向后兼容。
  try {
    const chatCfg = (globalThis as { __studioChatConfig?: ChatRoomRuntimeConfig }).__studioChatConfig;
    if (chatCfg && chatCfg.token && chatCfg.roomId) {
      const chatRoom = createChatRoom(chatCfg);
      document.body.appendChild(chatRoom.container);
      containers.push(chatRoom.container);
      console.log('[StudioUI] chat room installed:', chatCfg.roomName);
    } else {
      console.warn('[StudioUI] chat room skipped: no __studioChatConfig (config.json missing chatRooms?)');
    }
  } catch (e) {
    console.error('[StudioUI] chat room failed:', e);
  }

  // === 事件绑定：侧边栏/快捷键 → 各面板 ===
  // 注意：settings/project/skills/mcp 面板内部已自绑定 globalEvents.on，
  // 这里只处理面板未覆盖的事件（新工作任务）和事件名兼容。

  // 新工作任务：触发 deepseek 新建对话
  globalEvents.on('ui:new-task', () => {
    // deepseek 页面的新对话按钮通常在左侧边栏顶部
    const candidates = [
      'button[aria-label="新对话"]',
      'button[title="新对话"]',
      'button[aria-label="New chat"]',
      'button[title="New chat"]',
      'a[href="/"]',
      '.new-chat',
      '[class*="new-chat"]',
      '[class*="newChat"]',
      'nav button:first-child',
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn) {
        (btn as HTMLElement).click();
        return;
      }
    }
    // 降级：清空输入框并聚焦
    const textarea = document.querySelector('textarea');
    if (textarea) {
      (textarea as HTMLTextAreaElement).value = '';
      textarea.focus();
    }
  });

  // 定时任务（占位）
  globalEvents.on('ui:scheduled-tasks', () => {
    console.log('[StudioUI] scheduled tasks not yet implemented');
  });

  console.log('[StudioUI] install complete, containers:', containers.length);

  // 异步加载已有 MCP 服务器列表和技能列表（UI 初始化时 globalState 为空，需从宿主拉取）
  (async () => {
    try {
      const mcpResult = await callHostTool('mcp.list', {});
      if (mcpResult.ok && mcpResult.data && Array.isArray((mcpResult.data as { servers?: string[] }).servers)) {
        globalState.mcpServers = [...(mcpResult.data as { servers: string[] }).servers];
        console.log('[StudioUI] loaded MCP servers:', globalState.mcpServers);
      }
    } catch (e) {
      console.warn('[StudioUI] load MCP servers failed:', e instanceof Error ? e.message : String(e));
    }
    try {
      const skillResult = await callHostTool('skill.list', {});
      if (skillResult.ok && skillResult.data && Array.isArray((skillResult.data as { skills?: unknown[] }).skills)) {
        globalState.skills = (skillResult.data as { skills: Array<{ id: string; name: string; description: string }> }).skills;
        console.log('[StudioUI] loaded skills:', globalState.skills.length);
      }
    } catch (e) {
      console.warn('[StudioUI] load skills failed:', e instanceof Error ? e.message : String(e));
    }
  })();

  // 监听键盘快捷键：Ctrl+, 打开设置
  document.addEventListener('keydown', handleKeydown);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      globalEvents.emit('ui:settings');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault();
      sidebarHandle?.toggle();
    }
  }

  // 启动挂载（可能等待 DOMContentLoaded）
  mount();

  return {
    destroy: () => {
      destroyed = true;
      document.removeEventListener('keydown', handleKeydown);
      for (const c of containers) {
        c.remove();
      }
    },
    toggleSidebar: () => {
      sidebarHandle?.toggle();
    },
  };
}

/**
 * 将输入框增强栏注入到 deepseek 输入框内部的工具栏中。
 * 找到 textarea → 向上找输入框容器 → 找底部工具栏 → 插入到工具栏左侧。
 */
function injectIntoChatInput(barContainer: HTMLElement): boolean {
  // 优先用精确选择器（用户提供的 deepseek 输入框结构）
  const toolbarSelectors = [
    // 完整路径（用户提供）
    '#root > div > div.c3ecdb44 > div._7780f2e > div > div.ds-virtual-list > div._871cbca > div.aaff8b8f > div > div > div.ec4f5d61 > div._58b31c9',
    // 简化路径
    '#root div.ec4f5d61 > div._58b31c9',
    'div.ec4f5d61 > div._58b31c9',
    'div.ec4f5d61 div._58b31c9',
    '.ec4f5d61 ._58b31c9',
  ];

  for (const selector of toolbarSelectors) {
    const toolbar = document.querySelector(selector) as HTMLElement | null;
    if (toolbar && !toolbar.closest('.studio-ui-root')) {
      console.log('[StudioUI] inject: found toolbar via selector:', selector);
      barContainer.style.cssText = 'display:flex;align-items:center;gap:2px;margin-right:4px;pointer-events:auto;flex-shrink:0;';
      toolbar.insertBefore(barContainer, toolbar.firstChild);
      return true;
    }
  }

  // fallback：扫描页面底部的 flex 工具栏，排除我们自己注入的 UI
  console.log('[StudioUI] inject: exact selectors not found, falling back to scan');
  const allDivs = document.querySelectorAll('div:not(.studio-ui-root div)');
  let toolbar: HTMLElement | null = null;
  let bestScore = 0;

  for (const div of allDivs) {
    // 排除我们自己注入的 UI 元素
    if (div.closest('.studio-ui-root')) continue;
    const style = window.getComputedStyle(div);
    if (style.display !== 'flex') continue;
    const buttons = div.querySelectorAll('button');
    if (buttons.length < 2) continue;
    const rect = div.getBoundingClientRect();
    // 必须在页面底部 30% 区域内
    if (rect.bottom < window.innerHeight * 0.7) continue;
    const score = buttons.length * 10 + rect.bottom;
    if (score > bestScore) {
      bestScore = score;
      toolbar = div as HTMLElement;
    }
  }

  if (toolbar) {
    console.log('[StudioUI] inject: found toolbar via scan, buttons:', toolbar.querySelectorAll('button').length, 'bottom:', toolbar.getBoundingClientRect().bottom);
    barContainer.style.cssText = 'display:flex;align-items:center;gap:2px;margin-right:4px;pointer-events:auto;flex-shrink:0;';
    toolbar.insertBefore(barContainer, toolbar.firstChild);
    return true;
  }

  console.log('[StudioUI] inject: no toolbar found');
  return false;
}
