/**
 * v0.19 自建聊天 UI overlay
 *
 * 在 DeepSeek 页面上覆盖一个半屏聊天界面，接管消息渲染：
 * - 用户消息：右对齐蓝色气泡
 * - 助手消息：左对齐浅色卡片，流式期 textContent 追加，流结束 renderMarkdown 格式化
 * - 工具卡片：挂载到助手消息内的 .ds-studio-tools-container（复用 tool-card-ui）
 * - 状态栏：底部显示执行中/完成
 *
 * SSE 文本由 main-world-interceptor 推送到本组件，不再写入 DeepSeek DOM。
 */

import { renderMarkdown } from '../inject/markdown';
import { STUDIO_CHAT_CSS } from './studio-chat-css';

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
  finishAssistantMessage(): void;
  /** 设置状态栏忙碌/完成状态 */
  setBusy(busy: boolean): void;
  /** 切换 overlay 显隐（ctrl+shift+h），返回切换后是否可见 */
  toggle(): boolean;
  /** 销毁 overlay */
  destroy(): void;
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
  console.log('[studio-chat-ui] overlay layout: bottom=', safeBottom, 'px (composerTop=', composerTop, '), left=', safeLeft, 'px (sidebarRight=', sidebarRight, ')');
}

export function createStudioChatUI(): StudioChatUIHandle {
  // 样式注入安全地延迟（见上方 injectChatStyles 的兜底逻辑）。
  injectChatStyles();

  const container = document.createElement('div');
  container.className = 'ds-studio-chat-container ds-studio-chat-pending';
  console.log('[studio-chat-ui] createStudioChatUI start, injecting styles=', !styleInjected);

  // 消息列表（滚动容器）
  const messageList = document.createElement('div');
  messageList.className = 'ds-sc-message-list';
  container.appendChild(messageList);

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

  // 欢迎消息
  const welcome = document.createElement('div');
  welcome.style.cssText = 'margin:auto;text-align:center;padding:40px 20px;color:#999;';
  welcome.innerHTML = '<div style="font-size:20px;font-weight:600;margin-bottom:8px;">DeepSeek Studio</div>'
    + '<div style="font-size:13px;line-height:1.8;">在下方输入框发送消息<br>工具调用与回复将显示在此处</div>'
    + '<div style="font-size:12px;line-height:1.8;margin-top:12px;color:#aaa;">Ctrl+Shift+H 切换显示/隐藏</div>';
  messageList.appendChild(welcome);

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
    // 移除欢迎消息
    const w = messageList.querySelector(':scope > [style*="margin:auto"]');
    if (w) w.remove();

    const msg = document.createElement('div');
    msg.className = 'ds-sc-msg-user';
    msg.textContent = text;
    attachCopy(msg);
    messageList.appendChild(msg);
    scrollToBottom(true);
  }

  function startAssistantMessage(sender?: { name?: string; type?: 'user' | 'main-bot' | 'sub-bot' }): void {
    // 移除欢迎消息
    const w = messageList.querySelector(':scope > [style*="margin:auto"]');
    if (w) w.remove();

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

  function finishAssistantMessage(): void {
    if (!currentAssistant) return;
    // 刷出节流里未渲染的尾部
    if (streamRenderTimer) { clearTimeout(streamRenderTimer); streamRenderTimer = null; }
    const streaming = currentAssistant.querySelector('.ds-sc-streaming') as HTMLElement | null;
    if (streaming && currentRawText) {
      const html = renderMarkdown(currentRawText);
      const markdownDiv = document.createElement('div');
      markdownDiv.className = 'ds-sc-markdown';
      // security-ok: html 来自上方 renderMarkdown() 的 DOMPurify 输出
      markdownDiv.innerHTML = html;
      enhanceCodeBlocks(markdownDiv);
      streaming.replaceWith(markdownDiv);
    }
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
    toggle,
    destroy,
  };
}
