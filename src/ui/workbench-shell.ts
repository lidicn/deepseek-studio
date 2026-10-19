/**
 * Workbench 三栏壳（Light DOM，不进 Shadow DOM）
 *
 * 左栏：会话/任务列表（320px）
 * 中栏：对话流（自适应）
 * 右栏：工具运行状态/产物（360px）
 *
 * 窄屏（< 900px）：右栏自动隐藏
 *
 * 注意：Workbench 是 Tauri 主窗口内容，走 light DOM，不挂 Shadow Root。
 * Shadow DOM 只用于浮层/overlay（Focus 模式、对话框等）。
 */

import { emptyState } from './primitives/empty-state';

export interface WorkbenchHandle {
  dispose(): void;
  getLeftPane(): HTMLElement;
  getCenterPane(): HTMLElement;
  getRightPane(): HTMLElement;
}

const WORKBENCH_ID = 'studio-workbench-root';

const WORKBENCH_CSS = `
  #${WORKBENCH_ID} {
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    display: flex;
    background: var(--studio-bg-page, #F7F8FA);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  #${WORKBENCH_ID} .left {
    width: 320px;
    min-width: 240px;
    background: var(--studio-bg-panel, #fff);
    border-right: 1px solid var(--studio-border, #eee);
    display: flex;
    flex-direction: column;
  }
  #${WORKBENCH_ID} .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #${WORKBENCH_ID} .right {
    width: 360px;
    min-width: 280px;
    background: var(--studio-bg-panel, #fff);
    border-left: 1px solid var(--studio-border, #eee);
    display: flex;
    flex-direction: column;
  }
  #${WORKBENCH_ID} .pane-header {
    padding: 12px 16px;
    font-size: 12px;
    font-weight: 600;
    color: var(--studio-text-secondary, #5B6170);
    border-bottom: 1px solid var(--studio-border, #eee);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  #${WORKBENCH_ID} .pane-body {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  @media (max-width: 900px) {
    #${WORKBENCH_ID} .right { display: none; }
  }
`;

function injectCss(): void {
  if (document.getElementById('studio-workbench-css')) return;
  const style = document.createElement('style');
  style.id = 'studio-workbench-css';
  style.textContent = WORKBENCH_CSS;
  document.head.appendChild(style);
}

export function createWorkbench(): WorkbenchHandle {
  injectCss();

  // 移除已有实例
  const existing = document.getElementById(WORKBENCH_ID);
  if (existing) existing.remove();

  const shell = document.createElement('div');
  shell.id = WORKBENCH_ID;

  // 左栏
  const left = document.createElement('div');
  left.className = 'left';
  const leftHeader = document.createElement('div');
  leftHeader.className = 'pane-header';
  leftHeader.textContent = '会话';
  const leftBody = document.createElement('div');
  leftBody.className = 'pane-body';
  leftBody.appendChild(emptyState('暂无会话', '开始对话后自动创建'));
  left.appendChild(leftHeader);
  left.appendChild(leftBody);

  // 中栏
  const center = document.createElement('div');
  center.className = 'center';
  const centerHeader = document.createElement('div');
  centerHeader.className = 'pane-header';
  centerHeader.textContent = '对话';
  const centerBody = document.createElement('div');
  centerBody.className = 'pane-body';
  centerBody.appendChild(emptyState('开始新对话', '在下方输入框发送第一条消息'));
  center.appendChild(centerHeader);
  center.appendChild(centerBody);

  // 右栏
  const right = document.createElement('div');
  right.className = 'right';
  const rightHeader = document.createElement('div');
  rightHeader.className = 'pane-header';
  rightHeader.textContent = '工具运行';
  const rightBody = document.createElement('div');
  rightBody.className = 'pane-body';
  rightBody.appendChild(emptyState('暂无工具运行', '执行工具后状态会显示在这里'));
  right.appendChild(rightHeader);
  right.appendChild(rightBody);

  shell.appendChild(left);
  shell.appendChild(center);
  shell.appendChild(right);
  document.body.appendChild(shell);

  return {
    dispose: () => {
      const el = document.getElementById(WORKBENCH_ID);
      if (el) el.remove();
    },
    getLeftPane: () => leftBody,
    getCenterPane: () => centerBody,
    getRightPane: () => rightBody,
  };
}
