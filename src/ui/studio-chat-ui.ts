/**
 * v0.19 自建聊天 UI overlay
 *
 * 在 DeepSeek 页面上覆盖一个半屏聊天界面，接管消息渲染：
 * - 用户消息：右对齐蓝色气泡
 * - 助手消息：左对齐浅色卡片，流式期 textContent 追加，流结束 renderMarkdown 格式化
 * - 工具卡片：挂载到助手消息内的 .dsx-tools-root（复用 tool-card-ui.redesign）
 * - 状态栏：底部显示执行中/完成
 *
 * SSE 文本由 main-world-interceptor 推送到本组件，不再写入 DeepSeek DOM。
 */

import { renderMarkdown } from '../inject/markdown';
import {
  createRedesignedToolCard,
  updateRedesignedToolCardByCallId,
  type ToolCardData,
} from '../inject/tool-card-ui.redesign';
import {
  STUDIO_EXECUTION_MAX_EVENTS,
  appendExecutionEvent,
  createEmptyStudioExecutionSession,
  limitFinalAnswer,
  limitToolPayload,
  normalizeSessionKeyFromPathname,
  type StudioExecutionEvent,
  type StudioExecutionSession,
} from '../shared/studio-execution';
import { describeErrorCode } from '../shared/ui-error-codes';
import { STUDIO_CHAT_CSS } from './studio-chat-css';
import type { StudioExecutionStore } from './studio-execution-store';
import { createHistoryHydrator } from './studio-history-hydration';

/**
 * 同一会话的历史水合结果缓存窗口。
 * 本地执行记录可能只覆盖部分轮次，因此即使已有回答也要校验一次原生历史；
 * TTL 内复用结果，避免每次切回都发请求。
 */
const STUDIO_HISTORY_SYNC_TTL_MS = 60_000;

function countUserMessages(events: readonly StudioExecutionEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === 'user-message') count += 1;
  }
  return count;
}

export interface StudioChatUIHandle {
  container: HTMLElement;
  /** 添加一条用户消息气泡 */
  addUserMessage(text: string): void;
  /**
   * 创建新的助手回复元素（流式容器），后续 appendToAssistantMessage 往里追加。
   * v0.27：可选 sender 参数标识多参与者（主 bot / 子 bot），渲染头像+名称标签。
   */
  startAssistantMessage(sender?: { name?: string; type?: 'user' | 'main-bot' | 'sub-bot' }): void;
  /** 流式追加可见正文（80ms 节流 + markdown 实时渲染 + 光标） */
  appendToAssistantMessage(text: string): void;
  /** 流式追加思考段（reasoning），渲染到可折叠 think 块 */
  appendReasoning(text: string): void;
  /** 流结束：移除光标，最终 renderMarkdown 格式化替换 */
  finishAssistantMessage(options?: { recordFinal?: boolean; fallbackText?: string }): void;
  /** 设置状态栏忙碌/完成状态 */
  setBusy(busy: boolean): void;
  /** 在当前助手消息中创建/更新工具卡；无 Studio 助手节点时返回 false，不触碰原生 DOM。 */
  startToolCard(callId: string, data: ToolCardData): boolean;
  finishToolCard(callId: string, data: ToolCardData, result: ToolCardData['result'], durationMs?: number): boolean;
  /** 追加可见错误卡；错误码走共享中文映射。 */
  appendError(code: string, message?: string): void;
  /** 设置上下文预算提示（空串表示清除）。只显示文字，不产生气泡，不落执行记录。 */
  setContextNotice(text: string): void;
  /** 切换/恢复会话；migrateFrom 用于新会话稳定后的临时 route 键迁移。 */
  activateSession(key: string, options?: { migrateFrom?: string }): Promise<void>;
  /** 当前会话键。 */
  readonly sessionKey: string;
  /** 清空本机全部 Studio 执行记录。 */
  clearHistory(): Promise<void>;
  /** 持久化状态：memory 表示宿主未就绪或写盘失败。 */
  readonly persistenceState: 'memory' | 'persistent';
  /** 切换 overlay 显隐（ctrl+shift+h），返回切换后是否可见 */
  toggle(): boolean;
  /** 销毁 overlay */
  destroy(): void;
}

export interface StudioChatUIOptions {
  persistence?: StudioExecutionStore;
  initialSessionKey?: string;
  /** 本地无执行记录时，按会话键拉取原生历史；默认使用 DeepSeek history_messages。 */
  hydrateHistory?: (key: string) => Promise<StudioExecutionSession | null>;
}

let styleInjected = false;

function injectChatStyles(): void {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.id = 'ds-studio-chat-styles';
  style.textContent = STUDIO_CHAT_CSS;
  // document_start 阶段 document.head 与 document.documentElement 均可能为 null
  // （Tauri WebView2 极早期触发）。逐级兜底：head → documentElement → 延迟到 DOMContentLoaded。
  const head = document.head ?? document.documentElement;
  if (head) {
    head.appendChild(style);
    styleInjected = true;
  } else {
    // 连 <html> 都没有：监听 documentElement 可用后再注入。
    const tryInject = (): void => {
      if (styleInjected) return;
      const root = document.documentElement;
      if (root) {
        root.appendChild(style);
        styleInjected = true;
      }
    };
    document.addEventListener('DOMContentLoaded', tryInject, { once: true });
    // 兜底的兜底：MutationObserver 等 <html> 出现
    const obs = new MutationObserver(() => {
      if (document.documentElement) { tryInject(); obs.disconnect(); }
    });
    obs.observe(document, { childList: true, subtree: true });
  }
}

/**
 * 动态测量 DeepSeek 输入框（composer）卡片的顶部位置，调整 overlay 的 bottom，
 * 使 overlay 精确停在输入框卡片上方、不盖住输入框（含推荐按钮区）。
 *
 * 锚点：先定位 textarea/contenteditable，再往上爬找输入框卡片根容器
 * （高度>120 且靠近底部），测它的 top——这是卡片上沿（含推荐按钮区），
 * 比单测 textarea.top 更准（textarea 只是卡片内的子元素）。
 * 不用混淆 class 选择器（随版本变化），输入框元素是稳定锚点。
 *
 * 返回测得的 composer 卡片 top（px），测不到时返回 null（调用方用 CSS 默认值兜底）。
 */
function measureComposerTop(): number | null {
  // 先找 textarea/contenteditable 作为种子
  let seed: Element | null = null;
  const tas = document.querySelectorAll('textarea');
  for (const ta of tas) {
    if (ta.offsetWidth === 0 || ta.offsetHeight === 0) continue;
    const rect = ta.getBoundingClientRect();
    if (rect.width > 50 && rect.height > 10) {
      seed = ta;
      break;
    }
  }
  if (!seed) {
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const ed of editables) {
      const el = ed as HTMLElement;
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 50 && rect.height > 10) {
        seed = ed;
        break;
      }
    }
  }
  if (!seed) return null;

  // 从 textarea 往上爬，找输入框卡片根容器：
  // 第一个高度在 120~400px 之间的祖先元素即为卡片根（含推荐按钮区，比 textarea 高）。
  // 不要求"靠近底部"——DeepSeek 有两种 composer 布局：
  //   1. 对话态：composer 在视口底部（top≈857）
  //   2. 居中欢迎页态：composer 居中显示（top≈445），此时其卡片 _77cefa5 (h=124) 和
  //      _9a2f8e4 (h=247，含推荐按钮) 都不满足 bottom>vh-50，旧逻辑会回退到 textarea.top，
  //      漏掉推荐按钮区导致 overlay 盖住卡片上沿。
  // 上限 400 排除 body/#root 等大容器（height≈vh），避免误攀返回 top≈0。
  let p: Element | null = seed;
  for (let i = 0; i < 10 && p; i++) {
    const r = p.getBoundingClientRect();
    if (r.height > 120 && r.height < 400) {
      return Math.round(r.top);
    }
    p = p.parentElement;
  }
  // 兜底：爬不到合适的根容器，直接用 seed 的 top
  return Math.round(seed.getBoundingClientRect().top);
}

/**
 * 动态测量 DeepSeek 左侧栏（会话历史）的右沿，调整 overlay 的 left，
 * 使 overlay 不盖住左侧栏——只盖消息列表区域。
 *
 * 锚点策略：DeepSeek 侧栏 class 是混淆的（如 dc04ec1d），不含 "sidebar" 等关键词，
 * 用关键词选择器（aside/nav/[class*="sidebar"]）选不到。改用几何遍历：
 * 遍历 body 下所有元素，找「贴左（left≤20）、高（>50% vh）、窄（≤视口宽的 25%）」的元素，
 * 取其中 right 最大者。侧栏通常 250-280px，满足 ≤25%vw（2560 视口时 ≤640px）。
 *
 * 关键排除：Studio 自己注入的元素（class 以 "studio-" 开头，如 studio-sidebar /
 * studio-right-sidebar）不是 DeepSeek 原页面元素，必须跳过，否则会把被移出视口的
 * studio-sidebar（left=-260）误当成侧栏。
 *
 * 返回侧栏右沿 px，测不到返回 0（调用方用 left:0 全宽兜底）。
 */
function measureSidebarRight(): number {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  let best = 0;
  // 遍历限制：只看 body 下的元素，跳过 Studio overlay 自身子树（避免误选）
  const all = document.body ? document.body.querySelectorAll(':scope > *') : [];
  for (const el of all) {
    // 跳过 Studio 自注入元素（studio-sidebar 等）
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls.includes('studio-') || cls.includes('ds-studio') || cls.includes('ds-sc')) continue;
    // 跳过 overlay 容器自身及后代
    if (el.closest('.ds-studio-chat-container')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left <= 20 && r.height > vh * 0.5 && r.width <= vw * 0.25) {
      if (r.right > best) best = r.right;
    }
  }
  // 如果直接子元素没命中（侧栏可能嵌套在 #root > div 下），往里探一层：
  // 找左半区内最宽的「贴左+高」块。遍历 #root 后代，同样排除 studio- 前缀。
  if (best === 0) {
    const root = document.querySelector('#root');
    if (root) {
      // 用 querySelectorAll 扫描 #root 下所有元素（限 2000 个防卡）
      const descendants = root.querySelectorAll('*');
      let scanned = 0;
      for (const el of descendants) {
        if (scanned++ > 2000) break;
        const cls = typeof el.className === 'string' ? el.className : '';
        if (cls.includes('studio-') || cls.includes('ds-studio') || cls.includes('ds-sc')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.left <= 20 && r.height > vh * 0.5 && r.width <= vw * 0.25 && r.width > 0) {
          if (r.right > best) best = r.right;
        }
      }
    }
  }
  return Math.round(best);
}

/**
 * 测量 DeepSeek 左上角悬浮恢复按钮（fab）的下沿高度。
 * 侧栏收起后 DeepSeek 才显示该按钮：一个白底圆角条（侧栏/搜索/新对话），
 * 位于左上角，实测宽约 130-150px、高约 40px。overlay 铺满时会盖住它，
 * 只能靠 Ctrl+Shift+H 隐藏整个 overlay 才能点到。
 * 返回 fab 下沿 px；没有可识别 fab 时返回 0（调用方不做偏移）。
 *
 * 锚点分两级：先用用户提供的精确选择器（fab 嵌在 #root 深层，body 直接子元素
 * 里根本没有它，只扫 body > * 会永远返回 0）；选择器失效时退回几何遍历，
 * 且必须下探 #root 后代，与 measureSidebarRight 的兜底策略保持一致。
 */
const SIDEBAR_FAB_SELECTORS = [
  '#root > div > div.c3ecdb44 > div.dc04ec1d.a02af2e6 > div.ca6d4be1._5a20a69',
  '#root div.ca6d4be1._5a20a69',
  'div.ca6d4be1._5a20a69',
];

function measureSidebarFabTop(): number {
  // 第一级：精确选择器（用户实测提供，含混淆 class，失效时由下一级兜底）
  for (const selector of SIDEBAR_FAB_SELECTORS) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue; // 选择器语法失效不致命，走几何兜底
    }
    let best = 0;
    for (const el of nodes) {
      if (el.closest('.ds-studio-chat-container')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom > best) best = r.bottom;
    }
    if (best > 0) return Math.round(best);
  }

  // 第二级：几何遍历，下探 #root 后代（fab 嵌在 #root 深层，body > * 扫不到）
  let best = 0;
  const roots = [document.body, document.querySelector('#root')];
  for (const scope of roots) {
    if (!scope) continue;
    const all = scope.querySelectorAll('*');
    for (const el of all) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (cls.includes('studio-') || cls.includes('ds-studio') || cls.includes('ds-sc')) continue;
      if (el.closest('.ds-studio-chat-container')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // fab：贴左上（top ≤ 20 且 left ≤ 20）、矮（≤ 64px）、窄（≤ 40% vw），
      // 且必须含可交互控件（按钮/svg），排除顶栏其它纯文本条。
      if (r.top > 20 || r.left > 20) continue;
      if (r.height > 64) continue;
      if (r.width > window.innerWidth * 0.4) continue;
      if (!el.querySelector('button, [role="button"], svg')) continue;
      if (r.bottom > best) best = r.bottom;
    }
  }
  return Math.round(best);
}

/** 调整 overlay 的 bottom（不盖输入框）和 left（不盖左侧栏），并做揭示门控。
 *  bottom = vh - composerTop + 8（留出输入框卡片空间）。
 *  left = sidebarRight + 8（留出左侧栏空间，测不到侧栏时 left=0 全宽）。
 *  揭示门控：只有 composer 落到视口下半区（top > vh*0.4）才认为 SPA 渲染稳定，淡入。 */
function adjustOverlayLayout(container: HTMLElement): void {
  const composerTop = measureComposerTop();
  if (composerTop === null || composerTop <= 0) return; // 测不到，保持 CSS 默认值
  const vh = window.innerHeight;
  // 揭示门控：composer 顶部落到视口下半区才算 SPA 渲染完成。
  // 初次加载 textarea 浮在 y≈445（vh=1009 时 445/1009≈0.44），rendered 后落到底部 y≈857。
  // 用 vh*0.4 作阈值（≈403px），rendered 态稳过线，initial 态压线偏低。
  // 一旦揭示就不再回 pending（SPA 已就绪，后续布局变化由 observer 跟踪即可）。
  if (container.classList.contains('ds-studio-chat-pending')) {
    if (composerTop > vh * 0.4) {
      container.classList.remove('ds-studio-chat-pending');
      console.log('[studio-chat-ui] composer settled at', composerTop, 'px, reveal overlay');
    } else {
      console.log('[studio-chat-ui] composer at', composerTop, 'px (< vh*0.4=', Math.round(vh * 0.4), '), stay pending');
    }
  }
  // 留出 composer 高度 + 一点呼吸空间（8px），避免紧贴
  const bottom = vh - composerTop + 8;
  // 安全下限：至少留 120px，防止异常测量把 overlay 撑满全屏
  const safeBottom = Math.max(120, Math.min(bottom, vh - 120));
  container.style.bottom = safeBottom + 'px';
  // 留出左侧栏空间：left = 侧栏右沿 + 8px 呼吸空间。测不到侧栏则 left=0（全宽）。
  const sidebarRight = measureSidebarRight();
  const safeLeft = sidebarRight > 0 ? sidebarRight + 8 : 0;
  container.style.left = safeLeft + 'px';
  // 左上角 fab 区（DeepSeek 侧栏收起后的悬浮恢复按钮：侧栏/搜索/新对话）
  // 必须保持可点击。overlay 是不透明背景且 z-index 2147483000 在原生页面之上，
  // 只画透明缺口挡不住点击——必须把 overlay 首带真正裁掉。
  // 做法：fab 下沿高度写入 --sc-fab-guard，容器 clip-path 按它裁剪，
  // 被裁区域既不显示也不吃点击；消息列表首行同步下移，内容不被压住。
  const fabGuard = safeLeft > 0 ? 0 : measureSidebarFabTop();
  container.style.setProperty('--sc-fab-guard', `${fabGuard}px`);
  console.log('[studio-chat-ui] overlay layout: bottom=', safeBottom, 'px (composerTop=', composerTop, '), left=', safeLeft, 'px (sidebarRight=', sidebarRight, ', fabGuard=', fabGuard, ')');
}

export function createStudioChatUI(options: StudioChatUIOptions = {}): StudioChatUIHandle {
  // 样式注入安全地延迟（见上方 injectChatStyles 的兜底逻辑）。
  injectChatStyles();

  const hydrateHistory = options.hydrateHistory ?? createHistoryHydrator();

  const container = document.createElement('div');
  container.className = 'ds-studio-chat-container ds-studio-chat-pending';
  console.log('[studio-chat-ui] createStudioChatUI start, injecting styles=', !styleInjected);

  // 消息列表（滚动容器）
  const messageList = document.createElement('div');
  messageList.className = 'ds-sc-message-list';
  container.appendChild(messageList);

  // 执行 Inspector：把 Workbench 右侧工具视图吸收进主 UI，不再另开桌面窗口。
  const inspector = document.createElement('aside');
  inspector.className = 'ds-sc-inspector';
  inspector.setAttribute('aria-hidden', 'true');
  const inspectorHead = document.createElement('div');
  inspectorHead.className = 'ds-sc-inspector-head';
  const inspectorTitle = document.createElement('span');
  inspectorTitle.textContent = '执行 Inspector';
  const inspectorCloseBtn = document.createElement('button');
  inspectorCloseBtn.type = 'button';
  inspectorCloseBtn.className = 'ds-sc-inspector-close';
  inspectorCloseBtn.textContent = '关闭';
  inspectorHead.appendChild(inspectorTitle);
  inspectorHead.appendChild(inspectorCloseBtn);
  const inspectorList = document.createElement('div');
  inspectorList.className = 'ds-sc-inspector-list';
  inspector.appendChild(inspectorHead);
  inspector.appendChild(inspectorList);
  container.appendChild(inspector);

  // 底部状态栏
  const statusBar = document.createElement('div');
  statusBar.className = 'ds-sc-status-bar';
  const statusDot = document.createElement('span');
  statusDot.className = 'ds-sc-status-dot';
  const statusText = document.createElement('span');
  statusText.className = 'ds-sc-status-text';
  statusText.textContent = '就绪';
  statusBar.appendChild(statusDot);
  statusBar.appendChild(statusText);
  // 上下文预算提示：与持久化状态文字并列，空串时不占位（visibility 保持布局稳定）。
  const contextNotice = document.createElement('span');
  contextNotice.className = 'ds-sc-context-notice';
  statusBar.appendChild(contextNotice);
  const persistenceText = document.createElement('span');
  persistenceText.className = 'ds-sc-persistence';
  persistenceText.textContent = options.persistence?.connected ? '本机已连接' : '内存模式';
  statusBar.appendChild(persistenceText);
  const inspectorBtn = document.createElement('button');
  inspectorBtn.type = 'button';
  inspectorBtn.className = 'ds-sc-inspector-toggle';
  inspectorBtn.textContent = '执行面板';
  inspectorBtn.setAttribute('aria-expanded', 'false');
  statusBar.appendChild(inspectorBtn);
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'ds-sc-clear-btn';
  clearBtn.textContent = '清空记录';
  clearBtn.addEventListener('click', () => {
    void clearHistory();
  });
  statusBar.appendChild(clearBtn);
  container.appendChild(statusBar);

  // 回到底部按钮（用户滚走后显示）
  const scrollBtn = document.createElement('div');
  scrollBtn.className = 'ds-sc-scroll-btn';
  scrollBtn.textContent = '↓';
  scrollBtn.title = '回到底部';
  container.appendChild(scrollBtn);

  // 滚动跟随状态（参考 cuckoo pinBottom + suppressPin）
  let pinBottom = true;
  let suppressPin = false;
  function isNearBottom(): boolean {
    return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 90;
  }
  function updateScrollBtn(): void {
    if (!pinBottom && !isNearBottom()) scrollBtn.classList.add('show');
    else scrollBtn.classList.remove('show');
  }
  function scrollToBottom(force = false): void {
    if (force || pinBottom) {
      suppressPin = true;
      messageList.scrollTop = messageList.scrollHeight;
      pinBottom = true;
      requestAnimationFrame(() => { suppressPin = false; });
    }
    updateScrollBtn();
  }
  // 用户滚动：改 pinBottom 状态；程序化滚动（suppressPin）不改
  messageList.addEventListener('scroll', () => {
    if (!suppressPin) pinBottom = isNearBottom();
    updateScrollBtn();
  });
  scrollBtn.addEventListener('click', () => {
    pinBottom = true;
    scrollToBottom(true);
  });

  // 当前流式助手消息的引用
  let currentAssistant: HTMLElement | null = null;
  // 当前流式文本的累积（用于 finishAssistantMessage 时 renderMarkdown）
  let currentRawText = '';
  // 当前思考段文本累积
  let currentReasoning = '';
  // 用户是否手动操作过 think 块（true 后不再自动折叠/展开）
  let thinkUserToggled = false;
  // 执行记录按 DeepSeek 会话绑定；事件只落边界，不按 token 写盘。
  let sessionKey = options.initialSessionKey ?? normalizeSessionKeyFromPathname(location.pathname);
  let executionSession: StudioExecutionSession = createEmptyStudioExecutionSession(sessionKey);
  let currentTurnId = crypto.randomUUID();
  let sessionGeneration = 0;
  let persistenceState: 'memory' | 'persistent' = options.persistence?.connected ? 'persistent' : 'memory';
  let recordFinalPending = true;
  const toolCardRoots = new Map<string, HTMLElement>();
  const toolCardTurns = new Map<string, string>();
  const inspectorEntries = new Map<string, HTMLElement>();
  let inspectorErrorSeq = 0;
  let inspectorOpen = false;

  function setInspectorOpen(open: boolean): void {
    inspectorOpen = open;
    inspector.classList.toggle('open', open);
    inspector.setAttribute('aria-hidden', String(!open));
    inspectorBtn.setAttribute('aria-expanded', String(open));
  }
  inspectorBtn.addEventListener('click', () => setInspectorOpen(!inspectorOpen));
  inspectorCloseBtn.addEventListener('click', () => setInspectorOpen(false));

  function inspectorEmpty(message = '暂无工具执行记录'): void {
    const empty = document.createElement('div');
    empty.className = 'ds-sc-inspector-meta';
    empty.dataset.inspectorEmpty = 'true';
    empty.textContent = message;
    inspectorList.appendChild(empty);
  }

  function clearInspector(): void {
    inspectorEntries.clear();
    inspectorErrorSeq = 0;
    inspectorList.replaceChildren();
    inspectorEmpty();
  }

  function renderInspectorEntry(
    key: string,
    toolName: string,
    phase: string,
    durationMs?: number,
    error?: string,
  ): void {
    inspectorList.querySelector('[data-inspector-empty="true"]')?.remove();
    let item = inspectorEntries.get(key);
    if (!item) {
      item = document.createElement('div');
      item.className = 'ds-sc-inspector-item';
      item.dataset.inspectorKey = key;
      inspectorEntries.set(key, item);
      inspectorList.appendChild(item);
    }
    item.dataset.phase = phase;
    item.replaceChildren();

    const tool = document.createElement('div');
    tool.className = 'ds-sc-inspector-tool';
    tool.textContent = toolName;
    item.appendChild(tool);

    const meta = document.createElement('div');
    meta.className = 'ds-sc-inspector-meta';
    const phaseLabel = phase === 'started' ? '运行中…'
      : phase === 'succeeded' ? '成功'
        : phase === 'denied' ? '已拒绝'
          : phase === 'cancelled' ? '已取消'
            : phase === 'error' ? '错误'
              : '失败';
    meta.textContent = durationMs === undefined ? phaseLabel : `${phaseLabel} · ${durationMs}ms`;
    item.appendChild(meta);

    if (error) {
      const err = document.createElement('div');
      err.className = 'ds-sc-inspector-error';
      err.textContent = error;
      item.appendChild(err);
    }
    inspectorList.scrollTop = inspectorList.scrollHeight;
  }

  function appendInspectorError(code: string, message: string): void {
    renderInspectorEntry(`error:${++inspectorErrorSeq}`, '系统错误', 'error', undefined, `${message} (${code})`);
  }

  clearInspector();

  function syncPersistenceLabel(): void {
    persistenceText.textContent = persistenceState === 'persistent' ? '本机已保存' : '内存模式';
  }
  syncPersistenceLabel();

  function recordEvent(event: StudioExecutionEvent): void {
    // 孤儿错误不入账：失败请求可能发生在没有 user-message 的回合（新会话首包
    // 没抓到 userText、续跑请求失败等），turnId 归属上一个回合。若照记，
    // 重放时错误卡会出现在已成功的 final-answer 之后，用户看到「执行未完成」。
    if (event.type === 'system-error' && !turnHasUserMessage(event.turnId)) {
      console.warn('[studio-chat-ui] drop orphan system-error, no user-message in turn:', event.code);
      return;
    }
    appendExecutionEvent(executionSession, event, STUDIO_EXECUTION_MAX_EVENTS);
    const persistence = options.persistence;
    if (!persistence || !persistence.connected) {
      persistenceState = 'memory';
      syncPersistenceLabel();
      return;
    }
    persistenceState = 'persistent';
    syncPersistenceLabel();
    void persistence.saveEvent(sessionKey, event)
      .then(() => {
        persistenceState = 'persistent';
        syncPersistenceLabel();
      })
      .catch(() => {
        persistenceState = 'memory';
        syncPersistenceLabel();
      });
  }

  /** 当前执行会话里该 turnId 是否已有 user-message（用于拒绝孤儿错误）。 */
  function turnHasUserMessage(turnId: string): boolean {
    return executionSession.events.some(
      (event) => event.type === 'user-message' && event.turnId === turnId,
    );
  }

  function clearMessagesForSession(): void {
    messageList.replaceChildren();
    currentAssistant = null;
    currentRawText = '';
    currentReasoning = '';
    thinkUserToggled = false;
    toolCardRoots.clear();
    toolCardTurns.clear();
    clearInspector();
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
  }

  function addWelcomeOrEmpty(message = '在下方输入框发送消息，工具调用与最终结论将显示在此处'): void {
    const empty = document.createElement('div');
    empty.className = 'ds-sc-empty-state';
    empty.dataset.studioEmptyState = 'true';
    const title = document.createElement('div');
    title.className = 'ds-sc-empty-title';
    title.textContent = 'DeepSeek Studio';
    const body = document.createElement('div');
    body.className = 'ds-sc-empty-body';
    body.textContent = message;
    const hint = document.createElement('div');
    hint.className = 'ds-sc-empty-hint';
    hint.textContent = 'Ctrl+Shift+H 切换显示/隐藏';
    empty.appendChild(title);
    empty.appendChild(body);
    empty.appendChild(hint);
    messageList.appendChild(empty);
  }

  addWelcomeOrEmpty();

  /** 给消息元素挂复制按钮（hover 显示，点击复制 innerText） */
  function attachCopy(msg: HTMLElement): void {
    const btn = document.createElement('span');
    btn.className = 'ds-sc-copy-btn';
    btn.textContent = '复制';
    btn.addEventListener('click', () => {
      const text = msg.innerText.replace(/​/g, '');
      try {
        navigator.clipboard?.writeText(text);
      } catch { /* 剪贴板不可用，忽略 */ }
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    });
    msg.appendChild(btn);
  }

  /** 给代码块挂语言标签 + 复制按钮（渲染后调用） */
  function enhanceCodeBlocks(scope: HTMLElement): void {
    const pres = scope.querySelectorAll('pre');
    for (const pre of pres) {
      if (pre.querySelector('.ds-sc-code-lang') || pre.querySelector('.ds-sc-code-copy')) continue;
      const code = pre.querySelector('code');
      if (!code) continue;
      const cls = code.className || '';
      const langMatch = cls.match(/language-(\w+)/);
      const lang = langMatch ? langMatch[1] : '';
      if (lang) {
        const tag = document.createElement('span');
        tag.className = 'ds-sc-code-lang';
        tag.textContent = lang;
        pre.appendChild(tag);
      }
      const copyBtn = document.createElement('span');
      copyBtn.className = 'ds-sc-code-copy';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', () => {
        const text = code.textContent || '';
        try {
          navigator.clipboard?.writeText(text);
        } catch { /* ignore */ }
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      });
      pre.appendChild(copyBtn);
    }
  }

  function addUserMessage(text: string): void {
    messageList.querySelector('[data-studio-empty-state="true"]')?.remove();

    const msg = document.createElement('div');
    msg.className = 'ds-sc-msg-user';
    msg.textContent = text;
    attachCopy(msg);
    messageList.appendChild(msg);
    currentTurnId = crypto.randomUUID();
    recordEvent({ type: 'user-message', at: Date.now(), turnId: currentTurnId, text });
    scrollToBottom(true);
  }

  function startAssistantMessage(sender?: { name?: string; type?: 'user' | 'main-bot' | 'sub-bot' }): void {
    messageList.querySelector('[data-studio-empty-state="true"]')?.remove();

    const msg = document.createElement('div');
    // v0.27：按 sender.type 加多参与者样式类（sub-bot 紫色调区分 main-bot 蓝色调）
    const senderType = sender?.type ?? 'main-bot';
    msg.className = `ds-sc-msg-assistant ds-sc-msg-${senderType}`;

    // v0.27：头像 + 名称标签（多参与者区分谁说的）
    const meta = document.createElement('div');
    meta.className = 'ds-sc-sender-row';
    const avatar = document.createElement('span');
    avatar.className = 'ds-sc-avatar';
    const senderName = sender?.name ?? '助手';
    avatar.textContent = senderName.slice(0, 2);
    const label = document.createElement('span');
    label.className = 'ds-sc-sender';
    label.textContent = senderName;
    meta.appendChild(avatar);
    meta.appendChild(label);
    msg.appendChild(meta);

    // 思考块（可折叠，默认不显示——无 reasoning 时不显示）
    const think = document.createElement('div');
    think.className = 'ds-sc-think';
    think.style.display = 'none';
    const thinkHead = document.createElement('div');
    thinkHead.className = 'ds-sc-think-head';
    const thinkCaret = document.createElement('span');
    thinkCaret.className = 'ds-sc-think-caret';
    thinkCaret.textContent = '▶';
    const thinkLabel = document.createElement('span');
    thinkLabel.textContent = '思考中…';
    thinkHead.appendChild(thinkCaret);
    thinkHead.appendChild(thinkLabel);
    const thinkBody = document.createElement('div');
    thinkBody.className = 'ds-sc-think-body';
    think.appendChild(thinkHead);
    think.appendChild(thinkBody);
    thinkHead.addEventListener('click', () => {
      think.classList.toggle('open');
      thinkUserToggled = true;
    });
    msg.appendChild(think);

    // 流式正文容器（工具容器由 tool-card-ui 的 getOrCreateToolsContainer 按需创建，
    // 插入到此元素前面，保持「工具在上、结论在下」的顺序）
    const streaming = document.createElement('div');
    streaming.className = 'ds-sc-streaming';
    msg.appendChild(streaming);

    attachCopy(msg);

    messageList.appendChild(msg);
    currentAssistant = msg;
    currentRawText = '';
    currentReasoning = '';
    thinkUserToggled = false;
    recordFinalPending = true;
    // QD-R2-15：上一轮在飞的 80ms 节流 timer 必须 clear，否则它触发时会把新一轮
    // currentAssistant 置空（见 :423），绕过 :421 的节流门多渲一次。
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
    scrollToBottom(true);
  }

  // 流式渲染节流（参考 cuckoo 80ms 节流 + 全量 re-parse markdown）
  let streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleStreamRender(): void {
    if (streamRenderTimer) return;
    streamRenderTimer = setTimeout(() => {
      streamRenderTimer = null;
      renderStreaming();
    }, 80);
  }
  function renderStreaming(): void {
    if (!currentAssistant) return;
    const streaming = currentAssistant.querySelector('.ds-sc-streaming') as HTMLElement | null;
    if (!streaming) return;
    if (currentRawText) {
      streaming.innerHTML = renderMarkdown(currentRawText) + '<span class="ds-sc-cursor"></span>';
      enhanceCodeBlocks(streaming);
    }
    scrollToBottom();
  }

  function appendToAssistantMessage(text: string): void {
    if (!currentAssistant) startAssistantMessage();
    currentRawText += text;
    // 正文出现：自动折叠 think 块（除非用户手动操作过）
    if (!thinkUserToggled && currentReasoning) {
      const think = currentAssistant!.querySelector('.ds-sc-think');
      if (think) think.classList.remove('open');
    }
    scheduleStreamRender();
  }

  function appendReasoning(text: string): void {
    if (!currentAssistant) startAssistantMessage();
    currentReasoning = text; // 全量快照（interceptor 传累积值）
    const think = currentAssistant!.querySelector('.ds-sc-think') as HTMLElement | null;
    if (!think) return;
    think.style.display = '';
    const body = think.querySelector('.ds-sc-think-body') as HTMLElement | null;
    const label = think.querySelector('.ds-sc-think-head > span:last-child') as HTMLElement | null;
    if (body) body.textContent = text;
    // 正文未出现时保持展开；正文出现后折叠（由 appendToAssistantMessage 处理）
    if (!currentRawText && !thinkUserToggled) {
      think.classList.add('open');
    }
    if (label) label.textContent = '已思考（' + text.length + ' 字）';
    scrollToBottom();
  }

  function finishAssistantMessage(finishOptions?: { recordFinal?: boolean; fallbackText?: string }): void {
    if (!currentAssistant) return;
    // 刷出节流里未渲染的尾部
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
    const streaming = currentAssistant.querySelector('.ds-sc-streaming') as HTMLElement | null;
    const displayText = (finishOptions?.fallbackText ?? currentRawText).trim();
    if (streaming && displayText) {
      const html = renderMarkdown(displayText);
      const markdownDiv = document.createElement('div');
      markdownDiv.className = 'ds-sc-markdown';
      // security-ok: html 来自上方 renderMarkdown() 的 DOMPurify 输出
      markdownDiv.innerHTML = html;
      enhanceCodeBlocks(markdownDiv);
      streaming.replaceWith(markdownDiv);
    } else if (streaming) {
      // QD-R8-01：没有任何可见正文时（模型只输出思考 / 回复被上游吞掉），
      // 此前这里的 `streaming` 节点被原样留在消息里 —— 里面的 `.ds-sc-cursor`
      // 会一直闪，视觉上等于「还在输出」。收尾时必须把光标摘掉。
      streaming.remove();
    }
    if (recordFinalPending && finishOptions?.recordFinal !== false && displayText) {
      const limited = limitFinalAnswer(displayText);
      recordEvent({
        type: 'final-answer',
        at: Date.now(),
        turnId: currentTurnId,
        text: limited.text,
        truncationMarker: limited.truncationMarker,
      });
      if (limited.truncationMarker) {
        const note = document.createElement('div');
        note.className = 'ds-sc-truncation-note';
        note.textContent = limited.truncationMarker.replace(/^[\s>]+/, '');
        currentAssistant.appendChild(note);
      }
    }
    recordFinalPending = false;
    currentAssistant = null;
    currentRawText = '';
    currentReasoning = '';
    thinkUserToggled = false;
    scrollToBottom();
  }

  function setBusy(busy: boolean): void {
    statusDot.className = busy ? 'ds-sc-status-dot busy' : 'ds-sc-status-dot done';
    statusText.textContent = busy ? '执行中…' : '完成';
  }

  function setContextNotice(text: string): void {
    const next = text.trim();
    contextNotice.textContent = next;
    contextNotice.classList.toggle('visible', next.length > 0);
    // 提示只做可读化，不进执行记录（那是对话内容，不是状态栏文字）。
  }

  function startToolCard(callId: string, data: ToolCardData): boolean {
    if (!currentAssistant) startAssistantMessage();
    if (!currentAssistant) return false;
    renderInspectorEntry(callId, data.toolName, 'started');
    createRedesignedToolCard(data, callId, currentAssistant);
    toolCardRoots.set(callId, currentAssistant);
    toolCardTurns.set(callId, currentTurnId);
    recordEvent({
      type: 'tool-start',
      at: Date.now(),
      turnId: currentTurnId,
      callId,
      toolName: data.toolName,
      params: limitToolPayload(data.params),
    });
    scrollToBottom();
    return true;
  }

  function finishToolCard(
    callId: string,
    data: ToolCardData,
    result: ToolCardData['result'],
    durationMs?: number,
  ): boolean {
    const cardRoot = toolCardRoots.get(callId) ?? currentAssistant;
    if (!cardRoot || !result) return false;
    if (!cardRoot.isConnected) {
      // 会话已切换/清空时不要把旧结果写进新会话。
      toolCardRoots.delete(callId);
      toolCardTurns.delete(callId);
      return false;
    }
    updateRedesignedToolCardByCallId(callId, data, result, cardRoot, durationMs);
    renderInspectorEntry(
      callId,
      data.toolName,
      result.ok === true && result.isError !== true ? 'succeeded' : 'failed',
      durationMs,
      result.ok === true && result.isError !== true ? undefined : result.error,
    );
    const eventTurnId = toolCardTurns.get(callId) ?? currentTurnId;
    toolCardRoots.delete(callId);
    toolCardTurns.delete(callId);
    recordEvent({
      type: 'tool-result',
      at: Date.now(),
      turnId: eventTurnId,
      callId,
      toolName: data.toolName,
      ok: result.ok === true && result.isError !== true,
      durationMs,
      result: limitToolPayload({
        data: result.data,
        content: result.content,
        details: result.details,
        isError: result.isError,
        terminate: result.terminate,
      }),
      error: result.error,
    });
    scrollToBottom();
    return true;
  }

  function appendError(code: string, message?: string): void {
    messageList.querySelector('[data-studio-empty-state="true"]')?.remove();
    const card = document.createElement('div');
    card.className = 'ds-sc-error-card';
    const title = document.createElement('div');
    title.className = 'ds-sc-error-title';
    title.textContent = '执行未完成';
    const body = document.createElement('div');
    body.className = 'ds-sc-error-body';
    body.textContent = message || describeErrorCode(code);
    const meta = document.createElement('div');
    meta.className = 'ds-sc-error-code';
    meta.textContent = code;
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(meta);
    messageList.appendChild(card);
    appendInspectorError(code, body.textContent ?? code);
    recordEvent({
      type: 'system-error',
      at: Date.now(),
      turnId: currentTurnId,
      code,
      message: body.textContent ?? code,
    });
    scrollToBottom(true);
  }

  /**
   * 重放历史会话时，把折叠计数的错误渲染成一条汇总条。
   *
   * 为什么不逐张渲染：storage.json 跨会话累积错误事件，其中包含 QD-R4 之前
   * 被静默吞掉、修复后才显形的 network-error / stream-incomplete。逐张重放会让
   * 用户每次切换会话都被历史错误埋掉（「满屏执行未完成」）。汇总条保留可观测性，
   * 同时不冒充「本轮出错」——实时反馈仍由 appendError 负责。
   */
  function appendReplayErrorSummary(counts: Map<string, number>): void {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const detail = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code} x${n}`)
      .join('、');
    const bar = document.createElement('div');
    bar.className = 'ds-sc-replay-error-summary';
    const text = document.createElement('span');
    text.className = 'ds-sc-replay-error-summary-text';
    text.textContent = `历史记录中有 ${total} 条执行未完成（${detail}），非本轮产生`;
    bar.appendChild(text);
    messageList.appendChild(bar);
  }

  /** 重放期间按错误 code 折叠计数的临时表（仅 replayExecutionSession 使用）。 */
  const replayErrorCounts = new Map<string, number>();

  function replayExecutionSession(session: StudioExecutionSession): void {
    clearMessagesForSession();
    executionSession = session;
    currentTurnId = crypto.randomUUID();
    const events = session.events.slice(-STUDIO_EXECUTION_MAX_EVENTS);
    let lastToolAssistant: HTMLElement | null = null;
    const toolStartByCallId = new Map<string, { toolName: string; params: Record<string, unknown> }>();
    // 历史错误按 code 折叠：storage.json 会累积多日错误（含 QD-R4 之前被静默吞掉、
    // 之后才显形的 network-error），逐张重放会把用户埋掉。只留一条汇总。
    replayErrorCounts.clear();
    for (const event of events) {
      if (event.type === 'user-message') {
        const msg = document.createElement('div');
        msg.className = 'ds-sc-msg-user';
        msg.textContent = event.text;
        attachCopy(msg);
        messageList.appendChild(msg);
        lastToolAssistant = null;
      } else if (event.type === 'tool-start') {
        renderInspectorEntry(event.callId, event.toolName, 'started');
        if (!lastToolAssistant) {
          startAssistantMessage({ name: '执行记录', type: 'main-bot' });
          lastToolAssistant = currentAssistant;
        }
        if (lastToolAssistant) {
          const params = event.params as Record<string, unknown>;
          toolStartByCallId.set(event.callId, { toolName: event.toolName, params });
          createRedesignedToolCard({
            toolName: event.toolName,
            params,
          }, event.callId, lastToolAssistant);
        }
      } else if (event.type === 'tool-result') {
        renderInspectorEntry(
          event.callId,
          event.toolName,
          event.ok ? 'succeeded' : 'failed',
          event.durationMs,
          event.ok ? undefined : event.error,
        );
        const target = lastToolAssistant ?? currentAssistant;
        if (target) {
          const started = toolStartByCallId.get(event.callId);
          updateRedesignedToolCardByCallId(event.callId, {
            toolName: started?.toolName ?? event.toolName,
            params: started?.params ?? {},
          }, {
            ok: event.ok,
            data: event.result,
            error: event.error,
            isError: !event.ok,
          }, target, event.durationMs);
        }
      } else if (event.type === 'final-answer') {
        const msg = document.createElement('div');
        msg.className = 'ds-sc-msg-assistant ds-sc-msg-main-bot';
        const markdown = document.createElement('div');
        markdown.className = 'ds-sc-markdown';
        // security-ok: renderMarkdown 已通过 DOMPurify 清洗。
        markdown.innerHTML = renderMarkdown(event.text + (event.truncationMarker ?? ''));
        enhanceCodeBlocks(markdown);
        msg.appendChild(markdown);
        messageList.appendChild(msg);
        lastToolAssistant = null;
      } else if (event.type === 'system-error') {
        // 重放路径：历史错误折叠计数，不在消息流里逐张渲染卡片。
        // 实时路径（appendError）照旧即时出卡——那一张是「本轮」的反馈。
        replayErrorCounts.set(event.code, (replayErrorCounts.get(event.code) ?? 0) + 1);
      }
    }
    currentAssistant = null;
    currentRawText = '';
    currentReasoning = '';
    if (replayErrorCounts.size > 0) {
      appendReplayErrorSummary(replayErrorCounts);
    }
    if (events.length === 0) {
      addWelcomeOrEmpty('暂无 Studio 执行记录。历史会话若未被实时捕获，不会从原生页面反推伪造。');
    }
    setBusy(false);
    scrollToBottom(true);
  }

  async function activateSession(
    key: string,
    activateOptions?: { migrateFrom?: string },
  ): Promise<void> {
    const normalized = key.trim() || normalizeSessionKeyFromPathname(location.pathname);
    const generation = ++sessionGeneration;
    const previousKey = sessionKey;
  // 上下文预算是「当前这条请求」的属性，不属于会话身份。切会话时必须清掉，
  // 否则上一个会话的「已过半」告警会挂在新会话的状态栏上，直到发下一条消息才被覆盖。
  setContextNotice('');
    if (activateOptions?.migrateFrom) {
      // 新对话先落到 route 临时桶，请求体给出 chat_session_id 后原位迁移，
      // 保留当前已显示的消息，不触发一次异步清空/重载。
      sessionKey = normalized;
      executionSession = { ...executionSession, key: normalized, updatedAt: Date.now() };
      if (options.persistence) {
        void options.persistence.renameSession(activateOptions.migrateFrom, normalized);
      }
      return;
    }
    sessionKey = normalized;
    if (normalized === previousKey && executionSession.events.length > 0) {
      // 回合进行中/已有事件：同一会话键重复激活只做落盘，不清屏。
      if (options.persistence?.connected) {
        try {
          await options.persistence.saveSession(executionSession);
          persistenceState = 'persistent';
        } catch {
          persistenceState = 'memory';
        }
        syncPersistenceLabel();
      }
      return;
    }

    // route: 键是"还没拿到 chat_session_id"的临时桶，所有未分配会话共用它，
    // 里面的历史属于更早的一次临时对话。若照常重放，新开对话时上一段结果
    // 会残留在 UI 上。规则：激活 route: 键一律按空白会话处理，
    // 它只作为 migrateFrom 的迁移来源，不作为可回放的身份。
    if (normalized.startsWith('route:')) {
      if (currentAssistant !== null) return; // 回合在飞，不清屏
      sessionKey = normalized;
      clearMessagesForSession();
      executionSession = createEmptyStudioExecutionSession(normalized);
      currentTurnId = crypto.randomUUID();
      addWelcomeOrEmpty();
      persistenceState = options.persistence?.connected ? 'persistent' : 'memory';
      syncPersistenceLabel();
      return;
    }

    const loaded = options.persistence
      ? await options.persistence.loadSession(normalized)
      : null;
    if (generation !== sessionGeneration) return;
    const loadedEvents = loaded?.events ?? [];
    const localUserCount = countUserMessages(loadedEvents);
    const hasRichLocalContent = loadedEvents.some(
      (event) => event.type === 'final-answer' || event.type === 'tool-start' || event.type === 'tool-result',
    );
    if (loaded && loadedEvents.length > 0) {
      // 先把已有记录渲染出来，避免水合期间白屏。
      replayExecutionSession(loaded);
      persistenceState = options.persistence?.connected ? 'persistent' : 'memory';
    } else {
      clearMessagesForSession();
      executionSession = createEmptyStudioExecutionSession(normalized);
      currentTurnId = crypto.randomUUID();
    }

    // 跨设备/其他端创建的会话本地可能没有记录，也可能只捕获到部分轮次。
    // 因此只要同步时间过期就校验一次原生历史；迟到响应由 generation 校验丢弃。
    const isChatSession = normalized.startsWith('chat:');
    const lastSyncedAt = loaded?.historySyncedAt ?? 0;
    const shouldHydrate = isChatSession
      && (lastSyncedAt === 0 || Date.now() - lastSyncedAt >= STUDIO_HISTORY_SYNC_TTL_MS);

    if (shouldHydrate) {
      if (loadedEvents.length === 0) addWelcomeOrEmpty('正在加载该会话的历史内容…');
      let hydrated: StudioExecutionSession | null = null;
      try {
        hydrated = await hydrateHistory(normalized);
      } catch {
        hydrated = null;
      }
      if (generation !== sessionGeneration) return;

      if (hydrated) {
        const hydratedUserCount = countUserMessages(hydrated.events);
        // 本地已有工具卡片等更丰富的信息时，只有原生历史轮数更多才替换；
        // 否则保留本地记录，避免水合丢掉工具执行过程。
        const shouldReplace = hydratedUserCount > localUserCount
          || (!hasRichLocalContent && hydrated.events.length > loadedEvents.length);
        const syncedAt = Date.now();
        if (shouldReplace) {
          hydrated.historySyncedAt = syncedAt;
          replayExecutionSession(hydrated);
          if (options.persistence?.connected) {
            try {
              await options.persistence.saveSession(hydrated);
              persistenceState = 'persistent';
            } catch {
              persistenceState = 'memory';
            }
          }
          syncPersistenceLabel();
          return;
        }
        // 未替换也要记住已校验，避免 TTL 内重复请求。
        if (loaded) {
          loaded.historySyncedAt = syncedAt;
          if (options.persistence?.connected) {
            try {
              await options.persistence.saveSession(loaded);
              persistenceState = 'persistent';
            } catch {
              persistenceState = 'memory';
            }
          }
        } else if (loadedEvents.length === 0) {
          clearMessagesForSession();
          executionSession = createEmptyStudioExecutionSession(normalized);
          currentTurnId = crypto.randomUUID();
          addWelcomeOrEmpty('未找到该会话可显示的历史内容');
        }
      } else if (loadedEvents.length === 0) {
        clearMessagesForSession();
        executionSession = createEmptyStudioExecutionSession(normalized);
        currentTurnId = crypto.randomUUID();
        addWelcomeOrEmpty('未找到该会话可显示的历史内容');
      }
    } else if (loadedEvents.length === 0) {
      addWelcomeOrEmpty(isChatSession ? '未找到该会话可显示的历史内容' : undefined);
    }
    syncPersistenceLabel();
  }

  async function clearHistory(): Promise<void> {
    setContextNotice('');
    try {
      await options.persistence?.clearAll();
      executionSession = createEmptyStudioExecutionSession(sessionKey);
      currentTurnId = crypto.randomUUID();
      clearMessagesForSession();
      addWelcomeOrEmpty('执行记录已清空');
    } catch {
      appendError('storage-unavailable', '清空本机记录失败，请检查宿主连接后重试。');
    }
  }

  function destroy(): void {
    bottomObserver.disconnect();
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
    for (const t of adjustTimers) clearTimeout(t);
    window.removeEventListener('resize', tryAdjust);
    window.removeEventListener('scroll', tryAdjust, { capture: true } as EventListenerOptions);
    window.removeEventListener('keydown', onToggleKey);
    container.remove();
    currentAssistant = null;
    currentRawText = '';
    currentReasoning = '';
    thinkUserToggled = false;
  }

  // ctrl+shift+h 在原网页和 Studio chat UI 间切换（参考 cuckoo-code 切换式叠加布局）。
  // 隐藏时整个 overlay display:none，原网页全可见、可交互。
  let visible = true;
  function toggle(): boolean {
    visible = !visible;
    if (visible) {
      container.classList.remove('ds-studio-chat-hidden');
    } else {
      container.classList.add('ds-studio-chat-hidden');
    }
    window.dispatchEvent(new CustomEvent('studio:visibility-changed', {
      detail: { visible },
    }));
    console.log('[studio-chat-ui] overlay', visible ? 'shown' : 'hidden');
    return visible;
  }
  function onToggleKey(e: KeyboardEvent): void {
    if (e.ctrlKey && e.shiftKey && (e.key === 'h' || e.key === 'H' || e.code === 'KeyH')) {
      e.preventDefault();
      toggle();
    }
  }
  window.addEventListener('keydown', onToggleKey);

  // 动态测量 composer 位置和侧栏右沿，调整 overlay bottom 和 left（不盖输入框、不盖左侧栏）。
  // DeepSeek 是 SPA：textarea 随异步渲染、侧栏折叠、模型切换、窗口 resize 而移动，
  // top 会持续变化。因此保持 MutationObserver 常驻（开销极小，仅 DOM 变化时触发），
  // 不要定时断开——之前 10 秒 disconnect 导致布局变化后不再重测，bottom 锁死旧值。
  // 注意：createStudioChatUI 在 document_start 执行，document.body 可能尚为 null，
  // MutationObserver.observe(null) 会抛 TypeError 导致整个函数中断、overlay 不挂载。
  // 因此 observer 必须延迟到 body 可用后再启动。
  let rafPending = false;
  function tryAdjust(): void {
    // 用 rAF 防抖：连续 DOM mutation 合并到一帧测量，避免高频 getBoundingClientRect
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      adjustOverlayLayout(container);
    });
  }
  const bottomObserver = new MutationObserver(() => { tryAdjust(); });
  function startObserver(): void {
    try {
      if (document.body) {
        bottomObserver.observe(document.body, { childList: true, subtree: true });
      }
    } catch { /* observe 失败不致命，setTimeout 兜底已覆盖 */ }
  }
  // 立即测一次（textarea 可能已存在），并在几个时间点兜底（SPA 渲染慢时）
  tryAdjust();
  // body 可能尚不存在，延迟启动 observer
  if (document.body) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  }
  const adjustTimers = [setTimeout(tryAdjust, 500), setTimeout(tryAdjust, 1500), setTimeout(tryAdjust, 3000)];
  // observer 常驻，不再定时断开（SPA 布局会持续变化）
  window.addEventListener('resize', tryAdjust);
  window.addEventListener('scroll', tryAdjust, { passive: true, capture: true });

  return {
    container,
    addUserMessage,
    startAssistantMessage,
    appendToAssistantMessage,
    appendReasoning,
    finishAssistantMessage,
    setBusy,
    startToolCard,
    finishToolCard,
    appendError,
    setContextNotice,
    activateSession,
    get sessionKey() {
      return sessionKey;
    },
    clearHistory,
    get persistenceState() {
      return persistenceState;
    },
    toggle,
    destroy,
  };
}
