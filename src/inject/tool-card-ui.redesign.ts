/**
 * 工具调用卡片 UI 渲染器 · 重构版（tool-card-ui.redesign.ts）
 *
 * 契约与 src/inject/tool-card-ui.ts 逐一对齐（原文件不改，本文件为可直接移植替换的实现）：
 *   - ToolCardData / ToolCardResult 结构逐字段一致，可与原类型互相赋值；
 *   - createRedesignedToolCard(data, callId, container) ↔ createToolCard(data, callId, container)
 *   - updateRedesignedToolCardByCallId(callId, data, result, container, durationMs?)
 *       ↔ updateToolCardByCallId(callId, data, result, container, durationMs?)
 *     另支持 updateRedesignedToolCardByCallId({ ...data, callId, container }, result, durationMs?)；
 *   - 只写入调用方传入的容器，绝不查询或改写 DeepSeek React 管理的消息 DOM。
 *
 * 视觉与信息架构：
 *   - 卡片 = 2px 左侧状态线 + 极浅底 + 1px 边框；标题行 = 状态 / 工具名 / 参数提示 / 耗时 / 展开按钮；
 *   - 正文默认折叠；参数只给关键摘要，完整 JSON 需展开；结果 摘要 → 展开全文 → 展开全部 三级折叠；
 *   - 图片结果保留网格（危险协议丢弃）；running 有轻量脉冲点；浅/深色自适应；
 *     prefers-reduced-motion 下关闭全部动画；
 *   - 只创建 dsx- 前缀自有 class；动态文本统一经 src/ui/sanitizer 的 escapeHtml 写入，
 *     不存在任何未转义的 innerHTML 插值。
 *
 * 零外部依赖：仅浏览器 DOM API + src/ui/sanitizer 的 escapeHtml。
 */

import { escapeHtml } from '../ui/sanitizer';

/* ================================================================== */
/* 契约类型（与 src/inject/tool-card-ui.ts 逐字段一致）                    */
/* ================================================================== */

export interface ToolCardResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** v1.2 多模态结果（text / image_url） */
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
  details?: Record<string, unknown>;
  isError?: boolean;
  terminate?: boolean;
}

export interface ToolCardData {
  toolName: string;
  params: Record<string, unknown>;
  result?: ToolCardResult;
  durationMs?: number;
}

/** updateRedesignedToolCardByCallId 三参形态使用的数据（data 自带 callId / container） */
export interface RedesignedToolCardUpdate extends ToolCardData {
  callId: string;
  container?: HTMLElement;
}

/** 六种状态语义（文本固定中文，见 STATUS_TEXT） */
export type ToolStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled'
  | 'terminated';

export interface ParamSummaryItem {
  key: string;
  value: string;
}

type ResultState = 'summary' | 'full' | 'unclamped';

const STATUS_TEXT: Record<ToolStatus, string> = {
  running: '执行中',
  succeeded: '已完成',
  failed: '执行失败',
  denied: '已拒绝',
  cancelled: '已取消',
  terminated: '已终止',
};

/** 显式状态字段（details.status / code / kind / errorType）的规范化映射 */
const STATUS_HINTS: Record<string, ToolStatus | undefined> = {
  running: 'running',
  pending: 'running',
  in_progress: 'running',
  ok: 'succeeded',
  success: 'succeeded',
  succeeded: 'succeeded',
  done: 'succeeded',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  denied: 'denied',
  permission_denied: 'denied',
  rejected: 'denied',
  refused: 'denied',
  forbidden: 'denied',
  unauthorized: 'denied',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  aborted: 'cancelled',
  interrupted: 'cancelled',
  terminated: 'terminated',
  terminate: 'terminated',
};

const DENIED_WORDS = [
  'denied', 'permission', 'forbidden', 'unauthorized', 'rejected', 'refused',
  '拒绝', '权限', '禁止',
];

const CANCEL_WORDS = ['cancel', 'abort', 'interrupt', '取消', '中止', '中断'];

const LONG_TEXT_CHARS = 2048;
const LONG_TEXT_LINES = 16;
const SUMMARY_CHARS = 160;
const PARAM_VALUE_CHARS = 48;
const PARAM_SUMMARY_LIMIT = 4;
const REGISTRY_LIMIT = 200;

/* ================================================================== */
/* 纯函数（无 DOM 依赖，便于单测）                                        */
/* ================================================================== */

function toText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 耗时格式化：850ms / 1.25s / 2m 5s；非法输入返回空串 */
export function formatDurationMs(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${trimSeconds(totalSeconds.toFixed(2))}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m ${seconds}s`;
}

function trimSeconds(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function normalizeHint(value: unknown): string {
  return toText(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function readStatusHint(result: ToolCardResult): ToolStatus | undefined {
  const details = result.details;
  if (!details || typeof details !== 'object') return undefined;
  const keys = ['status', 'code', 'kind', 'errorType', 'error_type'];
  for (const key of keys) {
    const raw = (details as Record<string, unknown>)[key];
    if (typeof raw !== 'string') continue;
    const mapped = STATUS_HINTS[normalizeHint(raw)];
    if (mapped) return mapped;
  }
  return undefined;
}

/**
 * 状态推导（优先级见 §7）：
 *   无 result → running；显式 details 状态 → 该状态；terminate → terminated；
 *   isError/ok===false → denied / cancelled / failed（按文案线索细分）；其余 → succeeded。
 */
export function resolveToolStatus(result?: ToolCardResult): ToolStatus {
  if (!result) return 'running';
  const hint = readStatusHint(result);
  if (hint) return hint;
  if (result.terminate === true) return 'terminated';
  const failed = result.isError === true || result.ok === false;
  if (failed) {
    const haystack = toText(result.error).toLowerCase();
    if (DENIED_WORDS.some((word) => haystack.includes(word))) return 'denied';
    if (CANCEL_WORDS.some((word) => haystack.includes(word))) return 'cancelled';
    return 'failed';
  }
  return 'succeeded';
}

/**
 * 结果文本：content 优先 → 回退旧格式（error / stdout / string / JSON）→ isError 加前缀。
 * 与 src/shared/tool-result-format.ts 的语义一致（本文件受“零外部依赖”约束本地复刻，见 §7）。
 */
export function formatResultText(result: ToolCardResult): string {
  let text = '';

  if (Array.isArray(result.content)) {
    const chunks: string[] = [];
    for (const item of result.content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text') chunks.push(typeof item.text === 'string' ? item.text : '');
    }
    if (chunks.length > 0) text = chunks.join('\n');
  }

  if (text.trim() === '') {
    if (typeof result.error === 'string' && result.error.trim() !== '') {
      text = result.error;
    } else {
      const data: unknown = result.data;
      if (typeof data === 'string') {
        text = data;
      } else if (data !== undefined && data !== null) {
        if (typeof data === 'object') {
          const obj = data as Record<string, unknown>;
          const stdout = typeof obj.stdout === 'string' ? obj.stdout : '';
          const stderr = typeof obj.stderr === 'string' ? obj.stderr : '';
          if (stdout.trim() !== '') text = stdout;
          else if (stderr.trim() !== '') text = stderr;
          else text = safeJson(data);
        } else {
          text = toText(data);
        }
      }
    }
  }

  if (result.isError === true && text !== '' && !text.startsWith('错误：')) {
    text = `错误：${text}`;
  }
  return text;
}

/** 结果摘要：截断到 160 字符，超出补省略号 */
export function summarizeResultText(text: string): string {
  const clean = toText(text).replace(/\s+$/, '');
  if (clean === '') return '';
  if (clean.length <= SUMMARY_CHARS) return clean;
  return `${clean.slice(0, SUMMARY_CHARS)}…`;
}

function shortValue(value: unknown): string {
  if (typeof value === 'string') {
    const flat = value.trim().replace(/\s+/g, ' ');
    return flat.length > PARAM_VALUE_CHARS ? `${flat.slice(0, PARAM_VALUE_CHARS)}…` : flat;
  }
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).length} 键}`;
  }
  return toText(value);
}

/** 关键参数摘要（默认前 4 条），完整 JSON 走展开区 */
export function summarizeParams(
  params: Record<string, unknown>,
  limit: number = PARAM_SUMMARY_LIMIT,
): ParamSummaryItem[] {
  const source = params && typeof params === 'object' ? params : {};
  return Object.entries(source)
    .slice(0, Math.max(0, limit))
    .map(([key, value]) => ({ key: toText(key), value: shortValue(value) }));
}

function isLongText(text: string): boolean {
  return text.length > LONG_TEXT_CHARS || text.split('\n').length > LONG_TEXT_LINES;
}

/* ================================================================== */
/* 样式（token + 状态线 + 深色 + reduced-motion）                        */
/* ================================================================== */

const STYLE_ID = 'dsx-tool-card-style';

const TOOL_STYLE = `
.dsx-tools-root {
  --dsx-bg: #ffffff;
  --dsx-surface: #f9fafb;
  --dsx-surface-2: #f3f4f6;
  --dsx-pre-bg: #f9fafb;
  --dsx-border: #e5e7eb;
  --dsx-ink: #111827;
  --dsx-ink-2: #374151;
  --dsx-muted: #6b7280;
  --dsx-faint: #9ca3af;
  --dsx-focus: #2563eb;

  --dsx-running-line: #93c5fd;
  --dsx-running-bg: #eff6ff;
  --dsx-running-ink: #1d4ed8;
  --dsx-succeeded-line: #86efac;
  --dsx-succeeded-bg: #f0fdf4;
  --dsx-succeeded-ink: #15803d;
  --dsx-failed-line: #fca5a5;
  --dsx-failed-bg: #fef2f2;
  --dsx-failed-ink: #b91c1c;
  --dsx-denied-line: #fcd34d;
  --dsx-denied-bg: #fffbeb;
  --dsx-denied-ink: #b45309;
  --dsx-cancelled-line: #cbd5e1;
  --dsx-cancelled-bg: #f1f5f9;
  --dsx-cancelled-ink: #475569;
  --dsx-terminated-line: #c4b5fd;
  --dsx-terminated-bg: #f5f3ff;
  --dsx-terminated-ink: #6d28d9;

  margin: 12px 0;
  border: 1px solid var(--dsx-border);
  border-radius: 8px;
  background: var(--dsx-bg);
  color: var(--dsx-ink-2);
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
  line-height: 1.55;
}
.dsx-tools-root [hidden] { display: none !important; }

.dsx-tools-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-bottom: 1px solid var(--dsx-border);
  background: var(--dsx-surface);
  color: var(--dsx-ink-2);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.dsx-tools-head:hover { background: var(--dsx-surface-2); }
.dsx-tools-chevron {
  color: var(--dsx-faint);
  font-size: 10px;
  width: 12px;
  text-align: center;
}
.dsx-tools-title { color: var(--dsx-ink-2); }
.dsx-tools-count {
  margin-left: auto;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--dsx-surface-2);
  color: var(--dsx-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dsx-tools-body {
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dsx-tool-card {
  --dsx-state-line: var(--dsx-border);
  --dsx-state-bg: var(--dsx-surface-2);
  --dsx-state-ink: var(--dsx-muted);
  border: 1px solid var(--dsx-border);
  border-left: 2px solid var(--dsx-state-line);
  border-radius: 6px;
  background: var(--dsx-surface);
  overflow: hidden;
}
.dsx-tool-card.dsx-state-running {
  --dsx-state-line: var(--dsx-running-line);
  --dsx-state-bg: var(--dsx-running-bg);
  --dsx-state-ink: var(--dsx-running-ink);
}
.dsx-tool-card.dsx-state-succeeded {
  --dsx-state-line: var(--dsx-succeeded-line);
  --dsx-state-bg: var(--dsx-succeeded-bg);
  --dsx-state-ink: var(--dsx-succeeded-ink);
}
.dsx-tool-card.dsx-state-failed {
  --dsx-state-line: var(--dsx-failed-line);
  --dsx-state-bg: var(--dsx-failed-bg);
  --dsx-state-ink: var(--dsx-failed-ink);
}
.dsx-tool-card.dsx-state-denied {
  --dsx-state-line: var(--dsx-denied-line);
  --dsx-state-bg: var(--dsx-denied-bg);
  --dsx-state-ink: var(--dsx-denied-ink);
}
.dsx-tool-card.dsx-state-cancelled {
  --dsx-state-line: var(--dsx-cancelled-line);
  --dsx-state-bg: var(--dsx-cancelled-bg);
  --dsx-state-ink: var(--dsx-cancelled-ink);
}
.dsx-tool-card.dsx-state-terminated {
  --dsx-state-line: var(--dsx-terminated-line);
  --dsx-state-bg: var(--dsx-terminated-bg);
  --dsx-state-ink: var(--dsx-terminated-ink);
}

.dsx-tool-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  color: var(--dsx-ink-2);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.dsx-tool-card-head:hover { background: var(--dsx-surface-2); }

.dsx-tool-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--dsx-state-bg);
  color: var(--dsx-state-ink);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.dsx-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.9;
}
.dsx-tool-card.dsx-state-running .dsx-tool-status .dsx-dot {
  animation: dsx-pulse 1.2s ease-in-out infinite;
}
.dsx-tool-status-text { line-height: 1.4; }

.dsx-tool-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  color: var(--dsx-ink);
  white-space: nowrap;
}
.dsx-tool-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsx-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 11px;
}
.dsx-tool-duration {
  color: var(--dsx-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsx-tool-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsx-muted);
  font-size: 11px;
  white-space: nowrap;
}
.dsx-tool-chevron {
  color: var(--dsx-faint);
  font-size: 9px;
}

.dsx-tool-card-body {
  padding: 2px 10px 10px;
  border-top: 1px solid var(--dsx-border);
}
.dsx-tool-section { padding-top: 8px; }
.dsx-tool-section + .dsx-tool-section {
  margin-top: 8px;
  border-top: 1px solid var(--dsx-border);
}
.dsx-tool-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsx-label {
  color: var(--dsx-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
}
.dsx-tool-meta {
  color: var(--dsx-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.dsx-tool-link-btn {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--dsx-muted);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.dsx-tool-link-btn:hover {
  background: var(--dsx-surface-2);
  color: var(--dsx-ink-2);
}
.dsx-tools-root button:focus-visible {
  outline: 2px solid var(--dsx-focus);
  outline-offset: -1px;
}

.dsx-tool-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding-top: 6px;
}
.dsx-tool-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  max-width: 260px;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 11px;
}
.dsx-tool-chip-key { color: var(--dsx-muted); }
.dsx-tool-chip-value {
  color: var(--dsx-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsx-tool-chip-more,
.dsx-tool-chip-empty {
  color: var(--dsx-faint);
  font-family: inherit;
}

.dsx-pre {
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--dsx-border);
  border-radius: 6px;
  background: var(--dsx-pre-bg);
  color: var(--dsx-ink-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
.dsx-pre.dsx-clamped {
  max-height: 144px;
  overflow: hidden;
}

.dsx-tool-result-summary {
  margin-top: 6px;
  padding: 6px 8px;
  border-left: 2px solid var(--dsx-border);
  color: var(--dsx-ink-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.dsx-tool-result-pending {
  padding-top: 6px;
  color: var(--dsx-faint);
  font-size: 11px;
}
.dsx-tool-result-expand-all { margin-left: 0; margin-top: 6px; }

.dsx-tool-images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.dsx-tool-image {
  display: block;
  width: 100%;
  height: 120px;
  object-fit: cover;
  border: 1px solid var(--dsx-border);
  border-radius: 6px;
  background: var(--dsx-surface-2);
  cursor: zoom-in;
}

@keyframes dsx-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-color-scheme: dark) {
  .dsx-tools-root {
    --dsx-bg: #16181d;
    --dsx-surface: #1c1f26;
    --dsx-surface-2: #22262e;
    --dsx-pre-bg: #1c1f26;
    --dsx-border: #2c313a;
    --dsx-ink: #e5e7eb;
    --dsx-ink-2: #cbd5e1;
    --dsx-muted: #94a3b8;
    --dsx-faint: #64748b;
    --dsx-focus: #60a5fa;

    --dsx-running-line: #60a5fa;
    --dsx-running-bg: rgba(59, 130, 246, 0.16);
    --dsx-running-ink: #bfdbfe;
    --dsx-succeeded-line: #4ade80;
    --dsx-succeeded-bg: rgba(34, 197, 94, 0.14);
    --dsx-succeeded-ink: #86efac;
    --dsx-failed-line: #f87171;
    --dsx-failed-bg: rgba(248, 113, 113, 0.14);
    --dsx-failed-ink: #fca5a5;
    --dsx-denied-line: #fbbf24;
    --dsx-denied-bg: rgba(251, 191, 36, 0.14);
    --dsx-denied-ink: #fcd34d;
    --dsx-cancelled-line: #94a3b8;
    --dsx-cancelled-bg: rgba(148, 163, 184, 0.14);
    --dsx-cancelled-ink: #cbd5e1;
    --dsx-terminated-line: #a78bfa;
    --dsx-terminated-bg: rgba(167, 139, 250, 0.16);
    --dsx-terminated-ink: #ddd6fe;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dsx-tools-root, .dsx-tools-root * {
    animation: none !important;
    transition: none !important;
  }
}
`;

function ensureStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TOOL_STYLE;
  (document.head ?? document.documentElement).appendChild(style);
}

/* ================================================================== */
/* DOM 工具                                                            */
/* ================================================================== */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** 唯一动态文本写入口：一律经 sanitizer 的 escapeHtml，无原始 innerHTML 插值 */
function setText(node: Element, value: unknown): void {
  node.innerHTML = escapeHtml(toText(value));
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function assertContainer(container: unknown): void {
  const candidate = container as { querySelector?: unknown } | null | undefined;
  if (!candidate || typeof candidate.querySelector !== 'function') {
    throw new TypeError('tool-card-ui.redesign: container 必须是可查询的 HTMLElement');
  }
}

function isSafeImageUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  return url.startsWith('data:image/') || url.startsWith('https://');
}

function collectImages(result: ToolCardResult): string[] {
  const urls: string[] = [];
  if (!Array.isArray(result.content)) return urls;
  for (const item of result.content) {
    if (!item || typeof item !== 'object' || item.type !== 'image_url') continue;
    const url: unknown = item.image_url ? item.image_url.url : undefined;
    if (isSafeImageUrl(url)) urls.push(url as string);
  }
  return urls;
}

/* ================================================================== */
/* callId 索引（仅用于恢复容器；DOM 查找优先，避免选择器注入）              */
/* ================================================================== */

interface CardRef {
  card: HTMLElement;
  container: HTMLElement;
}

const registry = new Map<string, CardRef>();

function remember(callId: string, card: HTMLElement, container: HTMLElement): void {
  if (registry.has(callId)) registry.delete(callId);
  registry.set(callId, { card, container });
  if (registry.size > REGISTRY_LIMIT) {
    const oldest = registry.keys().next();
    if (!oldest.done) registry.delete(oldest.value);
  }
}

function resolveContainer(callId: string): HTMLElement {
  const entry = registry.get(callId);
  if (entry) return entry.container;
  throw new TypeError(`tool-card-ui.redesign: 无法定位 callId=${callId} 的容器，请显式传入 container`);
}

/** 逐个比对 dataset.callId，避免把 callId 拼进 CSS 选择器 */
function findCard(container: HTMLElement, callId: string): HTMLElement | null {
  const cards = container.querySelectorAll('.dsx-tool-card');
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i] as HTMLElement;
    if (card.dataset.callId === callId) return card;
  }
  return null;
}

function updateCount(root: HTMLElement): void {
  const count = root.querySelector('.dsx-tools-count');
  if (!count) return;
  setText(count, String(root.querySelectorAll('.dsx-tool-card').length));
}

function getOrCreateToolsRoot(container: HTMLElement): HTMLElement {
  const found = container.querySelector('.dsx-tools-root') as HTMLElement | null;
  if (found) return found;

  ensureStyle();
  const root = el('div', 'dsx-tools-root');
  const bodyId = nextId('dsx-tools-body');

  const head = el('button', 'dsx-tools-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  head.setAttribute('aria-controls', bodyId);

  const chevron = el('span', 'dsx-tools-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▼';

  const title = el('span', 'dsx-tools-title');
  title.textContent = '已调用工具';

  const count = el('span', 'dsx-tools-count');
  setText(count, '0');

  head.appendChild(chevron);
  head.appendChild(title);
  head.appendChild(count);

  const body = el('div', 'dsx-tools-body');
  body.id = bodyId;

  root.appendChild(head);
  root.appendChild(body);

  head.addEventListener('click', () => {
    const collapsed = root.classList.toggle('dsx-collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) body.setAttribute('hidden', '');
    else body.removeAttribute('hidden');
    chevron.textContent = collapsed ? '▶' : '▼';
  });

  // v0.19 语义：工具在上、结论在下
  container.insertBefore(root, container.firstChild);
  return root;
}

/* ================================================================== */
/* 卡片渲染                                                            */
/* ================================================================== */

function buildParamHint(params: Record<string, unknown>): string {
  const total = Object.keys(params).length;
  if (total === 0) return '（无参数）';
  const items = summarizeParams(params, 2);
  const text = items.map((item) => `${item.key}: ${item.value}`).join(' · ');
  return total > items.length ? `${text} …` : text;
}

function normalizeCardState(card: HTMLElement): void {
  if (card.dataset.dsxBody !== 'open' && card.dataset.dsxBody !== 'closed') {
    card.dataset.dsxBody = 'closed';
  }
  if (card.dataset.dsxParams !== 'full' && card.dataset.dsxParams !== 'summary') {
    card.dataset.dsxParams = 'summary';
  }
  const state = card.dataset.dsxResult;
  if (state !== 'full' && state !== 'unclamped' && state !== 'summary') {
    card.dataset.dsxResult = 'summary';
  }
}

function buildParamsSection(
  card: HTMLElement,
  params: Record<string, unknown>,
  jsonId: string,
): HTMLElement {
  const section = el('section', 'dsx-tool-section dsx-tool-params');

  const headRow = el('div', 'dsx-tool-section-head');
  const label = el('span', 'dsx-label');
  setText(label, '参数');
  headRow.appendChild(label);

  const total = Object.keys(params).length;
  const meta = el('span', 'dsx-tool-meta');
  setText(meta, total === 0 ? '无参数' : `${total} 项`);
  headRow.appendChild(meta);

  const toggleBtn = el('button', 'dsx-tool-link-btn dsx-tool-params-toggle');
  toggleBtn.type = 'button';
  headRow.appendChild(toggleBtn);
  section.appendChild(headRow);

  const chips = el('div', 'dsx-tool-chips');
  const items = summarizeParams(params);
  if (items.length === 0) {
    const emptyChip = el('span', 'dsx-tool-chip dsx-tool-chip-empty');
    setText(emptyChip, '（无参数）');
    chips.appendChild(emptyChip);
  } else {
    for (const item of items) {
      const chip = el('span', 'dsx-tool-chip');
      const keyEl = el('span', 'dsx-tool-chip-key');
      setText(keyEl, `${item.key}:`);
      const valueEl = el('span', 'dsx-tool-chip-value');
      setText(valueEl, item.value);
      chip.appendChild(keyEl);
      chip.appendChild(valueEl);
      chips.appendChild(chip);
    }
    if (total > items.length) {
      const more = el('span', 'dsx-tool-chip dsx-tool-chip-more');
      setText(more, `另有 ${total - items.length} 项`);
      chips.appendChild(more);
    }
  }
  section.appendChild(chips);

  const pre = el('pre', 'dsx-pre dsx-tool-params-json');
  pre.id = jsonId;
  setText(pre, safeJson(params));
  section.appendChild(pre);

  const applyState = (): void => {
    const expanded = card.dataset.dsxParams === 'full';
    toggleBtn.setAttribute('aria-expanded', String(expanded));
    toggleBtn.setAttribute('aria-controls', jsonId);
    setText(toggleBtn, expanded ? '收起' : '完整 JSON');
    if (expanded) pre.removeAttribute('hidden');
    else pre.setAttribute('hidden', '');
  };
  applyState();

  toggleBtn.addEventListener('click', () => {
    card.dataset.dsxParams = card.dataset.dsxParams === 'full' ? 'summary' : 'full';
    applyState();
  });

  return section;
}

function buildResultSection(
  card: HTMLElement,
  result: ToolCardResult | undefined,
  textId: string,
): HTMLElement {
  const section = el('section', 'dsx-tool-section dsx-tool-result');

  const headRow = el('div', 'dsx-tool-section-head');
  const label = el('span', 'dsx-label');
  setText(label, '结果');
  headRow.appendChild(label);

  if (!result) {
    const meta = el('span', 'dsx-tool-meta');
    setText(meta, '执行中，暂无结果');
    headRow.appendChild(meta);
    section.appendChild(headRow);
    return section;
  }

  const text = formatResultText(result);
  const images = collectImages(result);

  const meta = el('span', 'dsx-tool-meta');
  const metaParts: string[] = [];
  if (text !== '') metaParts.push(`文本 ${text.length} 字符`);
  if (images.length > 0) metaParts.push(`图片 ${images.length} 张`);
  setText(meta, metaParts.length > 0 ? metaParts.join(' · ') : '（无内容）');
  headRow.appendChild(meta);

  let toggleBtn: HTMLButtonElement | null = null;
  if (text !== '') {
    toggleBtn = el('button', 'dsx-tool-link-btn dsx-tool-result-toggle');
    toggleBtn.type = 'button';
    headRow.appendChild(toggleBtn);
  }
  section.appendChild(headRow);

  if (images.length > 0) {
    const grid = el('div', 'dsx-tool-images');
    images.forEach((url, index) => {
      const img = document.createElement('img');
      img.className = 'dsx-tool-image';
      img.setAttribute('src', url);
      img.setAttribute('alt', `工具结果图片 ${index + 1}`);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      grid.appendChild(img);
    });
    section.appendChild(grid);
  }

  if (text === '') return section;

  const summaryEl = el('div', 'dsx-tool-result-summary');
  setText(summaryEl, summarizeResultText(text));

  const fullEl = el('div', 'dsx-tool-result-full');
  const pre = el('pre', 'dsx-pre dsx-tool-result-text');
  pre.id = textId;
  setText(pre, text);
  fullEl.appendChild(pre);

  const long = isLongText(text);
  let expandAll: HTMLButtonElement | null = null;
  if (long) {
    expandAll = el('button', 'dsx-tool-link-btn dsx-tool-result-expand-all');
    expandAll.type = 'button';
    setText(expandAll, '展开全部');
    fullEl.appendChild(expandAll);
  }

  section.appendChild(summaryEl);
  section.appendChild(fullEl);

  const applyState = (): void => {
    const current = (card.dataset.dsxResult ?? 'summary') as ResultState;
    const collapsed = current === 'summary';
    if (collapsed) {
      summaryEl.removeAttribute('hidden');
      fullEl.setAttribute('hidden', '');
    } else {
      summaryEl.setAttribute('hidden', '');
      fullEl.removeAttribute('hidden');
    }
    const clamped = long && current !== 'unclamped';
    pre.className = `dsx-pre dsx-tool-result-text${clamped ? ' dsx-clamped' : ''}`;
    if (expandAll) {
      expandAll.setAttribute('aria-expanded', String(current === 'unclamped'));
      expandAll.setAttribute('aria-controls', textId);
      if (current === 'unclamped') expandAll.setAttribute('hidden', '');
      else expandAll.removeAttribute('hidden');
    }
    if (toggleBtn) {
      setText(toggleBtn, collapsed ? '展开全文' : '收起');
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      toggleBtn.setAttribute('aria-controls', textId);
    }
  };
  applyState();

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const next: ResultState =
        (card.dataset.dsxResult ?? 'summary') === 'summary' ? 'full' : 'summary';
      card.dataset.dsxResult = next;
      applyState();
    });
  }
  if (expandAll) {
    expandAll.addEventListener('click', () => {
      card.dataset.dsxResult = 'unclamped';
      applyState();
    });
  }

  return section;
}

function renderCard(card: HTMLElement, callId: string, data: ToolCardData): void {
  const params = (data.params ?? {}) as Record<string, unknown>;
  const result = data.result;
  const status = resolveToolStatus(result);
  const toolName = toText(data.toolName);

  normalizeCardState(card);
  card.className = `dsx-tool-card dsx-state-${status}`;
  card.dataset.callId = callId;
  card.dataset.toolName = toolName;
  card.dataset.status = status;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `工具 ${toolName}，状态${STATUS_TEXT[status]}`);
  card.textContent = '';

  const bodyOpen = card.dataset.dsxBody === 'open';
  const bodyId = nextId('dsx-body');
  const paramsJsonId = nextId('dsx-params');
  const resultTextId = nextId('dsx-result');

  /* 标题行：状态 / 工具名 / 参数提示 / 耗时 / 展开按钮 */
  const head = el('button', 'dsx-tool-card-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(bodyOpen));
  head.setAttribute('aria-controls', bodyId);

  const chip = el('span', `dsx-tool-status dsx-state-${status}`);
  const dot = el('span', 'dsx-dot');
  dot.setAttribute('aria-hidden', 'true');
  chip.appendChild(dot);
  const chipText = el('span', 'dsx-tool-status-text');
  setText(chipText, STATUS_TEXT[status]);
  chip.appendChild(chipText);
  head.appendChild(chip);

  const nameEl = el('span', 'dsx-tool-name');
  setText(nameEl, toolName);
  head.appendChild(nameEl);

  const hintEl = el('span', 'dsx-tool-hint');
  setText(hintEl, buildParamHint(params));
  head.appendChild(hintEl);

  const durationText =
    typeof data.durationMs === 'number' ? formatDurationMs(data.durationMs) : '';
  if (durationText !== '') {
    const durationEl = el('span', 'dsx-tool-duration');
    setText(durationEl, durationText);
    head.appendChild(durationEl);
  }

  const toggleWrap = el('span', 'dsx-tool-toggle');
  const toggleText = el('span', 'dsx-tool-toggle-text');
  setText(toggleText, bodyOpen ? '收起' : '详情');
  const headChevron = el('span', 'dsx-tool-chevron');
  headChevron.setAttribute('aria-hidden', 'true');
  headChevron.textContent = bodyOpen ? '▲' : '▼';
  toggleWrap.appendChild(toggleText);
  toggleWrap.appendChild(headChevron);
  head.appendChild(toggleWrap);

  /* 正文：默认折叠 */
  const bodyEl = el('div', 'dsx-tool-card-body');
  bodyEl.id = bodyId;
  if (!bodyOpen) bodyEl.setAttribute('hidden', '');
  bodyEl.appendChild(buildParamsSection(card, params, paramsJsonId));
  bodyEl.appendChild(buildResultSection(card, result, resultTextId));

  card.appendChild(head);
  card.appendChild(bodyEl);

  head.addEventListener('click', () => {
    const open = card.dataset.dsxBody !== 'open';
    card.dataset.dsxBody = open ? 'open' : 'closed';
    head.setAttribute('aria-expanded', String(open));
    setText(toggleText, open ? '收起' : '详情');
    headChevron.textContent = open ? '▲' : '▼';
    if (open) bodyEl.removeAttribute('hidden');
    else bodyEl.setAttribute('hidden', '');
  });
}

function getBody(root: HTMLElement): HTMLElement {
  return root.querySelector('.dsx-tools-body') as HTMLElement;
}

function ensureCard(container: HTMLElement, callId: string): { root: HTMLElement; card: HTMLElement } {
  const root = getOrCreateToolsRoot(container);
  let card = findCard(container, callId);
  if (!card) {
    card = el('div', 'dsx-tool-card');
    getBody(root).appendChild(card);
  }
  remember(callId, card, container);
  return { root, card };
}

/* ================================================================== */
/* 公共 API（与 §1 契约对齐）                                            */
/* ================================================================== */

/**
 * 创建工具调用卡片（默认 running，正文折叠），追加工具容器。
 * 同 callId 已存在时原地重渲染，不产生重复卡片。返回 callId。
 */
export function createRedesignedToolCard(
  data: ToolCardData,
  callId: string,
  container: HTMLElement,
): string {
  assertContainer(container);
  ensureStyle();
  const { root, card } = ensureCard(container, callId);
  renderCard(card, callId, {
    toolName: data.toolName,
    params: data.params,
    result: data.result,
    durationMs: data.durationMs,
  });
  updateCount(root);
  return callId;
}

/**
 * 更新工具调用卡片结果。
 * 形态 A（与 §1 完全一致）：updateRedesignedToolCardByCallId(callId, data, result, container, durationMs?)
 * 形态 B：updateRedesignedToolCardByCallId({ ...data, callId, container? }, result, durationMs?)
 * 卡片不存在（页面重渲染被删）时按 callId 重建。
 */
export function updateRedesignedToolCardByCallId(
  callId: string,
  data: ToolCardData,
  result: ToolCardResult,
  container: HTMLElement,
  durationMs?: number,
): void;
export function updateRedesignedToolCardByCallId(
  data: RedesignedToolCardUpdate,
  result: ToolCardResult,
  durationMs?: number,
): void;
export function updateRedesignedToolCardByCallId(
  callIdOrData: string | RedesignedToolCardUpdate,
  dataOrResult: ToolCardData | ToolCardResult,
  resultOrDuration?: ToolCardResult | number,
  container?: HTMLElement,
  durationMs?: number,
): void {
  if (typeof callIdOrData === 'string') {
    applyResult(
      callIdOrData,
      dataOrResult as ToolCardData,
      resultOrDuration as ToolCardResult,
      container as HTMLElement,
      durationMs,
    );
    return;
  }
  const updateData = callIdOrData;
  const target = updateData.container ?? resolveContainer(updateData.callId);
  const ms = typeof resultOrDuration === 'number' ? resultOrDuration : undefined;
  applyResult(updateData.callId, updateData, dataOrResult as ToolCardResult, target, ms);
}

function applyResult(
  callId: string,
  data: ToolCardData,
  result: ToolCardResult,
  container: HTMLElement,
  durationMs?: number,
): void {
  assertContainer(container);
  ensureStyle();
  const { root, card } = ensureCard(container, callId);
  renderCard(card, callId, {
    toolName: data.toolName,
    params: data.params,
    result,
    durationMs: typeof durationMs === 'number' ? durationMs : data.durationMs,
  });
  updateCount(root);
}
