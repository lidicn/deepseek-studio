/**
 * 可视化卡片（A2UI 子集）注入层。
 *
 * 职责边界（架构红线）：只允许改 Studio 自有的 assistant message DOM
 * （.ds-sc-markdown / .ds-sc-streaming），严禁改 DeepSeek React 管理的消息 DOM。
 * 本文件的所有写入都在传入的 scope 内部完成。
 *
 * 两条识别路径（与 dpp 保持一致）：
 *  1. 围栏路径：```json 代码块里就是整份 A2UI 文档 → 整块替换为卡片；
 *  2. 裸 JSON 路径：正文里直接出现 {"v":1,...} → 定位到所在段落替换为卡片。
 *
 * 失败策略：解析失败 / 版本不匹配 / 渲染 failed ⇒ **保留原始代码块**（不吞内容）。
 */

import { renderToHtml } from './vis/render';
import { buildVisCss } from './vis/theme';
import { blockElementsFor, findVisDocuments } from './vis/text-detect';
import DOMPurify from 'dompurify';

export interface VisCardOptions {
  /** 单次扫描最多渲染几张卡（防抖/防刷屏）。 */
  limit?: number;
  /** 主题，默认 dark（DeepSeek 本身是深色）。 */
  theme?: 'light' | 'dark';
}

export interface VisCardDiagnostics {
  scannedFences: number;
  scannedBare: number;
  rendered: number;
  failures: Array<{ kind: 'fence' | 'bare'; reason: string }>;
}

const HOST_CLASS = 'ds-studio-vis-host';
const RENDERED_ATTR = 'data-ds-studio-vis-rendered';

let diagnostics: VisCardDiagnostics = {
  scannedFences: 0,
  scannedBare: 0,
  rendered: 0,
  failures: [],
};

export function getVisCardDiagnostics(): VisCardDiagnostics {
  return diagnostics;
}

function resetDiagnostics(): void {
  diagnostics = { scannedFences: 0, scannedBare: 0, rendered: 0, failures: [] };
}

/** 卡片宿主：Shadow DOM 隔离样式，避免污染 DeepSeek 页面既有 CSS。 */
function createHost(doc: Document, html: string, theme: 'light' | 'dark'): HTMLElement {
  const host = doc.createElement('div');
  host.className = HOST_CLASS;
  host.setAttribute(RENDERED_ATTR, '1');
  host.style.display = 'block';
  host.style.margin = '10px 0';
  host.setAttribute('data-ds-studio-vis-theme', theme);
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = buildVisCss({ scope: ':host' });
  root.appendChild(style);
  const body = doc.createElement('div');
  body.className = 'ds-studio-vis-root';
  // html 来自 renderToHtml()，其中所有可变文本/属性均已 escapeHtml（见 vis/escape.ts）。
  // 仍再过一道 DOMPurify：模型输出的属性串一旦漏转义，这里是最后一道闸门（QA-1 阻断项）。
  body.innerHTML = DOMPurify.sanitize(html);
  root.appendChild(body);
  bindImageFallback(root);
  return host;
}

/** 图片加载失败时降级为渐变占位（studio 无远程代理，无法代取防盗链图）。 */
function bindImageFallback(root: ShadowRoot): void {
  const images = root.querySelectorAll('img.ds-studio-vis-img');
  for (const img of images) {
    img.addEventListener('error', () => {
      const alt = img.getAttribute('alt') ?? '';
      const placeholder = img.ownerDocument.createElement('div');
      placeholder.className = 'ds-studio-vis-img ds-studio-vis-img--placeholder';
      placeholder.setAttribute('role', 'img');
      placeholder.setAttribute('aria-label', alt);
      const span = img.ownerDocument.createElement('span');
      span.className = 'ds-studio-vis-img__alt';
      span.textContent = alt;
      placeholder.appendChild(span);
      img.replaceWith(placeholder);
    });
  }
}

/** 围栏路径：pre > code 的文本若能解析成 A2UI 文档则整块换成卡片。 */
function applyFenced(scope: HTMLElement, theme: 'light' | 'dark'): number {
  let rendered = 0;
  const pres = Array.from(scope.querySelectorAll('pre'));
  for (const pre of pres) {
    if (pre.getAttribute(RENDERED_ATTR) === '1') continue;
    if (pre.closest(`.${HOST_CLASS}`)) continue;
    const code = pre.querySelector('code');
    if (!code) continue;
    const text = (code.textContent ?? '').trim();
    if (!text.startsWith('{')) continue;
    diagnostics.scannedFences += 1;
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      diagnostics.failures.push({ kind: 'fence', reason: 'invalid_json' });
      continue;
    }
    const result = renderToHtml(doc);
    if (result.html === '' || result.outcome.status === 'failed') {
      diagnostics.failures.push({
        kind: 'fence',
        reason: result.outcome.reasons[0] ?? 'render_failed',
      });
      continue; // 保留原始代码块
    }
    const host = createHost(pre.ownerDocument, result.html, theme);
    pre.replaceWith(host);
    rendered += 1;
  }
  return rendered;
}

/** 裸 JSON 路径：正文段落里出现 {"v":1,...} 时定位到所在块级元素替换。 */
function applyBare(scope: HTMLElement, limit: number, theme: 'light' | 'dark'): number {
  let rendered = 0;
  const docs = findVisDocuments(scope, limit, {
    exclude: (el) => el.closest('pre,code') !== null,
  });
  for (const detected of docs) {
    const blocks = blockElementsFor(detected.range, scope);
    const target = blocks[blocks.length - 1];
    if (!target) continue;
    if (target.closest(`.${HOST_CLASS}`)) continue;
    diagnostics.scannedBare += 1;
    const result = renderToHtml(detected.doc);
    if (result.html === '' || result.outcome.status === 'failed') {
      diagnostics.failures.push({
        kind: 'bare',
        reason: result.outcome.reasons[0] ?? 'render_failed',
      });
      continue; // 保留原文
    }
    const host = createHost(target.ownerDocument, result.html, theme);
    target.replaceWith(host);
    rendered += 1;
  }
  return rendered;
}

/**
 * 在 scope 内应用可视化卡片。
 * @returns 实际渲染出的卡片数
 */
export function applyVisCards(scope: HTMLElement, options: VisCardOptions = {}): number {
  if (!scope) return 0;
  const limit = options.limit ?? 3;
  const theme = options.theme ?? 'dark';
  resetDiagnostics();
  const count = applyFenced(scope, theme) + applyBare(scope, limit, theme);
  diagnostics.rendered = count;
  const g = globalThis as unknown as { __studioVis?: VisCardDiagnostics };
  g.__studioVis = diagnostics;
  return count;
}
