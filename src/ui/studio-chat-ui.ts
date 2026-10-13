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
  /** 创建新的助手回复元素（流式容器），后续 appendToAssistantMessage 往里追加 */
  startAssistantMessage(): void;
  /** 流式追加可见文本（终端式 textContent 拼接，高性能无闪烁） */
  appendToAssistantMessage(text: string): void;
  /** 流结束：把累积的流式文本用 renderMarkdown 格式化替换 */
  finishAssistantMessage(): void;
  /** 设置状态栏忙碌/完成状态 */
  setBusy(busy: boolean): void;
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
 * 动态测量 DeepSeek 输入框（composer）的顶部位置，调整 overlay 的 bottom，
 * 使 overlay 精确停在输入框上方、不盖住输入框。
 *
 * 锚点：页面唯一可见 textarea 或 contenteditable 元素（DeepSeek 的输入框）。
 * 不用混淆 class 选择器（随版本变化），输入框元素是稳定锚点。
 *
 * 返回测得的 composer top（px），测不到时返回 null（调用方用 CSS 默认值兜底）。
 */
function measureComposerTop(): number | null {
  const tas = document.querySelectorAll('textarea');
  for (const ta of tas) {
    // 只取可见、有尺寸的 textarea（排除隐藏的）
    if (ta.offsetWidth === 0 || ta.offsetHeight === 0) continue;
    const rect = ta.getBoundingClientRect();
    if (rect.width > 50 && rect.height > 10) {
      return Math.round(rect.top);
    }
  }
  // 兜底：DeepSeek 若改用 contenteditable 输入框
  const editables = document.querySelectorAll('[contenteditable="true"]');
  for (const ed of editables) {
    const el = ed as HTMLElement;
    if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 50 && rect.height > 10) {
      return Math.round(rect.top);
    }
  }
  return null;
}

/** 把 overlay bottom 设成「视口高 - composer top - padding」，精确留出输入框空间。 */
function adjustOverlayBottom(container: HTMLElement): void {
  const composerTop = measureComposerTop();
  if (composerTop === null || composerTop <= 0) return; // 测不到，保持 CSS 默认 bottom:280px
  const vh = window.innerHeight;
  // 留出 composer 高度 + 一点呼吸空间（8px），避免紧贴
  const bottom = vh - composerTop + 8;
  // 安全下限：至少留 120px，防止异常测量把 overlay 撑满全屏
  const safeBottom = Math.max(120, Math.min(bottom, vh - 120));
  container.style.bottom = safeBottom + 'px';
  console.log('[studio-chat-ui] overlay bottom adjusted to', safeBottom, 'px (composerTop=', composerTop, ', vh=', vh, ')');
}

export function createStudioChatUI(): StudioChatUIHandle {
  // 样式注入安全地延迟（见上方 injectChatStyles 的兜底逻辑）。
  injectChatStyles();

  const container = document.createElement('div');
  container.className = 'ds-studio-chat-container';
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

  // 当前流式助手消息的引用
  let currentAssistant: HTMLElement | null = null;
  // 当前流式文本的累积（用于 finishAssistantMessage 时 renderMarkdown）
  let currentRawText = '';

  // 欢迎消息
  const welcome = document.createElement('div');
  welcome.style.cssText = 'margin:auto;text-align:center;padding:40px 20px;color:#999;';
  welcome.innerHTML = '<div style="font-size:20px;font-weight:600;margin-bottom:8px;">DeepSeek Studio</div>'
    + '<div style="font-size:13px;line-height:1.8;">在下方输入框发送消息<br>工具调用与回复将显示在此处</div>';
  messageList.appendChild(welcome);

  function scrollToBottom(): void {
    messageList.scrollTop = messageList.scrollHeight;
  }

  function addUserMessage(text: string): void {
    // 移除欢迎消息
    const w = messageList.querySelector(':scope > [style*="margin:auto"]');
    if (w) w.remove();

    const msg = document.createElement('div');
    msg.className = 'ds-sc-msg-user';
    msg.textContent = text;
    messageList.appendChild(msg);
    scrollToBottom();
  }

  function startAssistantMessage(): void {
    // 移除欢迎消息
    const w = messageList.querySelector(':scope > [style*="margin:auto"]');
    if (w) w.remove();

    const msg = document.createElement('div');
    msg.className = 'ds-sc-msg-assistant';

    // 流式文本容器（工具容器由 tool-card-ui 的 getOrCreateToolsContainer 按需创建，
    // 插入到此元素前面，保持「工具在上、结论在下」的顺序）
    const streaming = document.createElement('div');
    streaming.className = 'ds-sc-streaming';
    msg.appendChild(streaming);

    messageList.appendChild(msg);
    currentAssistant = msg;
    currentRawText = '';
    scrollToBottom();
  }

  function appendToAssistantMessage(text: string): void {
    if (!currentAssistant) startAssistantMessage();
    const streaming = currentAssistant!.querySelector('.ds-sc-streaming') as HTMLElement | null;
    if (!streaming) return;
    currentRawText += text;
    streaming.textContent = currentRawText;
    scrollToBottom();
  }

  function finishAssistantMessage(): void {
    if (!currentAssistant) return;
    const streaming = currentAssistant.querySelector('.ds-sc-streaming') as HTMLElement | null;
    if (streaming && currentRawText) {
      // renderMarkdown 格式化，替换流式纯文本
      const html = renderMarkdown(currentRawText);
      const markdownDiv = document.createElement('div');
      markdownDiv.className = 'ds-sc-markdown';
      markdownDiv.innerHTML = html;
      streaming.replaceWith(markdownDiv);
    }
    currentAssistant = null;
    currentRawText = '';
    scrollToBottom();
  }

  function setBusy(busy: boolean): void {
    statusDot.className = busy ? 'ds-sc-status-dot busy' : 'ds-sc-status-dot done';
    statusText.textContent = busy ? '执行中…' : '完成';
  }

  function destroy(): void {
    bottomObserver.disconnect();
    window.removeEventListener('resize', tryAdjust);
    container.remove();
    currentAssistant = null;
    currentRawText = '';
  }

  // 动态测量 composer 位置，调整 overlay bottom（不盖住输入框）。
  // textarea 可能延迟渲染（DeepSeek SPA 异步挂载），用 MutationObserver 等；
  // 测到后停止观察，避免持续开销。窗口 resize 时也需重测。
  function tryAdjust(): void { adjustOverlayBottom(container); }
  const bottomObserver = new MutationObserver(() => { tryAdjust(); });
  bottomObserver.observe(document.body, { childList: true, subtree: true });
  // textarea 出现后立即测，并在几个时间点兜底（SPA 渲染慢时）
  tryAdjust();
  setTimeout(tryAdjust, 500);
  setTimeout(tryAdjust, 1500);
  setTimeout(tryAdjust, 3000);
  // 测到 composer 后降频：10 秒后停止 MutationObserver（已稳定）
  setTimeout(() => bottomObserver.disconnect(), 10000);
  window.addEventListener('resize', tryAdjust);

  return {
    container,
    addUserMessage,
    startAssistantMessage,
    appendToAssistantMessage,
    finishAssistantMessage,
    setBusy,
    destroy,
  };
}
