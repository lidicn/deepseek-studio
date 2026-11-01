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
import { upgradeLegacyDocument } from './vis/legacy';
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
  /** 命中的旧式榜单被迁移成 v1 文档的次数（仍算渲染成功）。 */
  upgraded: number;
  rendered: number;
  failures: Array<{ kind: 'fence' | 'bare'; reason: string }>;
}

const HOST_CLASS = 'ds-studio-vis-host';
const RENDERED_ATTR = 'data-ds-studio-vis-rendered';

let diagnostics: VisCardDiagnostics = {
  scannedFences: 0,
  scannedBare: 0,
  upgraded: 0,
  rendered: 0,
  failures: [],
};

export function getVisCardDiagnostics(): VisCardDiagnostics {
  return diagnostics;
}

function resetDiagnostics(): void {
  diagnostics = { scannedFences: 0, scannedBare: 0, upgraded: 0, rendered: 0, failures: [] };
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

/**
 * 页端图片代理缓存：同一张海报在多个卡片/多次扫描里只取一次。
 * 键是原始 URL，值是宿主返回的 data: URL；空字符串表示已确认失败。
 */
const IMAGE_CACHE_LIMIT = 64;
const imageCache = new Map<string, string>();
const imageInflight = new Map<string, Promise<string | null>>();

interface StudioHostBridge {
  sendEnvelope?: (envelope: {
    command: string;
    requestId: string;
    payload: unknown;
  }) => Promise<unknown>;
}

function studioHost(): StudioHostBridge | null {
  const g = globalThis as unknown as {
    __deepseekStudio?: { host?: StudioHostBridge };
    window?: { __deepseekStudio?: { host?: StudioHostBridge } };
  };
  const host = g.__deepseekStudio?.host ?? g.window?.__deepseekStudio?.host;
  return host && typeof host.sendEnvelope === 'function' ? host : null;
}

function rememberImage(url: string, dataUrl: string): void {
  if (imageCache.size >= IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(url, dataUrl);
}

/** 通过宿主抓图；失败返回 null（调用方降级为渐变占位）。 */
async function proxyImage(url: string): Promise<string | null> {
  const cached = imageCache.get(url);
  if (cached !== undefined) return cached === '' ? null : cached;
  const running = imageInflight.get(url);
  if (running !== undefined) return running;

  const host = studioHost();
  if (host === null || host.sendEnvelope === undefined) return null;

  const task = (async (): Promise<string | null> => {
    try {
      const raw = await host.sendEnvelope!({
        command: 'image_fetch',
        requestId:
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `img-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        payload: { url },
      });
      const response = raw as { ok?: unknown; dataUrl?: unknown } | null;
      if (response !== null && response.ok === true && typeof response.dataUrl === 'string'
        && response.dataUrl.startsWith('data:image/')) {
        rememberImage(url, response.dataUrl);
        return response.dataUrl;
      }
      rememberImage(url, '');
      return null;
    } catch {
      return null; // 瞬时失败不写负缓存，下次扫描可重试
    } finally {
      imageInflight.delete(url);
    }
  })();
  imageInflight.set(url, task);
  return task;
}

function replaceWithPlaceholder(imgEl: HTMLImageElement): void {
  const alt = imgEl.getAttribute('alt') ?? '';
  const placeholder = imgEl.ownerDocument.createElement('div');
  // 继承原 img 的类名（含 ratio-2x3），否则失败后海报框会退回自适应高度。
  placeholder.className = `${imgEl.className} ds-studio-vis-img--placeholder`.replace(/\s+/g, ' ').trim();
  placeholder.setAttribute('role', 'img');
  placeholder.setAttribute('aria-label', alt);
  const hue = imgEl.style.getPropertyValue('--ds-studio-vis-hue').trim();
  if (hue !== '') placeholder.style.setProperty('--ds-studio-vis-hue', hue);
  const span = imgEl.ownerDocument.createElement('span');
  span.className = 'ds-studio-vis-img__alt';
  span.textContent = alt;
  placeholder.appendChild(span);
  imgEl.replaceWith(placeholder);
}

/**
 * 图片加载失败：先让宿主带 Referer 代取（豆瓣等防盗链图源），成功则换成 data: URL；
 * 仍然失败才降级为渐变占位。每个 <img> 只尝试一次，避免 error 循环。
 */
function bindImageFallback(root: ShadowRoot): void {
  const images = root.querySelectorAll('img.ds-studio-vis-img');
  for (const img of images) {
    const imgEl = img as HTMLImageElement;
    const onError = (): void => {
      if (imgEl.dataset.dsProxyTried === '1') {
        replaceWithPlaceholder(imgEl);
        return;
      }
      imgEl.dataset.dsProxyTried = '1';
      const url = imgEl.currentSrc !== '' ? imgEl.currentSrc : imgEl.src;
      if (url === '' || url.startsWith('data:')) {
        replaceWithPlaceholder(imgEl);
        return;
      }
      // 没有宿主桥（测试环境 / 纯页面预览）时不要留下异步窗口：
      // 直接同步降级，调用方 dispatchEvent 后立刻就能看到占位。
      if (studioHost() === null) {
        replaceWithPlaceholder(imgEl);
        return;
      }
      void proxyImage(url).then((dataUrl) => {
        // 真机根因（C1 可视化验收）：卡片常常先在**游离节点**上渲染（applyVisCards
        // 在 msg.appendChild 之前调用），取图失败回调回来时元素还没入文档。
        // 旧代码 `if (!imgEl.isConnected) return;` 直接退出 → 破图永远不降级。
        // 游离节点上 replaceWith 同样安全，且能保证入文档后就是占位。
        if (dataUrl === null) {
          replaceWithPlaceholder(imgEl);
          return;
        }
        if (!imgEl.isConnected) return;
        imgEl.src = dataUrl;
      });
    };
    imgEl.addEventListener('error', onError);
    // 竞态兜底（真机实测）：监听是在 innerHTML 之后才绑的，而快速失败的图
    // （DNS 立刻失败 / 内网不可达 / 协议被拒）在绑定前就已经 error 过了，
    // 之后不会再触发 error → 页面上留下**破图**而不是渐变占位。
    // complete && naturalWidth===0 就是「已经失败」，这里补一次同一条降级路径。
    if (imgEl.complete && imgEl.naturalWidth === 0) onError();
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
    // 旧会话/旧客户端常产出无 v/root 的榜单 JSON：先尝试迁移，仍然失败才保留原文。
    const upgraded = upgradeLegacyDocument(doc);
    if (upgraded.upgraded) diagnostics.upgraded += 1;
    const result = renderToHtml(upgraded.doc);
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
    const upgraded = upgradeLegacyDocument(detected.doc);
    if (upgraded.upgraded) diagnostics.upgraded += 1;
    const result = renderToHtml(upgraded.doc);
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
