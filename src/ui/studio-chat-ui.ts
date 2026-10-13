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
  document.head.appendChild(style);
  styleInjected = true;
}

export function createStudioChatUI(): StudioChatUIHandle {
  injectChatStyles();

  const container = document.createElement('div');
  container.className = 'ds-studio-chat-container';

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
    container.remove();
    currentAssistant = null;
    currentRawText = '';
  }

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
