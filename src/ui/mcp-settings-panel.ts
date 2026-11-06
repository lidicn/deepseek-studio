/**
 * 卡 C（MCP 独立原生窗口）页面壳 JS：挂载**现有** `agent-mcp-editor` 全量编辑面。
 *
 * 定位：`/mcp-settings` 窗是 MCP 明文的**唯一**可见可改处（独立 origin + 独立 webview，
 * DeepSeek 聊天页里的模型够不着）。本页与 `/agent` 复用同一个编辑器组件（不重写一套）。
 *
 * 安全边界（本页「零秘密」壳）：
 *   - 数据面 = `fetch` + Bearer，**不经工具通道**（不 import `studio-ui-core` / `callHostTool`）。
 *   - token 由 Rust init script 注入本窗 `window.__STUDIO_TOKEN__`；origin 取
 *     `window.__STUDIO_API_ORIGIN__`（缺省回落 `location.origin`）。
 *   - 壳 HTML 不内嵌 token、不留 `__STUDIO_TOKEN__` 占位符（服务端响应体与磁盘逐字节相同）。
 *   - dev 形态（Rust 未注入，`__STUDIO_TOKEN__` 为空）：编辑器 `refresh()` 打
 *     `Bearer <空>` → 宿主 401 → 编辑器可见报错「读取失败（HTTP 401）」，**不静默、不崩**。
 */

import { mountMcpEditor } from './agent-mcp-editor';

declare global {
  interface Window {
    /** Rust init script 注入的全权宿主 token（本页数据面 Bearer 用）。 */
    __STUDIO_TOKEN__?: string;
    /** Rust init script 注入的服务端 origin；缺省回落 `location.origin`。 */
    __STUDIO_API_ORIGIN__?: string;
  }
}

const root = document.getElementById('mcp-root');
if (root) {
  const token = window.__STUDIO_TOKEN__ ?? '';
  const origin = window.__STUDIO_API_ORIGIN__ ?? location.origin;
  const editor = mountMcpEditor({ root, token, origin });
  void editor.refresh();
} else {
  // 壳与 JS 版本错配（HTML 无 #mcp-root）：可见降级，不崩、不静默。
  console.warn('[StudioUI] #mcp-root missing, MCP 设置窗无法挂载编辑器');
}

export {};
