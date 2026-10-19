/**
 * Workbench 应用组装：应用主题 → 挂载三栏壳 → 同步响应式断点。
 * WebSocket 连接由 workbench-ws 独立提供，本模块不重复建连。
 */
import { applyWorkbenchTheme } from './workbench-theme';
import { mountWorkbenchShell, type WorkbenchHandle } from './workbench-shell';

export interface WorkbenchAppHandle extends WorkbenchHandle {
  destroy(): void;
}

export interface StartWorkbenchOptions {
  theme?: 'light' | 'dark';
  container?: HTMLElement;
}

export function startWorkbench(options: StartWorkbenchOptions = {}): WorkbenchAppHandle {
  applyWorkbenchTheme(options.theme ?? 'light');
  const shell = mountWorkbenchShell(options.container);

  const syncLayout = () => shell.setLayout(window.innerWidth);
  syncLayout();
  window.addEventListener('resize', syncLayout);

  return {
    ...shell,
    destroy() {
      window.removeEventListener('resize', syncLayout);
      shell.dispose();
    },
  };
}
