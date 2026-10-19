/**
 * 真 Shadow DOM 挂载工具
 *
 * 使用 host.attachShadow({ mode: 'open' })，样式通过 adoptedStyleSheets 或 <style> 注入。
 * host 默认 pointer-events: none，直接子节点默认 auto。
 */

import type { Disposer } from './disposer';

export interface MountedShadowRoot {
  host: HTMLElement;
  root: ShadowRoot;
  mountStyle(css: string, id: string): Disposer;
  dispose(): void;
}

let shadowCount = 0;

export function mountShadowRoot(id: string, options?: { zIndex?: number }): MountedShadowRoot {
  shadowCount += 1;
  const host = document.createElement('div');
  host.className = `studio-shadow-host studio-shadow-host-${id}`;
  host.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 100%',
    'height: 100%',
    'pointer-events: none',
    `z-index: ${options?.zIndex ?? 20}`,
  ].join('; ');

  const root = host.attachShadow({ mode: 'open' });

  // :host > * 默认 pointer-events: auto
  const baseStyle = document.createElement('style');
  baseStyle.textContent = `
    :host { all: initial; }
    :host > * { pointer-events: auto; }
  `;
  root.appendChild(baseStyle);

  document.body.appendChild(host);

  const styleDisposers = new Map<string, Disposer>();

  function mountStyle(css: string, styleId: string): Disposer {
    // 如果已有同 id 样式，先移除
    const existing = styleDisposers.get(styleId);
    if (existing) { existing(); styleDisposers.delete(styleId); }

    const el = document.createElement('style');
    el.dataset.styleId = styleId;
    el.textContent = css;
    root.appendChild(el);

    const disposer: Disposer = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
      styleDisposers.delete(styleId);
    };
    styleDisposers.set(styleId, disposer);
    return disposer;
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const [, d] of styleDisposers) { try { d(); } catch { /* ignore */ } }
    styleDisposers.clear();
    if (host.parentNode) host.parentNode.removeChild(host);
  }

  return { host, root, mountStyle, dispose };
}
