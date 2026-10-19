/**
 * 宿主布局适配层
 *
 * 从原页面定位 composer / toolbar / sidebar，提供 L0/L1/L2 降级。
 * 组件不直接 querySelector，统一通过本模块获取快照。
 */

import type { Disposer, StudioDisposable } from './disposer';

export type LayoutDegradeLevel = 'L0' | 'L1' | 'L2';

export interface HostLayoutSnapshot {
  level: LayoutDegradeLevel;
  degradeReason: string | null;
  viewport: { width: number; height: number };
  composerRect: DOMRect | null;
  composerTop: number | null;
  sidebarRight: number;
  railLeft: number;
}

export interface HostLayoutAdapter extends StudioDisposable {
  getSnapshot(): HostLayoutSnapshot;
  getComposerMountPoint(): HTMLElement | null;
  observe(callback: (snapshot: HostLayoutSnapshot) => void): Disposer;
}

export function createHostLayoutAdapter(): HostLayoutAdapter {
  let disposed = false;
  const observers: ResizeObserver[] = [];
  const listeners: Array<[string, EventListener]> = [];

  function findComposer(): HTMLElement | null {
    const candidates = document.querySelectorAll<HTMLElement>(
      'textarea, [contenteditable="true"], [role="textbox"]'
    );
    const vh = window.innerHeight;
    let best: HTMLElement | null = null;
    let bestArea = 0;
    candidates.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top > vh * 0.5 && rect.height > 0) {
        const area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; best = el; }
      }
    });
    return best;
  }

  function findSidebarRight(): number {
    // 简单估算：找左侧固定面板
    const sidebar = document.querySelector<HTMLElement>(
      '[class*="sidebar"], [class*="side-bar"], [class*="nav-panel"]'
    );
    if (!sidebar) return 0;
    const rect = sidebar.getBoundingClientRect();
    return rect.right > 0 && rect.right < window.innerWidth * 0.3 ? rect.right : 0;
  }

  function getSnapshot(): HostLayoutSnapshot {
    if (disposed) {
      return {
        level: 'L2', degradeReason: 'disposed',
        viewport: { width: 0, height: 0 },
        composerRect: null, composerTop: null, sidebarRight: 0, railLeft: 12,
      };
    }

    const composer = findComposer();
    const sidebarRight = findSidebarRight();
    const viewport = { width: window.innerWidth, height: window.innerHeight };

    if (!composer) {
      return {
        level: 'L2', degradeReason: 'composer-not-found',
        viewport, composerRect: null, composerTop: null,
        sidebarRight, railLeft: 12,
      };
    }

    const rect = composer.getBoundingClientRect();
    const hasSidebar = sidebarRight > 0;

    return {
      level: hasSidebar ? 'L0' : 'L1',
      degradeReason: hasSidebar ? null : 'sidebar-not-found',
      viewport,
      composerRect: rect,
      composerTop: rect.top,
      sidebarRight,
      railLeft: hasSidebar ? sidebarRight + 8 : 12,
    };
  }

  function getComposerMountPoint(): HTMLElement | null {
    return findComposer();
  }

  function observe(callback: (snapshot: HostLayoutSnapshot) => void): Disposer {
    if (disposed) return () => {};
    const handler = () => callback(getSnapshot());
    window.addEventListener('resize', handler);
    listeners.push(['resize', handler as EventListener]);
    return () => {
      window.removeEventListener('resize', handler);
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observers.forEach((o) => o.disconnect());
    listeners.forEach(([type, fn]) => window.removeEventListener(type, fn));
  }

  return { getSnapshot, getComposerMountPoint, observe, dispose };
}
