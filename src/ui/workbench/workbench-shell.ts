/**
 * Workbench 三栏壳（Light DOM，不进 Shadow DOM）—— 由孤儿 src/ui/workbench-shell.ts 迁入。
 *
 * 布局（§10.7）：顶栏 48px / 左 rail 56px / 左面板 272px / 右 Inspector 360px(≥1440)
 *   320px(1200–1439) / 状态条 28px / 中栏最小 520px。
 * 响应式（§10.7）：≥1440 三栏；1200–1439 右栏 320；<1200 右栏抽屉、左栏折叠为 rail；
 *   <900 显示桌面提示并隐藏主体。
 *
 * 样式来自全局 agent.css 与 --studio-* 变量，本模块不内联颜色、不进 Shadow。
 */
import { emptyState } from '../primitives/empty-state';
import { WORKBENCH_BREAKPOINTS } from '../ui-contract';
import type { WorkbenchLayout } from './workbench-types';

export interface WorkbenchHandle {
  dispose(): void;
  getLeftRail(): HTMLElement;
  getLeftPanel(): HTMLElement;
  getCenterCanvas(): HTMLElement;
  getRightInspector(): HTMLElement;
  getDrawer(): HTMLElement;
  /** 抽屉开关只切 class，不改变中栏最小宽度。 */
  toggleInspector(): void;
  setLayout(width: number): WorkbenchLayout;
}

const LAYOUT_ID = 'studio-workbench-root';
const HINT_ID = 'studio-desktop-hint';

/** §10.7 断点纯函数，便于无 DOM 单测。 */
export function layoutForWidth(width: number): WorkbenchLayout {
  if (width >= WORKBENCH_BREAKPOINTS.wide) return 'wide';
  if (width >= WORKBENCH_BREAKPOINTS.medium) return 'medium';
  if (width >= WORKBENCH_BREAKPOINTS.compact) return 'compact';
  return 'desktop-only';
}

/** <900 桌面提示（语义化，可被读屏读到）。show=false 时移除。 */
export function renderDesktopHint(parent: HTMLElement, show: boolean): void {
  const existing = parent.querySelector<HTMLElement>(`#${HINT_ID}`);
  if (!show) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const hint = document.createElement('p');
  hint.id = HINT_ID;
  hint.className = 'desktop-hint';
  hint.setAttribute('role', 'note');
  hint.textContent = '工作台请在桌面窗口使用（宽度需达到 900px）。';
  parent.appendChild(hint);
}

function ensure<T extends HTMLElement>(
  parent: HTMLElement,
  tag: string,
  className: string,
  id?: string,
): T {
  const selector = id ? `#${id}` : `.${className.split(' ')[0]}`;
  const found = parent.querySelector<T>(selector);
  if (found) return found;
  const el = document.createElement(tag) as T;
  el.className = className;
  if (id) el.id = id;
  parent.appendChild(el);
  return el;
}

export function mountWorkbenchShell(container?: HTMLElement): WorkbenchHandle {
  const root = container ?? document.body;

  // 移除旧实例（同 id），避免重复挂载。
  root.querySelector(`#${LAYOUT_ID}`)?.remove();

  const layout = ensure<HTMLElement>(root, 'main', 'workbench-layout', LAYOUT_ID);

  const leftRail = ensure<HTMLElement>(layout, 'aside', 'left-rail');
  const leftPanel = ensure<HTMLElement>(layout, 'section', 'left-panel');
  const centerCanvas = ensure<HTMLElement>(layout, 'section', 'center-canvas');
  const rightInspector = ensure<HTMLElement>(layout, 'aside', 'right-inspector');
  const drawer = ensure<HTMLElement>(layout, 'aside', 'inspector-drawer');

  // 空态：真实占位文案，不虚构会话/任务数据。
  if (!leftPanel.querySelector('.pane-body')) {
    const body = document.createElement('div');
    body.className = 'pane-body';
    body.appendChild(emptyState('暂无会话', '开始对话后自动创建'));
    leftPanel.appendChild(body);
  }
  if (!centerCanvas.querySelector('.pane-body')) {
    const body = document.createElement('div');
    body.className = 'pane-body canvas-body';
    body.appendChild(emptyState('开始新对话', '在下方输入框发送第一条消息'));
    centerCanvas.appendChild(body);
  }
  if (!rightInspector.querySelector('.pane-body')) {
    const body = document.createElement('div');
    body.className = 'pane-body inspector-body';
    body.appendChild(emptyState('暂无工具运行', '执行工具后状态会显示在这里'));
    rightInspector.appendChild(body);
  }

  let inspectorOpen = false;

  const handle: WorkbenchHandle = {
    dispose() {
      layout.remove();
      root.querySelector(`#${HINT_ID}`)?.remove();
    },
    getLeftRail: () => leftRail,
    getLeftPanel: () => leftPanel,
    getCenterCanvas: () => centerCanvas,
    getRightInspector: () => rightInspector,
    getDrawer: () => drawer,
    toggleInspector() {
      inspectorOpen = !inspectorOpen;
      layout.classList.toggle('inspector-open', inspectorOpen);
      drawer.classList.toggle('open', inspectorOpen);
    },
    setLayout(width: number) {
      const mode = layoutForWidth(width);
      layout.dataset.layout = mode;
      layout.classList.toggle('is-wide', mode === 'wide');
      layout.classList.toggle('is-medium', mode === 'medium');
      layout.classList.toggle('is-compact', mode === 'compact');
      layout.classList.toggle('is-desktop-only', mode === 'desktop-only');
      renderDesktopHint(root, mode === 'desktop-only');
      return mode;
    },
  };

  return handle;
}

