/**
 * 工具调用过程流渲染器（redesign · v2.0）
 *
 * 设计意图：把"一坨卡片"反转成叙事流 ——
 *   · 结论归对话正文（本模块不产出任何结论、不产出任何卡片盒子）；
 *   · 工具过程收成一行摘要 `.ds-flow-summary`（默认收起，整段过程只占一行高度）；
 *   · 每次调用是一条行级条目 `.ds-flow-item`（默认一行截断摘要，展开看完整参数与输出）；
 *   · 执行中的条目有轻量活动指示（脉动点 + 实时耗时 + 微妙底色），完成后回到安静；
 *   · 失败/被拒是整行变色 + 展开区错误文本，不是弹出的错误卡片。
 *
 * 接口与 src/inject/tool-card-ui.ts 逐一对齐（同签名、同语义、同幂等要求）：
 *   createRedesignedToolCard(data, callId, container): string
 *   updateRedesignedToolCardByCallId(callId, data, result, container, durationMs?): void
 * 并额外导出 createToolCard / updateToolCardByCallId 别名，调用方换 import 路径即可切换。
 *
 * 约束落实：
 *   - 动态文本一律经 src/ui/sanitizer.ts 的 escapeHtml 转义后才进入 innerHTML；
 *   - 图片 URL 走 data:image/ + https:// 协议白名单，其余（javascript:、http:、data:text/html 等）直接丢弃；
 *   - DOM 隔离：只写调用方传入的 container（外加一次性 <style> 注入 document.head，与既有渲染器一致），
 *     只使用 ds-flow* 自有类名，不查询、不改写 DeepSeek React 管理的消息 DOM；
 *   - callId 全程走 dataset 比对，不拼进选择器，天然免疫选择器注入；
 *   - 零外部依赖；prefers-reduced-motion 下禁用全部动画与过渡。
 */

import { escapeHtml as sanitizeEscapeHtml } from '../ui/sanitizer';
import { formatToolResultText } from '../shared/tool-result-format';

/* ─────────────────────────────── 契约类型（逐字段对齐 v1） ─────────────────────────────── */

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

/** 六态语义：running / succeeded / failed / denied / cancelled / terminated。 */
export type ToolCallStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'terminated';

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  running: '执行中',
  succeeded: '已执行',
  failed: '失败',
  denied: '被拒',
  cancelled: '已取消',
  terminated: '已终止',
};

const LONG_RESULT_THRESHOLD = 2048;

const BRIEF_KEYS = [
  'cmd', 'command', 'script', 'shell', 'args', 'argv',
  'query', 'pattern', 'path', 'file', 'filename', 'filePath', 'file_path',
  'url', 'uri', 'name', 'title', 'prompt', 'input', 'text', 'content', 'message', 'description', 'retries',
];

const DENIED_PATTERN =
  /(denied|forbidden|unauthori[sz]ed|permission|not\s+allowed|rejected|refus|拒绝|权限|授权|不允许|无权)/i;
const CANCEL_PATTERN = /(cancell?ed|abort(ed)?|interrupt(ed)?|取消|中止|中断)/i;

/* ─────────────────────────────── 基础工具 ─────────────────────────────── */

/** HTML 转义：统一委托 src/ui/sanitizer.ts#escapeHtml，此处只做入参归一。 */
function escapeHtml(value: unknown): string {
  return String(sanitizeEscapeHtml(String(value ?? '')));
}

/** 图片 URL 白名单：仅允许 data:image/* 和 https://，拒绝 javascript:/http:/data:text/html 等。 */
function isSafeImageUrl(url: string): boolean {
  if (url.startsWith('data:image/')) return true;
  if (url.startsWith('https://')) return true;
  return false;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return safeString(value);
  }
}

function formatJsonCompact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return safeString(value);
  }
}

function toFiniteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** 耗时格式化：320ms / 3.2s / 1m 12s；非法输入返回空串（不渲染该字段）。 */
export function formatDurationMs(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function collapseSpace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/** 行摘要：优先取命令类字段，其次数组命令，最后紧凑 JSON 单行。 */
export function buildParamBrief(params: unknown, maxLength = 96): string {
  const source: Record<string, unknown> =
    params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  for (let i = 0; i < BRIEF_KEYS.length; i += 1) {
    const key = BRIEF_KEYS[i];
    const value = source[key];
    if (typeof value === 'number' || typeof value === 'boolean') {
      return truncate(`${key}=${String(value)}`, maxLength);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return truncate(collapseSpace(value), maxLength);
    }
    if (Array.isArray(value) && value.length > 0 && value.every((v: unknown) => typeof v === 'string')) {
      return truncate(collapseSpace((value as string[]).join(' ')), maxLength);
    }
  }
  return truncate(collapseSpace(formatJsonCompact(source)), maxLength);
}

/* ─────────────────────────────── 状态派生 ─────────────────────────────── */

function normalizeStatus(raw: unknown): ToolCallStatus | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (key) {
    case 'running':
    case 'pending':
    case 'in_progress':
    case 'inprogress':
    case 'started':
      return 'running';
    case 'success':
    case 'succeeded':
    case 'ok':
    case 'completed':
    case 'complete':
    case 'done':
      return 'succeeded';
    case 'failed':
    case 'failure':
    case 'error':
    case 'errored':
      return 'failed';
    case 'denied':
    case 'rejected':
    case 'forbidden':
    case 'unauthorized':
    case 'refused':
    case 'permission_denied':
      return 'denied';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
    case 'interrupted':
      return 'cancelled';
    case 'terminated':
    case 'terminate':
      return 'terminated';
    default:
      return null;
  }
}

/**
 * 六态派生（优先级从高到低）：
 *   1) details.status/state/outcome 的结构化提示；
 *   2) result.terminate === true → terminated（沿用 v1.2 "已终止续跑" 语义）；
 *   3) result.isError === true || result.ok === false → 失败家族；
 *   4) 失败家族内按 error/details 文本启发式细分 denied / cancelled，否则 failed。
 * 无 result → running。
 */
export function deriveToolStatus(result?: ToolCardData['result']): ToolCallStatus {
  if (!result) return 'running';

  const details = result.details;
  if (details && typeof details === 'object') {
    const keys = ['status', 'state', 'outcome'];
    for (let i = 0; i < keys.length; i += 1) {
      const hint = normalizeStatus((details as Record<string, unknown>)[keys[i]]);
      if (hint) return hint;
    }
  }

  if (result.terminate === true) return 'terminated';

  const failed = result.isError === true || result.ok === false;
  if (!failed) return 'succeeded';

  const blob = `${result.error ?? ''} ${formatJsonCompact(result.details ?? {})}`;
  if (DENIED_PATTERN.test(blob)) return 'denied';
  if (CANCEL_PATTERN.test(blob)) return 'cancelled';
  return 'failed';
}

/* ─────────────────────────────── 样式（一次性注入） ─────────────────────────────── */

const FLOW_STYLE = `
  .ds-flow {
    --dsf-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    --dsf-ink: #1b1f24;
    --dsf-muted: #697079;
    --dsf-faint: #9aa2ab;
    --dsf-rule: #e5e8ec;
    --dsf-hover: rgba(20, 26, 33, 0.045);
    --dsf-run: #2f6fdb;
    --dsf-run-tint: rgba(47, 111, 219, 0.055);
    --dsf-ok: #a6adb5;
    --dsf-fail: #c2352c;
    --dsf-fail-tint: rgba(194, 53, 44, 0.055);
    --dsf-term: #a16207;
    --dsf-cancel: #7c848d;
    margin: 10px 0 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 13px;
    line-height: 1.65;
    color: var(--dsf-ink);
  }

  .ds-flow [hidden] { display: none !important; }

  /* 一行摘要：收起时整段过程只有这一行 */
  .ds-flow-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 26px;
    padding: 2px 4px;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.01em;
    color: var(--dsf-muted);
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .ds-flow-summary:hover { color: var(--dsf-ink); }
  .ds-flow-summary:focus-visible { outline: 1px solid var(--dsf-run); outline-offset: 2px; }
  .ds-flow-summary-text {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ds-flow-summary-time {
    margin-left: auto;
    font-family: var(--dsf-mono);
    font-size: 11px;
    color: var(--dsf-faint);
    font-variant-numeric: tabular-nums;
  }

  /* 折角箭头：CSS 绘制，不依赖字形 */
  .ds-flow-chev {
    flex: none;
    width: 6px;
    height: 6px;
    margin-top: -1px;
    border-right: 1.4px solid currentColor;
    border-bottom: 1.4px solid currentColor;
    transform: rotate(-45deg);
    transition: transform 0.15s ease;
    opacity: 0.7;
  }
  .ds-flow[data-open='true'] > .ds-flow-summary .ds-flow-chev { transform: rotate(45deg); }

  /* 调用列表：左侧发丝线做时间线，层级靠缩进与留白 */
  .ds-flow-list {
    margin: 2px 0 0;
    padding: 2px 0 2px 12px;
    border-left: 1px solid var(--dsf-rule);
  }
  .ds-flow-item { position: relative; }
  .ds-flow-item + .ds-flow-item { margin-top: 1px; }

  /* 行级条目 */
  .ds-flow-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 4px;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: 12.5px;
    color: inherit;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .ds-flow-row:hover { background: var(--dsf-hover); }
  .ds-flow-row:focus-visible { outline: 1px solid var(--dsf-run); outline-offset: -1px; }

  .ds-flow-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dsf-ok);
  }
  .ds-flow-item[data-status='running'] .ds-flow-dot {
    background: var(--dsf-run);
    animation: ds-flow-pulse 1.1s ease-in-out infinite;
  }
  .ds-flow-item[data-status='succeeded'] .ds-flow-dot { background: var(--dsf-ok); }
  .ds-flow-item[data-status='failed'] .ds-flow-dot { background: var(--dsf-fail); }
  .ds-flow-item[data-status='denied'] .ds-flow-dot {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--dsf-fail);
  }
  .ds-flow-item[data-status='cancelled'] .ds-flow-dot {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--dsf-cancel);
  }
  .ds-flow-item[data-status='terminated'] .ds-flow-dot { background: var(--dsf-term); }

  .ds-flow-tool {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--dsf-mono);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: inherit;
  }
  .ds-flow-brief {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--dsf-mono);
    font-size: 11.5px;
    color: inherit;
    opacity: 0.58;
  }
  .ds-flow-status {
    flex: none;
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--dsf-muted);
  }
  .ds-flow-status--quiet {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .ds-flow-item[data-status='running'] .ds-flow-status { color: var(--dsf-run); }
  .ds-flow-item[data-status='failed'] .ds-flow-status,
  .ds-flow-item[data-status='denied'] .ds-flow-status { color: var(--dsf-fail); }
  .ds-flow-item[data-status='cancelled'] .ds-flow-status { color: var(--dsf-cancel); }
  .ds-flow-item[data-status='terminated'] .ds-flow-status { color: var(--dsf-term); }

  .ds-flow-time {
    flex: none;
    font-family: var(--dsf-mono);
    font-size: 11px;
    color: inherit;
    opacity: 0.45;
    font-variant-numeric: tabular-nums;
  }

  .ds-flow-item[data-status='running'] .ds-flow-row { background: var(--dsf-run-tint); }
  .ds-flow-item[data-status='failed'] .ds-flow-row,
  .ds-flow-item[data-status='denied'] .ds-flow-row {
    background: var(--dsf-fail-tint);
    color: var(--dsf-fail);
  }

  /* 展开区：无卡片包裹，标签 + 缩进 + 等宽文本 */
  .ds-flow-body {
    padding: 2px 4px 10px 14px;
    animation: ds-flow-in 0.14s ease-out;
  }
  .ds-flow-line {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }
  .ds-flow-line + .ds-flow-line { margin-top: 9px; }
  .ds-flow-tag {
    padding-top: 2px;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    color: var(--dsf-faint);
    user-select: none;
  }
  .ds-flow-out { min-width: 0; }
  .ds-flow-pre {
    margin: 0;
    padding: 0;
    max-height: 320px;
    overflow: auto;
    font-family: var(--dsf-mono);
    font-size: 11.5px;
    line-height: 1.65;
    color: var(--dsf-ink);
    white-space: pre-wrap;
    word-break: break-word;
    tab-size: 2;
  }
  .ds-flow-pre--muted { color: var(--dsf-muted); }
  .ds-flow-pre--error { color: var(--dsf-fail); }

  .ds-flow-clamp {
    max-height: 132px;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 62%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 62%, transparent 100%);
  }
  .ds-flow-clamp .ds-flow-pre { max-height: none; overflow: visible; }
  .ds-flow-more {
    display: inline-block;
    margin: 6px 0 0;
    padding: 0;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: 11px;
    color: var(--dsf-run);
    cursor: pointer;
  }
  .ds-flow-more:hover { text-decoration: underline; }

  .ds-flow-shots { display: flex; flex-direction: column; gap: 6px; }
  .ds-flow-shot {
    display: block;
    max-width: 100%;
    max-height: 360px;
    width: auto;
    height: auto;
  }

  @keyframes ds-flow-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.32; }
  }
  @keyframes ds-flow-in {
    from { opacity: 0; transform: translateY(-1px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-color-scheme: dark) {
    .ds-flow {
      --dsf-ink: #e8ebee;
      --dsf-muted: #98a0a9;
      --dsf-faint: #6d757e;
      --dsf-rule: #2b3138;
      --dsf-hover: rgba(255, 255, 255, 0.05);
      --dsf-run: #7ba4ff;
      --dsf-run-tint: rgba(123, 164, 255, 0.09);
      --dsf-ok: #5c646d;
      --dsf-fail: #f08076;
      --dsf-fail-tint: rgba(240, 128, 118, 0.1);
      --dsf-term: #d2a24c;
      --dsf-cancel: #828b95;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ds-flow,
    .ds-flow * {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
  }
`;

const STYLE_MARKER = 'data-ds-flow-style';

function ensureStyle(): void {
  const host = document.head ?? document.documentElement;
  if (host.querySelector(`style[${STYLE_MARKER}]`)) return;
  const style = document.createElement('style');
  style.setAttribute(STYLE_MARKER, 'v2');
  style.textContent = FLOW_STYLE;
  host.appendChild(style);
}

/* ─────────────────────────────── DOM 装配 ─────────────────────────────── */

let uidSeq = 0;

function nextUid(prefix: string): string {
  uidSeq += 1;
  return `${prefix}${uidSeq}`;
}

/** 实时秒表：running 条目每秒刷新耗时；条目脱离 DOM 后自动清理。 */
const tickers = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

function stopTicker(row: HTMLElement): void {
  const timer = tickers.get(row);
  if (timer !== undefined) {
    clearInterval(timer);
    tickers.delete(row);
  }
}

function startTicker(row: HTMLElement, startedAt: number): void {
  stopTicker(row);
  const timer = setInterval(() => {
    if (!row.isConnected) {
      stopTicker(row);
      return;
    }
    const timeEl = row.querySelector('.ds-flow-time');
    if (timeEl) timeEl.textContent = formatDurationMs(Date.now() - startedAt);
  }, 1000);
  tickers.set(row, timer);
}

function formatResult(result: NonNullable<ToolCardData['result']>): string {
  // 结果文本语义统一由 src/shared/tool-result-format.ts 提供（content → error/stdout/string/JSON → isError 前缀）。
  return String(formatToolResultText(result));
}

function collectImages(result: NonNullable<ToolCardData['result']>): string[] {
  const urls: string[] = [];
  const content = result.content;
  if (!Array.isArray(content)) return urls;
  for (let i = 0; i < content.length; i += 1) {
    const part = content[i];
    if (
      part &&
      part.type === 'image_url' &&
      part.image_url &&
      typeof part.image_url.url === 'string' &&
      isSafeImageUrl(part.image_url.url)
    ) {
      urls.push(part.image_url.url);
    }
  }
  return urls;
}

function buildItemHtml(
  data: ToolCardData,
  status: ToolCallStatus,
  durationMs: number | undefined,
  startedAt: number,
  expanded: boolean,
): string {
  const bodyId = nextUid('ds-flow-body-');
  const brief = buildParamBrief(data.params);
  const statusText = STATUS_LABEL[status];
  const quiet = status === 'succeeded';
  const knownDuration = durationMs ?? data.durationMs;
  const timeText =
    status === 'running'
      ? formatDurationMs(Date.now() - startedAt)
      : formatDurationMs(knownDuration);

  const result = data.result;
  const resultText = result ? formatResult(result) : '';
  const images = result ? collectImages(result) : [];
  const isLong = resultText.length > LONG_RESULT_THRESHOLD && images.length === 0;
  const errorish = status === 'failed' || status === 'denied';
  const detailsText =
    result && result.details && Object.keys(result.details).length > 0
      ? formatJson(result.details)
      : '';

  const lines: string[] = [];
  lines.push(`
      <div class="ds-flow-line">
        <span class="ds-flow-tag">参数</span>
        <pre class="ds-flow-pre ds-flow-pre--muted">${escapeHtml(formatJson(data.params))}</pre>
      </div>`);

  if (result) {
    const imagesHtml = images
      .map((url) => `<img class="ds-flow-shot" src="${escapeHtml(url)}" alt="工具结果图片" />`)
      .join('');
    const preClass = errorish ? 'ds-flow-pre ds-flow-pre--error' : 'ds-flow-pre';
    const block = `${imagesHtml ? `<div class="ds-flow-shots">${imagesHtml}</div>` : ''}<pre class="${preClass}">${escapeHtml(resultText)}</pre>`;
    const outHtml = isLong
      ? `<div class="ds-flow-clamp">${block}</div><button type="button" class="ds-flow-more">展开全部</button>`
      : block;
    lines.push(`
      <div class="ds-flow-line">
        <span class="ds-flow-tag">输出</span>
        <div class="ds-flow-out">${outHtml}</div>
      </div>`);
  }

  if (detailsText) {
    lines.push(`
      <div class="ds-flow-line">
        <span class="ds-flow-tag">详情</span>
        <pre class="ds-flow-pre ds-flow-pre--muted">${escapeHtml(detailsText)}</pre>
      </div>`);
  }

  return `
    <button type="button" class="ds-flow-row" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${bodyId}">
      <span class="ds-flow-dot" aria-hidden="true"></span>
      <span class="ds-flow-tool">${escapeHtml(data.toolName)}</span>
      <span class="ds-flow-brief">${escapeHtml(brief)}</span>
      <span class="ds-flow-status${quiet ? ' ds-flow-status--quiet' : ''}">${escapeHtml(statusText)}</span>
      <span class="ds-flow-time">${escapeHtml(timeText)}</span>
      <span class="ds-flow-chev" aria-hidden="true"></span>
    </button>
    <div class="ds-flow-body" id="${bodyId}"${expanded ? '' : ' hidden'}>${lines.join('')}
    </div>
  `;
}

function wireItem(item: HTMLElement): void {
  const row = item.querySelector('.ds-flow-row') as HTMLButtonElement | null;
  const body = item.querySelector('.ds-flow-body') as HTMLElement | null;
  if (row && body) {
    row.addEventListener('click', () => {
      const open = body.hasAttribute('hidden');
      if (open) body.removeAttribute('hidden');
      else body.setAttribute('hidden', '');
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  const more = item.querySelector('.ds-flow-more') as HTMLButtonElement | null;
  if (more) {
    more.addEventListener('click', (event) => {
      // 阻止冒泡，避免同一击同时触发行折叠。
      event.stopPropagation();
      const clamp = item.querySelector('.ds-flow-clamp');
      if (clamp) clamp.classList.remove('ds-flow-clamp');
      more.remove();
    });
  }
}

function renderItem(
  item: HTMLElement,
  data: ToolCardData,
  status: ToolCallStatus,
  durationMs: number | undefined,
  startedAt: number,
  expanded: boolean,
): void {
  const previous = item.querySelectorAll('.ds-flow-row');
  for (let i = 0; i < previous.length; i += 1) stopTicker(previous[i] as HTMLElement);

  item.dataset.status = status;
  item.dataset.toolName = data.toolName;
  item.dataset.startedAt = String(startedAt);

  const known = durationMs ?? data.durationMs;
  if (typeof known === 'number' && Number.isFinite(known)) item.dataset.durationMs = String(known);
  else delete item.dataset.durationMs;

  item.innerHTML = buildItemHtml(data, status, known, startedAt, expanded);
  wireItem(item);

  const row = item.querySelector('.ds-flow-row') as HTMLElement | null;
  if (row) {
    if (status === 'running') startTicker(row, startedAt);
    else stopTicker(row);
  }
}

function findItem(container: HTMLElement, callId: string): HTMLElement | null {
  const items = container.querySelectorAll('.ds-flow-item');
  const target = String(callId);
  for (let i = 0; i < items.length; i += 1) {
    const el = items[i] as HTMLElement;
    if (el.dataset.callId === target) return el;
  }
  return null;
}

function getOrCreateFlow(container: HTMLElement): HTMLElement {
  let flow = container.querySelector('.ds-flow') as HTMLElement | null;
  if (flow) return flow;

  ensureStyle();
  flow = document.createElement('section');
  flow.className = 'ds-flow';
  flow.setAttribute('data-open', 'false');
  flow.innerHTML = `
    <button type="button" class="ds-flow-summary" aria-expanded="false">
      <span class="ds-flow-chev" aria-hidden="true"></span>
      <span class="ds-flow-summary-text">已调用工具</span>
      <span class="ds-flow-summary-time"></span>
    </button>
    <div class="ds-flow-list" role="list" hidden></div>
  `;

  const list = flow.querySelector('.ds-flow-list') as HTMLElement;
  const summary = flow.querySelector('.ds-flow-summary') as HTMLButtonElement;
  list.id = nextUid('ds-flow-list-');
  summary.setAttribute('aria-controls', list.id);
  summary.addEventListener('click', () => {
    const open = list.hasAttribute('hidden');
    if (open) list.removeAttribute('hidden');
    else list.setAttribute('hidden', '');
    flow!.setAttribute('data-open', open ? 'true' : 'false');
    summary.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // 过程在上、结论在下：插入到消息元素最前面
  container.insertBefore(flow, container.firstChild);
  return flow;
}

function updateSummary(container: HTMLElement): void {
  const flow = container.querySelector('.ds-flow') as HTMLElement | null;
  if (!flow) return;
  const items = flow.querySelectorAll('.ds-flow-item');
  let total = 0;
  let running = 0;
  for (let i = 0; i < items.length; i += 1) {
    const el = items[i] as HTMLElement;
    const duration = toFiniteNumber(el.dataset.durationMs);
    if (duration !== undefined) total += duration;
    if (el.dataset.status === 'running') running += 1;
  }
  const text = `已调用工具 · ${items.length} 次${running > 0 ? ` · ${running} 执行中` : ''}`;
  const textEl = flow.querySelector('.ds-flow-summary-text');
  const timeEl = flow.querySelector('.ds-flow-summary-time');
  if (textEl) textEl.textContent = text;
  if (timeEl) timeEl.textContent = total > 0 ? formatDurationMs(total) : '';
  flow.setAttribute('data-count', String(items.length));
}

/* ─────────────────────────────── 对外 API（逐条对齐 v1 契约） ─────────────────────────────── */

/**
 * 创建一个工具调用行级条目（执行中状态），追加到过程流容器里。
 * 返回 callId；同 callId 重复调用是幂等的（只刷新内容，不新增条目）。
 */
export function createRedesignedToolCard(data: ToolCardData, callId: string, container: HTMLElement): string {
  ensureStyle();
  const flow = getOrCreateFlow(container);
  const list = flow.querySelector('.ds-flow-list') as HTMLElement;
  const status = deriveToolStatus(data.result);
  let item = findItem(container, callId);

  if (!item) {
    item = document.createElement('div');
    item.className = 'ds-flow-item';
    item.setAttribute('role', 'listitem');
    item.dataset.callId = String(callId);
    list.appendChild(item);
    renderItem(item, data, status, data.durationMs, Date.now(), false);
  } else {
    const startedAt = toFiniteNumber(item.dataset.startedAt) ?? Date.now();
    const row = item.querySelector('.ds-flow-row');
    const expanded = row ? row.getAttribute('aria-expanded') === 'true' : false;
    renderItem(item, data, status, data.durationMs, startedAt, expanded);
  }

  updateSummary(container);
  return callId;
}

/**
 * 通过 callId 更新执行结果。
 * 条目存在则就地刷新（保留展开态与起始时间）；条目不存在（页面重渲染被删）则重建一个带结果的条目。
 */
export function updateRedesignedToolCardByCallId(
  callId: string,
  data: ToolCardData,
  result: NonNullable<ToolCardData['result']>,
  container: HTMLElement,
  durationMs?: number,
): void {
  const merged: ToolCardData = { ...data, result, durationMs };
  const status = deriveToolStatus(result);
  const existing = findItem(container, callId);

  if (existing) {
    const startedAt = toFiniteNumber(existing.dataset.startedAt) ?? Date.now();
    const row = existing.querySelector('.ds-flow-row');
    const expanded = row ? row.getAttribute('aria-expanded') === 'true' : false;
    renderItem(existing, merged, status, durationMs, startedAt, expanded);
    updateSummary(container);
    return;
  }

  createRedesignedToolCard(merged, callId, container);
}

/** v1 接口别名：与 src/inject/tool-card-ui.ts 同名，调用方无损切换。 */
export const createToolCard = createRedesignedToolCard;
/** v1 接口别名：与 src/inject/tool-card-ui.ts 同名，调用方无损切换。 */
export const updateToolCardByCallId = updateRedesignedToolCardByCallId;
