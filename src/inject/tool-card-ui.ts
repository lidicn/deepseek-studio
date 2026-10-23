/**
 * 工具调用卡片 UI 渲染器（v1.0，对齐 deepseek++ 视觉风格）
 *
 * 只允许写入 Studio 自有的 assistant message。函数必须由调用方传入目标根节点，
 * 严禁再查询或改写 DeepSeek React 管理的消息 DOM。
 *
 * 结构：
 *   .ds-studio-tools-container  — "已调用工具（N次）"可展开容器
 *     .ds-studio-tool-card       — 单个工具调用卡片
 *       header（状态徽章 + 工具名 + 耗时）
 *       body（参数 + 结果，结果>2KB自动折叠）
 */

import { formatToolResultText } from '../shared/tool-result-format';

/** HTML 转义，防止工具名/参数/结果中的恶意标签注入 DOM（XSS）。 */
function escapeHtml(value: unknown): string {
  const str = typeof value === 'string' ? value : String(value ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 图片 URL 白名单：仅允许 data:image/* 和 https://，拒绝 javascript: 等危险协议。 */
function isSafeImageUrl(url: string): boolean {
  if (url.startsWith('data:image/')) return true;
  if (url.startsWith('https://')) return true;
  return false;
}

export interface ToolCardData {
  toolName: string;
  params: Record<string, unknown>;
  result?: {
    ok: boolean;
    data?: unknown;
    error?: string;
    // v1.2 新格式字段（可选，语义见 src/shared/tool-result-format.ts）
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;
    details?: Record<string, unknown>;
    isError?: boolean;
    terminate?: boolean;
  };
  durationMs?: number;
}

const CARD_STYLE = `
  .ds-studio-tools-container {
    margin: 12px 0;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
    font-size: 13px;
    background: #fff;
  }
  .ds-studio-tools-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
    cursor: pointer;
    user-select: none;
    font-weight: 500;
    color: #374151;
  }
  .ds-studio-tools-header:hover { background: #f3f4f6; }
  .ds-studio-tools-arrow {
    display: inline-block;
    width: 16px;
    height: 16px;
    text-align: center;
    line-height: 16px;
    transition: transform 0.2s;
    color: #6b7280;
    font-size: 10px;
  }
  .ds-studio-tools-container.collapsed .ds-studio-tools-arrow { transform: rotate(-90deg); }
  .ds-studio-tools-container.collapsed .ds-studio-tools-body { display: none; }
  .ds-studio-tools-count {
    background: #e5e7eb;
    color: #4b5563;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
  }
  .ds-studio-tools-body { padding: 8px; }

  .ds-studio-tool-card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    margin: 6px 0;
    overflow: hidden;
    background: #fff;
  }
  .ds-studio-tool-card:first-child { margin-top: 0; }
  .ds-studio-tool-card:last-child { margin-bottom: 0; }
  .ds-studio-tool-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #fafafa;
    border-bottom: 1px solid #f0f0f0;
    font-weight: 500;
    color: #374151;
  }
  .ds-studio-tool-card-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
  }
  .ds-studio-tool-card-badge.ok { background: #dcfce7; color: #166534; }
  .ds-studio-tool-card-badge.err { background: #fee2e2; color: #991b1b; }
  .ds-studio-tool-card-badge.running { background: #dbeafe; color: #1e40af; }
  .ds-studio-tool-card-badge.terminated { background: #fef3c7; color: #92400e; }
  .ds-studio-tool-card-badge .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: currentColor;
  }
  .ds-studio-tool-card-badge.running .dot { animation: ds-pulse 1s infinite; }
  @keyframes ds-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .ds-studio-tool-card-name { font-family: 'Consolas', 'Monaco', monospace; font-size: 12px; }
  .ds-studio-tool-card-duration { margin-left: auto; color: #9ca3af; font-size: 11px; }
  .ds-studio-tool-card-body { padding: 10px 12px; }
  .ds-studio-tool-card pre {
    margin: 0;
    padding: 8px 10px;
    background: #f9fafb;
    border-radius: 6px;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    color: #1f2937;
    line-height: 1.5;
    max-height: 400px;
    overflow-y: auto;
  }
  .ds-studio-tool-card-label {
    font-size: 11px;
    color: #6b7280;
    margin-bottom: 4px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .ds-studio-tool-card-section { margin-bottom: 8px; }
  .ds-studio-tool-card-section:last-child { margin-bottom: 0; }
  .ds-studio-tool-card-result-collapsed {
    position: relative;
  }
  .ds-studio-tool-card-result-collapsed pre {
    max-height: 120px;
    overflow: hidden;
  }
  .ds-studio-tool-card-result-collapsed::after {
    content: '';
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 40px;
    background: linear-gradient(transparent, #fff);
    pointer-events: none;
  }
  .ds-studio-tool-card-expand-btn {
    display: block;
    width: 100%;
    padding: 6px;
    margin-top: 6px;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    font-size: 11px;
    color: #6b7280;
    cursor: pointer;
    text-align: center;
  }
  .ds-studio-tool-card-expand-btn:hover { background: #e5e7eb; color: #374151; }
  .ds-studio-tool-card-images {
    margin-bottom: 8px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid #e5e7eb;
  }
  .ds-studio-tool-card-image {
    display: block;
    max-width: 100%;
    height: auto;
    cursor: zoom-in;
  }
`;

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = CARD_STYLE;
  const head = document.head ?? document.documentElement;
  head.appendChild(style);
  styleInjected = true;
}

function formatJson(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

/**
 * 格式化工具结果显示文本。
 * 逻辑已抽到 src/shared/tool-result-format.ts 的 formatToolResultText：
 *   content 优先 → 回退旧格式（error / stdout / string / JSON）→ isError 加前缀
 */
function formatResult(result: { ok: boolean; data?: unknown; error?: string }): string {
  return formatToolResultText(result);
}

/**
 * 获取或创建"已调用工具"容器。
 * 所有工具卡片都放在这个可展开容器里。
 */
function getOrCreateToolsContainer(container: HTMLElement): HTMLElement {
  // 查找已有的容器
  let toolsContainer = container.querySelector('.ds-studio-tools-container') as HTMLElement | null;
  if (toolsContainer) return toolsContainer;

  // 创建新容器
  toolsContainer = document.createElement('div');
  toolsContainer.className = 'ds-studio-tools-container';
  toolsContainer.innerHTML = `
    <div class="ds-studio-tools-header">
      <span class="ds-studio-tools-arrow">▼</span>
      <span>已调用工具</span>
      <span class="ds-studio-tools-count">0</span>
    </div>
    <div class="ds-studio-tools-body"></div>
  `;
  // 点击头部展开/折叠
  const header = toolsContainer.querySelector('.ds-studio-tools-header') as HTMLElement;
  header.addEventListener('click', () => {
    toolsContainer!.classList.toggle('collapsed');
  });
  // v0.19：插入到消息元素最前面（工具在上、结论在下）。
  // 之前 appendChild 把工具放到末尾（结论下方），顺序反了。
  container.insertBefore(toolsContainer, container.firstChild);
  return toolsContainer;
}

function updateToolsCount(container: HTMLElement): void {
  const toolsContainer = container.querySelector('.ds-studio-tools-container');
  if (!toolsContainer) return;
  const cards = toolsContainer.querySelectorAll('.ds-studio-tool-card');
  const countEl = toolsContainer.querySelector('.ds-studio-tools-count');
  if (countEl) countEl.textContent = String(cards.length);
}

function buildCardHtml(data: ToolCardData, _callId: string): string {
  const failed = data.result ? (data.result.isError === true || data.result.ok === false) : false;
  const status = data.result ? (failed ? 'err' : 'ok') : 'running';
  const statusText = data.result ? (failed ? '执行失败' : '已执行') : '执行中';
  const terminated = !!data.result && data.result.terminate === true;
  const resultText = data.result ? formatResult(data.result) : '';
  const isLongResult = resultText.length > 2048;

  // 从 content 数组提取图片（MCP 截图等多模态结果），白名单校验
  const imageUrls: string[] = [];
  if (data.result?.content) {
    for (const c of data.result.content) {
      if (c.type === 'image_url' && c.image_url?.url && isSafeImageUrl(c.image_url.url)) {
        imageUrls.push(c.image_url.url);
      }
    }
  }
  const imagesHtml = imageUrls.length > 0
    ? imageUrls.map((url) => `<img class="ds-studio-tool-card-image" src="${escapeHtml(url)}" alt="tool result image" />`).join('')
    : '';

  return `
    <div class="ds-studio-tool-card-header">
      <span class="ds-studio-tool-card-badge ${status}"><span class="dot"></span>${statusText}</span>
      ${terminated ? '<span class="ds-studio-tool-card-badge terminated"><span class="dot"></span>已终止续跑</span>' : ''}
      <span class="ds-studio-tool-card-name">${escapeHtml(data.toolName)}</span>
      ${data.durationMs ? `<span class="ds-studio-tool-card-duration">${data.durationMs}ms</span>` : ''}
    </div>
    <div class="ds-studio-tool-card-body">
      <div class="ds-studio-tool-card-section">
        <div class="ds-studio-tool-card-label">参数</div>
        <pre>${escapeHtml(formatJson(data.params))}</pre>
      </div>
      ${data.result ? `
      <div class="ds-studio-tool-card-section ${isLongResult && !imagesHtml ? 'ds-studio-tool-card-result-collapsed' : ''}">
        <div class="ds-studio-tool-card-label">结果</div>
        ${imagesHtml ? `<div class="ds-studio-tool-card-images">${imagesHtml}</div>` : ''}
        <pre>${escapeHtml(resultText)}</pre>
        ${isLongResult && !imagesHtml ? '<button class="ds-studio-tool-card-expand-btn">展开全部</button>' : ''}
      </div>
      ` : ''}
    </div>
  `;
}

/**
 * 创建一个工具调用卡片（执行中状态），追加到"已调用工具"容器里。
 * 返回 callId，用于后续 updateToolCardByCallId 更新。
 */
export function createToolCard(data: ToolCardData, callId: string, container: HTMLElement): string {
  ensureStyle();
  const toolsContainer = getOrCreateToolsContainer(container);

  const body = toolsContainer.querySelector('.ds-studio-tools-body') as HTMLElement;
  const card = document.createElement('div');
  card.className = 'ds-studio-tool-card';
  card.dataset.callId = callId;
  card.dataset.toolName = data.toolName;
  // security-ok: buildCardHtml 对所有外部字段做 escapeHtml，图片 URL 走协议白名单。
  card.innerHTML = buildCardHtml(data, callId);
  body.appendChild(card);
  updateToolsCount(container);
  return callId;
}

/**
 * 通过 callId 查找卡片并更新执行结果。
 * 如果卡片不存在（页面重渲染被删），则重新创建一个带结果的卡片。
 */
export function updateToolCardByCallId(
  callId: string,
  data: ToolCardData,
  result: NonNullable<ToolCardData['result']>,
  container: HTMLElement,
  durationMs?: number,
): void {
  let card = container.querySelector(`.ds-studio-tool-card[data-call-id="${callId}"]`) as HTMLElement | null;

  if (!card) {
    const toolsContainer = getOrCreateToolsContainer(container);
    const body = toolsContainer.querySelector('.ds-studio-tools-body') as HTMLElement;
    card = document.createElement('div');
    card.className = 'ds-studio-tool-card';
    card.dataset.callId = callId;
    card.dataset.toolName = data.toolName;
    body.appendChild(card);
    updateToolsCount(container);
  }

  const fullData: ToolCardData = { ...data, result, durationMs };
  // security-ok: buildCardHtml 对所有外部字段做 escapeHtml，图片 URL 走协议白名单。
  card.innerHTML = buildCardHtml(fullData, callId);

  // 绑定展开按钮
  const expandBtn = card.querySelector('.ds-studio-tool-card-expand-btn') as HTMLButtonElement | null;
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const section = expandBtn.closest('.ds-studio-tool-card-section');
      if (section) {
        section.classList.remove('ds-studio-tool-card-result-collapsed');
        expandBtn.remove();
      }
    });
  }
}
