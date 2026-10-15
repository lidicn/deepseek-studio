/**
 * v0.28 PoC 聊天室 UI（独立 overlay）
 *
 * 主窗口悬浮按钮 → 打开独立聊天室面板（与日常对话 overlay 隔离）。
 * 连 /agent-ws，发 {type:'send', roomId, text}，收多 bot 事件渲染。
 *
 * 事件渲染关键约定（见 chat-room-runtime.ts generateReply）：
 * - bot 的 {type:'user'} 事件携带内部 sentinel+persona 文本，不是用户原文 → 忽略
 * - {type:'assistant', botId} 是真正的回复 → 渲染气泡
 * - main bot 的 assistant 事件是摘要器输出 → 标注为摘要
 * - {type:'done', botId} → 该 bot 本轮完成
 * - 用户消息在发送侧本地立即渲染（不等 server 事件回传）
 *
 * 多轮并发隔离：main bot 日常对话也会 emit 事件，用 roundInProgress flag 区分——
 * idle 时忽略 main 事件（属于日常对话），round 进行中才把 main assistant 当摘要。
 */

import { el, icon, Icons, injectStyles, createShadowContainer } from './studio-ui-core';
import { renderMarkdown } from '../inject/markdown';

/** Rust 注入的聊天室配置（main 窗口 initialization_script 前置）。 */
export interface ChatRoomRuntimeConfig {
  wsUrl: string;
  token: string;
  roomId: string;
  roomName: string;
  members: readonly string[];
}

export interface ChatRoomHandle {
  container: HTMLElement;
  show(): void;
  hide(): void;
  toggle(): void;
  destroy(): void;
}

/** 成员配色（头像 + 左边框），按 botId 稳定分配。 */
const BOT_COLORS: Record<string, { bg: string; border: string }> = {
  'frontend-expert': { bg: '#22c55e', border: '#22c55e' },
  'backend-expert': { bg: '#f59e0b', border: '#f59e0b' },
  'audit-expert': { bg: '#8b5cf6', border: '#8b5cf6' },
  main: { bg: '#4D6BFE', border: '#4D6BFE' },
};
const DEFAULT_COLOR = { bg: '#6b7280', border: '#6b7280' };

interface ChatRoomEvent {
  type: 'user' | 'assistant' | 'tool' | 'status' | 'error' | 'done';
  text?: string;
  step?: number;
  toolCalls?: number;
  botId?: string;
}

export function createChatRoom(config: ChatRoomRuntimeConfig): ChatRoomHandle {
  const { container, shadow } = createShadowContainer('studio-chat-room-root');
  injectStyles(shadow, CHAT_ROOM_CSS);

  // ===== FAB（右下角，避开左上角 sidebar FAB）=====
  const fab = el('button', { className: 'studio-chat-fab', attrs: { title: '聊天室' } }, [
    icon(Icons.message, 20),
  ]);

  // ===== 遮罩 =====
  const overlay = el('div', { className: 'studio-chat-overlay' });

  // ===== 面板 =====
  const panel = el('div', { className: 'studio-chat-panel' });

  // 头部
  const header = el('div', { className: 'studio-chat-header' });
  const headerLeft = el('div', { className: 'studio-chat-header-left' });
  const roomTitle = el('div', { className: 'studio-chat-room-name', text: config.roomName });
  const memberChips = el('div', { className: 'studio-chat-members' });
  const connDot = el('span', { className: 'studio-chat-conn-dot' });
  const connText = el('span', { className: 'studio-chat-conn-text', text: '连接中…' });
  const connBox = el('div', { className: 'studio-chat-conn' }, [connDot, connText]);
  headerLeft.appendChild(roomTitle);
  headerLeft.appendChild(memberChips);
  headerLeft.appendChild(connBox);
  const closeBtn = el('button', { className: 'studio-chat-close', attrs: { title: '关闭' } }, [
    icon(Icons.x, 18),
  ]);
  header.appendChild(headerLeft);
  header.appendChild(closeBtn);

  // 消息列表
  const messages = el('div', { className: 'studio-chat-messages' });
  const welcome = el('div', { className: 'studio-chat-welcome' });
  welcome.innerHTML = `<div class="studio-chat-welcome-title">聊天室 · ${config.roomName}</div>`
    + '<div class="studio-chat-welcome-sub">在下方输入消息，用 @all 或 @成员名 指定回复者</div>';
  messages.appendChild(welcome);

  // 输入区
  const composer = el('div', { className: 'studio-chat-composer' });
  const input = document.createElement('textarea');
  input.className = 'studio-chat-input';
  input.rows = 2;
  input.placeholder = `@all 或 @${config.members[0] ?? '成员'} …（Enter 发送，Shift+Enter 换行）`;
  const sendBtn = el('button', { className: 'studio-chat-send', text: '发送' });
  composer.appendChild(input);
  composer.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(messages);
  panel.appendChild(composer);

  shadow.appendChild(fab);
  shadow.appendChild(overlay);
  shadow.appendChild(panel);

  // ===== 成员 chips =====
  const allMembers = ['main', ...config.members];
  for (const m of allMembers) {
    const color = BOT_COLORS[m] ?? DEFAULT_COLOR;
    const chip = el('button', { className: 'studio-chat-member-chip', text: '@' + m });
    chip.style.borderLeftColor = color.border;
    chip.addEventListener('click', () => {
      const insert = (input.value.endsWith(' ') || input.value === '') ? `@${m} ` : ` @${m} `;
      input.value += insert;
      input.focus();
    });
    memberChips.appendChild(chip);
  }

  // ===== 状态 =====
  let ws: WebSocket | null = null;
  let connected = false;
  let roundInProgress = false;
  let reqSeq = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 500;
  // 正在思考的 bot（收到 status/user、还没 done）
  const thinkingBots = new Set<string>();

  // ===== WS 连接 =====
  function connect(): void {
    const url = `${config.wsUrl}?token=${encodeURIComponent(config.token)}`;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[chat-room] WS construct failed', e);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      backoff = 500;
      connected = true;
      connDot.className = 'studio-chat-conn-dot ok';
      connText.textContent = '已连接';
    };
    ws.onclose = (ev) => {
      connected = false;
      ws = null;
      connDot.className = 'studio-chat-conn-dot bad';
      connText.textContent = ev.code === 1008 ? '鉴权失败（请重启应用）' : '连接断开，重试中…';
      if (ev.code !== 1008) scheduleReconnect();
    };
    ws.onerror = () => { try { ws?.close(); } catch { /* */ } };
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(ev.data as string) as Record<string, unknown>; } catch { return; }
      handleServerMessage(msg);
    };
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, 10_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(payload: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(payload)); } catch (e) { console.error('[chat-room] send failed', e); }
    }
  }

  // ===== 服务端消息处理 =====
  function handleServerMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    if (type === 'state') {
      // 更新连接状态即可（成员已从 config 渲染）
      return;
    }
    if (type === 'ack') {
      if (msg.ok !== true && typeof msg.error === 'string') {
        appendStatus(`操作失败：${msg.error}`);
      }
      return;
    }
    if (type === 'event') {
      const event = msg.event as ChatRoomEvent | undefined;
      if (!event) return;
      handleEvent(event);
    }
  }

  function handleEvent(event: ChatRoomEvent): void {
    const botId = event.botId ?? 'main';
    switch (event.type) {
      case 'user':
        // 内部 persona prompt，不渲染为用户消息。
        // 标记该 bot 开始思考（用于显示思考指示器）
        thinkingBots.add(botId);
        break;
      case 'status':
        // 可选状态提示；若是聊天室相关 bot，标记思考中
        if (config.members.includes(botId) || botId === 'main') {
          thinkingBots.add(botId);
        }
        break;
      case 'assistant':
        thinkingBots.delete(botId);
        if (botId === 'main' && roundInProgress) {
          // 摘要器输出
          appendSummary(event.text ?? '');
        } else if (config.members.includes(botId)) {
          // 专家回复
          appendBotMessage(botId, event.text ?? '');
        }
        // idle 时的 main assistant 属于日常对话，忽略
        break;
      case 'done':
        thinkingBots.delete(botId);
        if (botId === 'main' && roundInProgress) {
          // 本轮结束（摘要器 done）
          roundInProgress = false;
          updateComposerState();
        }
        break;
      case 'tool':
        // 工具徽章（PoC 简化：附在当前消息后或忽略）
        break;
      case 'error':
        thinkingBots.delete(botId);
        if (event.text) appendErrorMessage(botId, event.text);
        break;
    }
  }

  // ===== 渲染 =====
  function removeWelcome(): void {
    const w = messages.querySelector('.studio-chat-welcome');
    if (w) w.remove();
  }

  function scrollToBottom(): void {
    messages.scrollTop = messages.scrollHeight;
  }

  function appendUserMessage(text: string): void {
    removeWelcome();
    const msg = el('div', { className: 'studio-chat-msg studio-chat-msg-user', text });
    messages.appendChild(msg);
    scrollToBottom();
  }

  function appendBotMessage(botId: string, text: string): void {
    removeWelcome();
    const color = BOT_COLORS[botId] ?? DEFAULT_COLOR;
    const msg = el('div', { className: 'studio-chat-msg studio-chat-msg-bot' });
    msg.style.borderLeftColor = color.border;
    const meta = el('div', { className: 'studio-chat-sender-row' });
    const avatar = el('span', { className: 'studio-chat-avatar', text: botId.slice(0, 2) });
    avatar.style.background = color.bg;
    const name = el('span', { className: 'studio-chat-sender', text: botId });
    meta.appendChild(avatar);
    meta.appendChild(name);
    msg.appendChild(meta);
    const body = el('div', { className: 'studio-chat-msg-body' });
    body.innerHTML = renderMarkdown(text);
    enhanceCodeBlocks(body);
    msg.appendChild(body);
    messages.appendChild(msg);
    scrollToBottom();
  }

  function appendSummary(text: string): void {
    removeWelcome();
    const msg = el('div', { className: 'studio-chat-msg studio-chat-msg-summary' });
    const label = el('div', { className: 'studio-chat-summary-label', text: '📋 本轮摘要' });
    msg.appendChild(label);
    const body = el('div', { className: 'studio-chat-msg-body' });
    body.innerHTML = renderMarkdown(text);
    enhanceCodeBlocks(body);
    msg.appendChild(body);
    messages.appendChild(msg);
    scrollToBottom();
  }

  function appendErrorMessage(botId: string, text: string): void {
    removeWelcome();
    const msg = el('div', { className: 'studio-chat-msg studio-chat-msg-error' });
    msg.textContent = `[${botId}] 错误：${text}`;
    messages.appendChild(msg);
    scrollToBottom();
  }

  function appendStatus(text: string): void {
    const msg = el('div', { className: 'studio-chat-msg studio-chat-msg-status', text });
    messages.appendChild(msg);
    scrollToBottom();
  }

  /** 给代码块挂语言标签 + 复制按钮（复用 studio-chat-ui 思路）。 */
  function enhanceCodeBlocks(scope: HTMLElement): void {
    const pres = scope.querySelectorAll('pre');
    for (const pre of pres) {
      if (pre.querySelector('.studio-chat-code-copy')) continue;
      const code = pre.querySelector('code');
      if (!code) continue;
      const cls = code.className || '';
      const langMatch = cls.match(/language-(\w+)/);
      if (langMatch) {
        const tag = el('span', { className: 'studio-chat-code-lang', text: langMatch[1] });
        pre.appendChild(tag);
      }
      const copyBtn = el('span', { className: 'studio-chat-code-copy', text: '复制' });
      copyBtn.addEventListener('click', () => {
        const t = code.textContent || '';
        try { navigator.clipboard?.writeText(t); } catch { /* */ }
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      });
      pre.appendChild(copyBtn);
    }
  }

  // ===== 发送 =====
  function submitMessage(): void {
    const text = input.value.trim();
    if (!text || roundInProgress || !connected) return;
    input.value = '';
    appendUserMessage(text);
    roundInProgress = true;
    thinkingBots.clear();
    updateComposerState();
    const reqId = `cr${++reqSeq}`;
    send({ type: 'send', roomId: config.roomId, text, reqId });
  }

  function updateComposerState(): void {
    sendBtn.disabled = roundInProgress || !connected;
    sendBtn.textContent = roundInProgress ? '进行中…' : '发送';
    input.disabled = roundInProgress;
    if (roundInProgress) {
      const indicator = el('div', { className: 'studio-chat-round-indicator', text: '专家讨论中…' });
      messages.appendChild(indicator);
      scrollToBottom();
    } else {
      const ind = messages.querySelector('.studio-chat-round-indicator');
      if (ind) ind.remove();
    }
  }

  // ===== 开关 =====
  let isOpen = false;
  let escHandler: ((e: KeyboardEvent) => void) | null = null;

  function show(): void {
    isOpen = true;
    overlay.classList.add('visible');
    panel.classList.add('visible');
    escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', escHandler);
    // 懒连接：首次打开才连 WS
    if (!ws && !connected) connect();
    setTimeout(() => input.focus(), 50);
  }

  function hide(): void {
    isOpen = false;
    overlay.classList.remove('visible');
    panel.classList.remove('visible');
    if (escHandler) {
      window.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
  }

  function toggle(): void {
    if (isOpen) hide(); else show();
  }

  // ===== 事件绑定 =====
  fab.addEventListener('click', toggle);
  overlay.addEventListener('click', hide);
  closeBtn.addEventListener('click', hide);
  sendBtn.addEventListener('click', submitMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  });

  function destroy(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (escHandler) { window.removeEventListener('keydown', escHandler); escHandler = null; }
    if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
    container.remove();
  }

  return { container, show, hide, toggle, destroy };
}

// ===== CSS =====
const CHAT_ROOM_CSS = `
/* FAB（右下角，避开左上角 sidebar FAB） */
.studio-chat-fab {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border: none;
  box-shadow: 0 4px 14px rgba(77,107,254,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483646;
  transition: all 0.2s ease;
}
.studio-chat-fab:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 20px rgba(77,107,254,0.5);
}
.studio-chat-fab svg { width: 20px; height: 20px; }

/* 遮罩 */
.studio-chat-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  z-index: 2147483644;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
}
.studio-chat-overlay.visible {
  opacity: 1;
  visibility: visible;
}

/* 面板 */
.studio-chat-panel {
  position: fixed;
  bottom: 80px;
  right: 20px;
  width: min(560px, 92vw);
  height: min(680px, 82vh);
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  display: flex;
  flex-direction: column;
  z-index: 2147483645;
  overflow: hidden;
  transform: translateX(120%) scale(0.95);
  opacity: 0;
  visibility: hidden;
  transition: transform 0.25s ease, opacity 0.25s ease, visibility 0.25s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.studio-chat-panel.visible {
  transform: translateX(0) scale(1);
  opacity: 1;
  visibility: visible;
}

/* 头部 */
.studio-chat-header {
  flex-shrink: 0;
  padding: 12px 16px;
  background: #f8f9fc;
  border-bottom: 1px solid #e8e8ee;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.studio-chat-header-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.studio-chat-room-name {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a2e;
}
.studio-chat-members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.studio-chat-member-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid #e0e0e8;
  border-left: 3px solid #ccc;
  background: #fff;
  color: #666;
  cursor: pointer;
  transition: all 0.15s ease;
}
.studio-chat-member-chip:hover {
  background: #f0f0f5;
  color: #333;
}
.studio-chat-conn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #999;
}
.studio-chat-conn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ccc;
}
.studio-chat-conn-dot.ok { background: #22c55e; }
.studio-chat-conn-dot.bad { background: #ef4444; }
.studio-chat-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #999;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.studio-chat-close:hover { background: #e8e8ee; color: #555; }

/* 消息列表 */
.studio-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scroll-behavior: smooth;
}
.studio-chat-messages::-webkit-scrollbar { width: 7px; }
.studio-chat-messages::-webkit-scrollbar-thumb { background: #d0d0d8; border-radius: 4px; }

/* 欢迎占位 */
.studio-chat-welcome {
  margin: auto;
  text-align: center;
  padding: 40px 20px;
  color: #aaa;
}
.studio-chat-welcome-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #888; }
.studio-chat-welcome-sub { font-size: 13px; line-height: 1.7; }

/* 用户消息 */
.studio-chat-msg-user {
  align-self: flex-end;
  max-width: 78%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border-radius: 14px 14px 4px 14px;
  padding: 10px 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* bot 消息 */
.studio-chat-msg-bot {
  align-self: flex-start;
  max-width: 88%;
  background: #f6f7f9;
  border: 1px solid #e8e8ee;
  border-left: 3px solid #4D6BFE;
  border-radius: 4px 14px 14px 4px;
  padding: 10px 14px;
  word-break: break-word;
}
.studio-chat-sender-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.studio-chat-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 50%;
  font-size: 10px; font-weight: 600; color: #fff;
  flex-shrink: 0;
}
.studio-chat-sender { font-size: 12px; color: #888; font-weight: 500; }

/* 摘要 */
.studio-chat-msg-summary {
  align-self: stretch;
  background: #fefce8;
  border: 1px solid #fde68a;
  border-left: 3px solid #f59e0b;
  border-radius: 8px;
  padding: 10px 14px;
  margin-top: 4px;
}
.studio-chat-summary-label {
  font-size: 12px;
  font-weight: 600;
  color: #92400e;
  margin-bottom: 6px;
}

/* 错误 */
.studio-chat-msg-error {
  align-self: center;
  max-width: 90%;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: #dc2626;
}

/* 状态提示 */
.studio-chat-msg-status {
  align-self: center;
  font-size: 12px;
  color: #999;
  padding: 4px 0;
}

/* 轮次指示器 */
.studio-chat-round-indicator {
  align-self: center;
  font-size: 12px;
  color: #4D6BFE;
  padding: 6px 14px;
  background: #eff4ff;
  border-radius: 12px;
  animation: studio-chat-pulse 1.5s ease-in-out infinite;
}
@keyframes studio-chat-pulse { 50% { opacity: 0.5; } }

/* 消息正文（markdown） */
.studio-chat-msg-body { font-size: 14px; line-height: 1.65; color: #1a1a2e; }
.studio-chat-msg-body p { margin: 0 0 8px; }
.studio-chat-msg-body p:last-child { margin-bottom: 0; }
.studio-chat-msg-body h1, .studio-chat-msg-body h2, .studio-chat-msg-body h3 {
  margin: 12px 0 6px; font-weight: 600; line-height: 1.4;
}
.studio-chat-msg-body h1 { font-size: 1.3em; }
.studio-chat-msg-body h2 { font-size: 1.2em; }
.studio-chat-msg-body h3 { font-size: 1.1em; }
.studio-chat-msg-body ul, .studio-chat-msg-body ol { margin: 6px 0 8px; padding-left: 22px; }
.studio-chat-msg-body li { margin: 2px 0; }
.studio-chat-msg-body pre {
  background: #f0f0f5; border-radius: 8px; padding: 10px 13px;
  overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 8px 0; position: relative;
}
.studio-chat-msg-body code {
  background: #f0f0f5; padding: 1px 5px; border-radius: 4px;
  font-size: 0.9em; font-family: 'SF Mono', 'Consolas', monospace;
}
.studio-chat-msg-body pre code { background: none; padding: 0; }
.studio-chat-msg-body blockquote { border-left: 3px solid #4D6BFE; margin: 8px 0; padding: 4px 12px; color: #555; }
.studio-chat-msg-body a { color: #4D6BFE; text-decoration: none; }
.studio-chat-msg-body a:hover { text-decoration: underline; }
.studio-chat-msg-body table { border-collapse: collapse; margin: 8px 0; font-size: 13px; display: block; overflow-x: auto; }
.studio-chat-msg-body th, .studio-chat-msg-body td { border: 1px solid #e0e0e8; padding: 6px 10px; text-align: left; }
.studio-chat-msg-body th { background: #f0f0f5; font-weight: 600; }

/* 代码块标签 + 复制 */
.studio-chat-code-lang {
  position: absolute; top: 4px; right: 4px;
  font-size: 11px; color: #999; background: rgba(255,255,255,0.6);
  padding: 1px 6px; border-radius: 4px; pointer-events: none;
}
.studio-chat-code-copy {
  position: absolute; top: 4px; right: 4px;
  display: none; padding: 1px 6px; font-size: 11px;
  color: #888; background: #fff; border: 1px solid #e0e0e8; border-radius: 4px; cursor: pointer;
}
.studio-chat-msg-body pre:hover .studio-chat-code-copy { display: inline-block; }
.studio-chat-code-copy:hover { color: #4D6BFE; border-color: #4D6BFE; }

/* 输入区 */
.studio-chat-composer {
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid #e8e8ee;
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.studio-chat-input {
  flex: 1;
  border: 1px solid #d8d8e0;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  max-height: 120px;
  outline: none;
  transition: border-color 0.15s ease;
  line-height: 1.5;
}
.studio-chat-input:focus { border-color: #4D6BFE; }
.studio-chat-input:disabled { background: #f5f5f8; color: #aaa; }
.studio-chat-send {
  flex-shrink: 0;
  padding: 8px 18px;
  border: none;
  border-radius: 10px;
  background: #4D6BFE;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.studio-chat-send:hover:not(:disabled) { background: #3a55d8; }
.studio-chat-send:disabled { background: #c0c0cc; cursor: not-allowed; }
`;
