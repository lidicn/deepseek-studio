/**
 * Studio 设置入口（F4）：把设置面板挂进 DeepSeek 网页版的账号菜单。
 *
 * 背景：C4 起 installStudioUI（旧 Shadow 架构装配）已不再是默认入口，7 个面板
 * （settings / skills / mcp / project-picker）源码完整、后端工具齐全，但全仓无人
 * 调用 installStudioUI → 面板不可达。本模块给它们一个最小入口。
 *
 * 设计取舍：
 * 1. 不改写 DeepSeek 官方的「系统设置」弹窗（它自己的 React 应用渲染的账号/主题/
 *    语言设置）。本模块只在账号下拉菜单里追加一个兄弟项「Studio 设置」。
 * 2. 不 import installStudioUI：旧装配会同时拉起 sidebar / input-bar 等面板，
 *    且依赖已知有问题的 createShadowContainer（W5 已记录）。这里只做
 *    「setHostBridge + 挂 settings/skills/mcp/project 四个面板」。
 *
 * 定位方式（两处坑，实测踩过）：
 * - class 是构建期哈希（_7780f2e 之类）随时会变 → 按可见文本匹配，不依赖 class。
 * - 账号菜单只在点击账号后才渲染 → 以 click 为主要触发 + 有界轮询兜底，
 *   不能只在页面加载后短暂重试（那样用户点开菜单时早已停）。
 * - 弹窗标题也叫「系统设置」→ 必须限定在账号菜单内（靠同组「退出登录/
 *   帮助与反馈」判定），否则会误插进弹窗标题栏。
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

/** 入口在账号菜单中显示的文案。 */
const MENU_LABEL = 'Studio 设置';

/** DeepSeek 账号菜单里的锚点文案。 */
const ANCHOR_TEXT = '系统设置';

/** 注入项的标记属性（测试与幂等判断用）。 */
const ENTRY_ATTR = 'data-studio-settings-entry';

/** 页面加载后的有界轮询次数与间隔（此后改由点击驱动，不做永久定时器）。 */
const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 1000;

/** 点击后延迟尝试（菜单有展开动画）。 */
const CLICK_DELAYS_MS = [60, 300, 900];

export interface StudioSettingsEntryHandle {
  /** 打开 Studio 设置面板（幂等）。 */
  open(): void;
  /** 移除注入的菜单项、面板容器，并解绑监听。 */
  destroy(): void;
}

/** 去掉所有空白，便于文本比较（菜单项文本常被换行/缩进包裹）。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

/** 把子树里所有等于 from 的文本节点改为 to（替换菜单文案但保留图标等结构）。 */
function replaceLabelText(root: HTMLElement, from: string, to: string): void {
  const target = normalize(from);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (normalize(node.nodeValue ?? '') === target) node.nodeValue = to;
    node = walker.nextNode();
  }
}

/**
 * 判断某节点是否位于 DeepSeek 的**账号下拉菜单**内。
 * 关键区分：官方「系统设置」弹窗标题也叫「系统设置」，但它同组没有
 * 「退出登录 / 帮助与反馈」。用同组文案把账号菜单和弹窗区分开。
 */
function isInsideAccountMenu(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  const groupText = normalize(parent.textContent ?? '');
  return groupText.includes('退出登录') || groupText.includes('帮助与反馈');
}

/**
 * 找「系统设置」菜单项。取文本精确等于该串、且父节点文本不等于该串的最外层节点
 * （避免选中菜单项内部只包文字的 <span>），并限定在账号菜单内。
 */
export function findSystemSettingsAnchor(root: ParentNode = document): HTMLElement | null {
  const all = Array.from(root.querySelectorAll<HTMLElement>('*'));
  const exact = all.filter((el) => normalize(el.textContent ?? '') === ANCHOR_TEXT);
  if (exact.length === 0) return null;
  const outermost = exact.filter(
    (el) => normalize(el.parentElement?.textContent ?? '') !== ANCHOR_TEXT,
  );
  const candidates = outermost.length > 0 ? outermost : exact;
  // 从后往前取第一个落在账号菜单内的（菜单通常是最后渲染的浮层）。
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const el = candidates[i];
    if (isInsideAccountMenu(el) || isInsideAccountMenu(el.parentElement ?? el)) return el;
  }
  return null;
}

/**
 * 把「Studio 设置」项插到「系统设置」后面。已存在则直接返回 true。
 */
export function injectSettingsMenuItem(root: ParentNode = document): boolean {
  if (document.querySelector(`[${ENTRY_ATTR}="1"]`)) return true;
  const anchor = findSystemSettingsAnchor(root);
  if (!anchor || !anchor.parentElement) return false;

  // 克隆锚点整项：官方菜单项的图标是文字前的第一个子节点，只复制 className +
  // 设 textContent 会丢掉图标（用户反馈「Studio 设置没有图标」）。克隆后把文案
  // 从「系统设置」改成 MENU_LABEL，图标与布局一并保留。
  const item = anchor.cloneNode(true) as HTMLElement;
  item.setAttribute(ENTRY_ATTR, '1');
  item.setAttribute('role', 'menuitem');
  // 克隆体会带上锚点的 id / 导航属性；清掉避免与官方项冲突或被点击跳转。
  item.removeAttribute('id');
  item.removeAttribute('href');
  item.removeAttribute('target');
  replaceLabelText(item, ANCHOR_TEXT, MENU_LABEL);
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

/** body 就绪后回调（document_start 时 body 可能还是 null，直接 append 会抛错）。 */
function onBodyReady(fn: () => void): void {
  if (document.body && document.readyState !== 'loading') {
    fn();
    return;
  }
  if (document.body) {
    fn();
    return;
  }
  document.addEventListener('DOMContentLoaded', () => fn(), { once: true });
}

/**
 * 挂载 Studio 设置体系：先接宿主桥（面板调后端工具的唯一前提），
 * body 就绪后再挂四个面板并启动菜单注入。
 */
export function installStudioSettingsEntry(host: StudioHostBridge): StudioSettingsEntryHandle {
  // setHostBridge 是全仓唯一的「UI → 宿主工具」通道；不接它，面板里所有
  // callHostTool 都会返回 no-host-bridge（这是 7 个面板"能看不能用"的根因之一）。
  setHostBridge(host);

  const containers: HTMLElement[] = [];
  let pollTimer: number | null = null;
  let pollCount = 0;
  const clickDelays: number[] = [];

  function mountPanel(name: string, factory: () => { container: HTMLElement }): void {
    try {
      const handle = factory();
      document.body.appendChild(handle.container);
      containers.push(handle.container);
      console.log(`[StudioUI] ${name} mounted`);
    } catch (e) {
      // 单面板失败不得阻断其它面板与菜单注入。
      console.error(`[StudioUI] ${name} failed:`, e);
    }
  }

  function onAnyClick(): void {
    for (const delay of CLICK_DELAYS_MS) {
      clickDelays.push(window.setTimeout(() => void injectSettingsMenuItem(), delay));
    }
  }

  function start(): void {
    mountPanel('settings panel', createSettingsPanel);
    mountPanel('skills panel', createSkillsPanel);
    mountPanel('mcp dialog', createMcpConfigDialog);
    mountPanel('project picker', createProjectPicker);

    // 主触发：账号菜单只在点击后渲染，所以以 click 为准，延时多点尝试。
    document.addEventListener('click', onAnyClick, true);

    // 有界轮询兜底（页面加载时菜单可能已经开着）。到点即停，不做永久定时器。
    pollTimer = window.setInterval(() => {
      pollCount += 1;
      if (injectSettingsMenuItem() || pollCount >= POLL_ATTEMPTS) {
        if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
      }
    }, POLL_INTERVAL_MS);
    // 立即先试一次（已在菜单打开状态下重启的场景）。
    void injectSettingsMenuItem();
  }

  onBodyReady(start);

  return {
    open() {
      globalEvents.emit('ui:settings');
    },
    destroy() {
      if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
      for (const t of clickDelays) window.clearTimeout(t);
      clickDelays.length = 0;
      document.removeEventListener('click', onAnyClick, true);
      document.querySelectorAll(`[${ENTRY_ATTR}="1"]`).forEach((n) => n.remove());
      for (const c of containers) c.remove();
      containers.length = 0;
    },
  };
}

// 调试/测试钩子：可在控制台手动触发一次注入尝试。
if (typeof window !== 'undefined') {
  (window as unknown as { __studioInjectSettingsEntry?: () => boolean }).__studioInjectSettingsEntry =
    () => injectSettingsMenuItem();
}
