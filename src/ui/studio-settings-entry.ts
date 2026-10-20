/**
 * Studio 设置入口（F4）：把设置面板挂进 DeepSeek 网页版的账号菜单。
 *
 * 背景：C4 起 installStudioUI（旧 Shadow 架构装配）已不再是默认入口，7 个面板
 * （settings / skills / mcp / project-picker 等）源码完整、后端工具齐全，
 * 但全仓无人调用 installStudioUI → 面板不可达。本模块给它们一个最小入口。
 *
 * 设计取舍：
 * 1. 不改写 DeepSeek 官方的「系统设置」弹窗——那是它自己的 React 应用渲染的账号/
 *    主题/语言设置，我们接管不了也不该冒充。本模块只在同菜单里追加一个兄弟项
 *    「Studio 设置」，官方行为保持原样。
 * 2. 不 import installStudioUI：旧装配会同时拉起 sidebar / input-bar 等 6 个面板，
 *    且依赖已知有问题的 createShadowContainer（W5 已记录）。这里只做
 *    setHostBridge + 挂设置面板 + 挂 skills/mcp/project 面板。
 *
 * 定位方式：DeepSeek 菜单的 class 是构建期哈希（_7780f2e 之类），随时会变，
 * 因此按可见文本匹配「系统设置」再插兄弟节点，不依赖任何哈希 class。
 */

import {
  globalEvents,
  setHostBridge,
  type StudioHostBridge,
} from './studio-ui-core';
import { createSettingsPanel } from './studio-settings-panel';
import { createSkillsPanel } from './studio-skills-panel';
import { createMcpConfigDialog } from './studio-mcp-dialog';
import { createProjectPicker } from './studio-project-picker';

/** 入口在 DeepSeek 菜单中使用的文案。 */
const MENU_LABEL = 'Studio 设置';

/** 注入前的最大尝试轮数（DeepSeek 菜单异步渲染，需要等）。 */
const MAX_ATTEMPTS = 12;

/** 每轮之间的间隔（ms）。 */
const RETRY_INTERVAL_MS = 500;

/** MutationObserver 兜底观察窗口（ms），到点即断开，避免常驻泄漏。 */
const OBSERVER_TIMEOUT_MS = 15_000;

export interface StudioSettingsEntryHandle {
  /** 打开 Studio 设置面板（幂等）。 */
  open(): void;
  /** 移除注入的菜单项与所有面板容器。 */
  destroy(): void;
}

/** 判断节点可见文本是否等于 DeepSeek 官方的「系统设置」菜单项。 */
function isSystemSettingsItem(node: Element): boolean {
  const text = (node.textContent ?? '').replace(/\s+/g, '').trim();
  if (text !== '系统设置') return false;
  // 只认可可点击的菜单项，避免误中标题/说明文字。
  return node.matches('button, [role="menuitem"], a, li, div[class*="item"]');
}

/**
 * 找到「系统设置」菜单项后，把 Studio 设置项插到它后面。
 * 已注入过则直接返回 true（React 重渲染会清掉节点，届时需要重新插入）。
 */
function injectMenuItem(): boolean {
  const existing = document.querySelector('[data-studio-settings-entry="1"]');
  if (existing) return true;

  const candidates = Array.from(document.querySelectorAll('body *')).filter(isSystemSettingsItem);
  if (candidates.length === 0) return false;

  const anchor = candidates[candidates.length - 1] as HTMLElement;
  const parent = anchor.parentElement;
  if (!parent) return false;

  const item = document.createElement('div');
  item.setAttribute('data-studio-settings-entry', '1');
  item.setAttribute('role', 'menuitem');
  // 复用宿主的 class 以继承菜单外观，但不复制内联定位样式（会破坏布局）。
  if (anchor.className && typeof anchor.className === 'string') {
    item.className = anchor.className;
  }
  item.textContent = MENU_LABEL;
  item.style.cursor = 'pointer';
  item.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    globalEvents.emit('ui:settings');
  });

  anchor.insertAdjacentElement('afterend', item);
  console.log('[StudioUI] settings entry injected next to 系统设置');
  return true;
}

/**
 * 挂载 Studio 设置体系：先接宿主桥（面板调后端工具的唯一前提），
 * 再挂设置面板 + skills/mcp/project 三个对话框（互不依赖，任一失败不影响其余）。
 */
export function installStudioSettingsEntry(host: StudioHostBridge): StudioSettingsEntryHandle {
  // setHostBridge 是全仓唯一的「UI → 宿主工具」通道；不接它，面板里所有
  // callHostTool 都会返回 no-host-bridge（这是此前 7 个面板全部不可用的根因之一）。
  setHostBridge(host);

  const containers: HTMLElement[] = [];

  function mountPanel(name: string, factory: () => { container: HTMLElement }): void {
    try {
      const handle = factory();
      document.body.appendChild(handle.container);
      containers.push(handle.container);
      console.log(`[StudioUI] ${name} mounted`);
    } catch (e) {
      // 单面板失败不得阻断其它面板与入口注入。
      console.error(`[StudioUI] ${name} failed:`, e);
    }
  }

  mountPanel('settings panel', createSettingsPanel);
  mountPanel('skills panel', createSkillsPanel);
  mountPanel('mcp dialog', createMcpConfigDialog);
  mountPanel('project picker', createProjectPicker);

  let attempts = 0;
  let done = false;
  let observer: MutationObserver | null = null;

  function finish(): void {
    done = true;
    window.clearInterval(retryTimer);
    observer?.disconnect();
    observer = null;
  }

  const retryTimer = window.setInterval(() => {
    attempts += 1;
    if (injectMenuItem()) {
      finish();
      return;
    }
    if (attempts >= MAX_ATTEMPTS) {
      // DeepSeek 改版导致定位失败时安静退出：不影响页面任何原有功能。
      console.warn(
        `[StudioUI] settings entry not injected after ${MAX_ATTEMPTS} attempts ` +
        '(DeepSeek menu has no 系统设置 item; page unaffected)',
      );
      finish();
    }
  }, RETRY_INTERVAL_MS);

  // MutationObserver 兜底：React 重渲染会抹掉我们插入的节点，
  // 这是长会话里唯一可靠的恢复手段。窗口到时即断，不常驻。
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (done) {
        observer?.disconnect();
        observer = null;
        return;
      }
      if (injectMenuItem()) finish();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => {
      observer?.disconnect();
      observer = null;
    }, OBSERVER_TIMEOUT_MS);
  }

  return {
    open() {
      globalEvents.emit('ui:settings');
    },
    destroy() {
      window.clearInterval(retryTimer);
      observer?.disconnect();
      observer = null;
      document.querySelectorAll('[data-studio-settings-entry="1"]').forEach((n) => n.remove());
      for (const c of containers) c.remove();
    },
  };
}