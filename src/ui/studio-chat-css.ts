/**
 * v0.19 自建聊天 UI 样式
 *
 * 半屏 overlay：覆盖 DeepSeek 消息列表区域，底部留空间给 DeepSeek 输入框。
 * 消息气泡样式参考 agent.css，改为亮色主题以匹配 DeepSeek 页面。
 */

export const STUDIO_CHAT_CSS = `
/* ===== overlay 容器 ===== */
/* z-index 分层（v0.20）：
 *   2147483647  consent 弹窗（同意闸门，最高）
 *   2147483644-3646  StudioUI sidebar/面板（工具入口，可点击）
 *   2147483000  本 chat overlay（消息渲染，只盖 DeepSeek #root）
 * chat overlay 低于 sidebar，确保浮动按钮/面板不被白板盖住。 */
.ds-studio-chat-container {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 280px;          /* 默认值，measureComposerTop 会动态覆盖为精确值 */
  z-index: 2147483000;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 15px;
  color: #1a1a2e;
  transition: opacity 0.15s ease;
}

/* ctrl+shift+h 切换隐藏态（参考 cuckoo-code 切换式叠加布局）：
 * 隐藏时完全移出视口，原网页全可见、可交互。 */
.ds-studio-chat-container.ds-studio-chat-hidden {
  display: none !important;
}

/* 揭示门控：overlay 初始不可见，等 composer 测量稳定（落在视口下半区）再淡入。
 * 避免"先矮后涨"的闪烁——初次加载 SPA 未渲染时 textarea 浮在高位，
 * overlay 会先按错误测量渲染成矮面板，渲染完成后再跳高，视觉闪烁。 */
.ds-studio-chat-container.ds-studio-chat-pending {
  opacity: 0 !important;
}

/* ===== 消息列表（滚动容器）===== */
.ds-sc-message-list {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scroll-behavior: smooth;
}

.ds-sc-message-list::-webkit-scrollbar { width: 8px; }
.ds-sc-message-list::-webkit-scrollbar-thumb { background: #d0d0d8; border-radius: 4px; }
.ds-sc-message-list::-webkit-scrollbar-thumb:hover { background: #b0b0bc; }

/* ===== 消息气泡 ===== */
.ds-sc-msg-user {
  align-self: flex-end;
  max-width: 78%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border-radius: 14px 14px 4px 14px;
  padding: 10px 15px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.ds-sc-msg-assistant {
  align-self: flex-start;
  max-width: 88%;
  background: #f6f7f9;
  border: 1px solid #e8e8ee;
  border-radius: 14px 14px 14px 4px;
  padding: 12px 16px;
  line-height: 1.7;
  word-break: break-word;
}

/* 消息定位上下文（复制按钮绝对定位锚点） */
.ds-sc-msg-user, .ds-sc-msg-assistant { position: relative; }

/* v0.27：多参与者头像 + 名称标签 */
.ds-sc-sender-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.ds-sc-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%;
  font-size: 11px; font-weight: 600; color: #fff;
  background: #4D6BFE; flex-shrink: 0;
}
.ds-sc-sender { font-size: 12px; color: #888; font-weight: 500; }

/* v0.27：子 bot 气泡紫色调（与主 bot 蓝色调区分） */
.ds-sc-msg-sub-bot .ds-sc-avatar { background: #8b5cf6; }
.ds-sc-msg-sub-bot { border-left: 3px solid #8b5cf6; }
.ds-sc-msg-main-bot .ds-sc-avatar { background: #4D6BFE; }
.ds-sc-msg-main-bot { border-left: 3px solid #4D6BFE; }

/* 消息复制按钮：hover 显示，右上角浮出 */
.ds-sc-copy-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: #888;
  background: #fff;
  border: 1px solid #e0e0e8;
  border-radius: 6px;
  cursor: pointer;
  z-index: 2;
}
.ds-sc-copy-btn:hover { color: #4D6BFE; border-color: #4D6BFE; }
.ds-sc-msg-user:hover .ds-sc-copy-btn,
.ds-sc-msg-assistant:hover .ds-sc-copy-btn { display: flex; }
.ds-sc-msg-user .ds-sc-copy-btn { background: rgba(255,255,255,0.95); color: rgba(255,255,255,0.85); border-color: rgba(255,255,255,0.3); }
.ds-sc-msg-user .ds-sc-copy-btn:hover { color: #fff; }

/* ===== 思考块（可折叠）===== */
.ds-sc-think {
  border-left: 2px solid #d0d0d8;
  background: #f5f5f8;
  border-radius: 0 6px 6px 0;
  margin-bottom: 8px;
  overflow: hidden;
}
.ds-sc-think-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: #888;
  cursor: pointer;
  user-select: none;
}
.ds-sc-think-head:hover { color: #555; }
.ds-sc-think-caret {
  display: inline-block;
  transition: transform 0.15s ease;
  font-size: 10px;
}
.ds-sc-think.open .ds-sc-think-caret { transform: rotate(90deg); }
.ds-sc-think-body {
  display: none;
  padding: 4px 10px 8px;
  font-size: 13px;
  color: #666;
  white-space: pre-wrap;
  line-height: 1.6;
}
.ds-sc-think.open .ds-sc-think-body { display: block; }

/* 流式期文本容器：marked 生成 HTML，用 markdown 样式 */
.ds-sc-streaming { white-space: normal; }
.ds-sc-streaming p { margin: 0 0 8px; }
.ds-sc-streaming p:last-child { margin-bottom: 0; }

/* 流式光标（参考 cuckoo streaming-cursor） */
.ds-sc-cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-left: 2px;
  background: #4D6BFE;
  vertical-align: text-bottom;
  animation: ds-sc-blink 1s step-end infinite;
}
@keyframes ds-sc-blink { 50% { opacity: 0; } }

/* 回到底部按钮 */
.ds-sc-scroll-btn {
  position: absolute;
  bottom: 48px;
  right: 20px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid #e0e0e8;
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  cursor: pointer;
  z-index: 10;
  font-size: 16px;
  color: #666;
}
.ds-sc-scroll-btn.show { display: flex; }
.ds-sc-scroll-btn:hover { color: #4D6BFE; border-color: #4D6BFE; }

/* 流结束后的 markdown 渲染容器 */
.ds-sc-markdown {
  white-space: normal;
}
.ds-sc-markdown p { margin: 0 0 8px; }
.ds-sc-markdown p:last-child { margin-bottom: 0; }
.ds-sc-markdown h1, .ds-sc-markdown h2, .ds-sc-markdown h3 {
  margin: 12px 0 6px;
  font-weight: 600;
  line-height: 1.4;
}
.ds-sc-markdown h1 { font-size: 1.4em; }
.ds-sc-markdown h2 { font-size: 1.25em; }
.ds-sc-markdown h3 { font-size: 1.1em; }
.ds-sc-markdown ul, .ds-sc-markdown ol { margin: 6px 0 8px; padding-left: 24px; }
.ds-sc-markdown li { margin: 2px 0; }
.ds-sc-markdown pre {
  background: #f0f0f5;
  border-radius: 8px;
  padding: 10px 13px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
  margin: 8px 0;
}
.ds-sc-markdown code {
  background: #f0f0f5;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
}
.ds-sc-markdown pre code {
  background: none;
  padding: 0;
}
.ds-sc-markdown blockquote {
  border-left: 3px solid #4D6BFE;
  margin: 8px 0;
  padding: 4px 12px;
  color: #555;
}
.ds-sc-markdown a {
  color: #4D6BFE;
  text-decoration: none;
}
.ds-sc-markdown a:hover { text-decoration: underline; }

/* 表格（marked GFM） */
.ds-sc-markdown table, .ds-sc-streaming table {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
  display: block;
  overflow-x: auto;
}
.ds-sc-markdown th, .ds-sc-streaming th,
.ds-sc-markdown td, .ds-sc-streaming td {
  border: 1px solid #e0e0e8;
  padding: 6px 10px;
  text-align: left;
}
.ds-sc-markdown th, .ds-sc-streaming th {
  background: #f0f0f5;
  font-weight: 600;
}

/* 任务列表（GFM checkbox） */
.ds-sc-markdown input[type="checkbox"], .ds-sc-streaming input[type="checkbox"] {
  margin-right: 6px;
}

/* 代码块：相对定位给复制按钮 + 语言标签 */
.ds-sc-markdown pre, .ds-sc-streaming pre {
  position: relative;
}
/* 代码块语言标签（右上角，JS 动态插入 .ds-sc-code-lang） */
.ds-sc-code-lang {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 11px;
  color: #999;
  background: rgba(255,255,255,0.6);
  padding: 1px 6px;
  border-radius: 4px;
  pointer-events: none;
}
/* 代码块复制按钮 */
.ds-sc-code-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  display: none;
  padding: 1px 6px;
  font-size: 11px;
  color: #888;
  background: #fff;
  border: 1px solid #e0e0e8;
  border-radius: 4px;
  cursor: pointer;
}
.ds-sc-markdown pre:hover .ds-sc-code-copy,
.ds-sc-streaming pre:hover .ds-sc-code-copy { display: inline-block; }
.ds-sc-code-copy:hover { color: #4D6BFE; border-color: #4D6BFE; }

/* 流式期也复用 markdown 的表格/代码块/列表样式 */
.ds-sc-streaming table { border-collapse: collapse; margin: 8px 0; font-size: 13px; display: block; overflow-x: auto; }
.ds-sc-streaming th, .ds-sc-streaming td { border: 1px solid #e0e0e8; padding: 6px 10px; }
.ds-sc-streaming th { background: #f0f0f5; font-weight: 600; }
.ds-sc-streaming ul, .ds-sc-streaming ol { margin: 6px 0 8px; padding-left: 24px; }
.ds-sc-streaming li { margin: 2px 0; }
.ds-sc-streaming pre { background: #f0f0f5; border-radius: 8px; padding: 10px 13px; overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 8px 0; }
.ds-sc-streaming code { background: #f0f0f5; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; font-family: 'SF Mono', 'Consolas', 'Monaco', monospace; }
.ds-sc-streaming pre code { background: none; padding: 0; }
.ds-sc-streaming blockquote { border-left: 3px solid #4D6BFE; margin: 8px 0; padding: 4px 12px; color: #555; }
.ds-sc-streaming h1, .ds-sc-streaming h2, .ds-sc-streaming h3 { margin: 12px 0 6px; font-weight: 600; line-height: 1.4; }
.ds-sc-streaming h1 { font-size: 1.4em; }
.ds-sc-streaming h2 { font-size: 1.25em; }
.ds-sc-streaming h3 { font-size: 1.1em; }
.ds-sc-streaming a { color: #4D6BFE; text-decoration: none; }
.ds-sc-markdown a:hover { text-decoration: underline; }

/* 思考前缀折叠卡片 */
.ds-sc-thinking-preface {
  font-size: 12px;
  color: #888;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: #f5f5f5;
  border-radius: 6px;
  cursor: pointer;
}

/* ===== 工具卡片容器（复用 tool-card-ui 的 DOM）===== */
.ds-sc-msg-assistant .ds-studio-tools-container {
  margin-bottom: 8px;
}

/* ===== 底部状态栏 ===== */
.ds-sc-status-bar {
  flex-shrink: 0;
  padding: 6px 16px;
  background: #f9f9fc;
  border-top: 1px solid #e8e8ee;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #888;
}
.ds-sc-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;
}
.ds-sc-status-dot.busy {
  background: #4D6BFE;
  animation: ds-sc-pulse 1.5s ease-in-out infinite;
}
.ds-sc-status-dot.done { background: #22c55e; }
.ds-sc-status-dot.error { background: #ef4444; }
@keyframes ds-sc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* v0.20 removed: hidden virtual-list rule */
/* 更激进：隐藏 #root 下所有非 composer 的直接子元素（备用，实测后决定是否启用）
#root > div > div:not(:last-child) {
  visibility: hidden !important;
  pointer-events: none !important;
}
*/
`;
