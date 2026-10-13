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
  bottom: 280px;          /* 底部留 280px 给 DeepSeek 输入框区域，实测后微调 */
  z-index: 2147483000;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 15px;
  color: #1a1a2e;
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

/* 流式期文本容器（终端式追加） */
.ds-sc-streaming {
  white-space: pre-wrap;
}

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
