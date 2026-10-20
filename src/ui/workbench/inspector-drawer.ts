/**
 * 窄屏（<1200px）Inspector 抽屉开关：只切 `.open` class 与 aria 属性，不改变布局宽度。
 *
 * 宽屏右栏常驻显示，开关按钮由 CSS（@media max-width:1199px）控制可见性，
 * 本模块不做断点判断、不读 window.innerWidth。
 */

export interface InspectorDrawerControl {
  /** 当前是否展开。 */
  readonly open: boolean;
  setOpen(open: boolean): void;
  /** 切换并返回切换后的状态。 */
  toggle(): boolean;
}

export interface InspectorDrawerOptions {
  /** 抽屉容器（.inspector-drawer），切换其 .open 与 aria-hidden。 */
  drawer: HTMLElement;
  /** 触发按钮，同步 aria-expanded。 */
  toggleButton: HTMLElement;
  /** 可选关闭按钮，点击收起。 */
  closeButton?: HTMLElement | null;
}

export function mountInspectorDrawer(options: InspectorDrawerOptions): InspectorDrawerControl {
  const { drawer, toggleButton, closeButton } = options;
  let open = false;

  const apply = (next: boolean): void => {
    open = next;
    drawer.classList.toggle('open', next);
    drawer.setAttribute('aria-hidden', String(!next));
    toggleButton.setAttribute('aria-expanded', String(next));
  };

  toggleButton.setAttribute('aria-controls', drawer.id || 'inspector-drawer');
  toggleButton.addEventListener('click', () => apply(!open));
  closeButton?.addEventListener('click', () => apply(false));
  apply(false);

  return {
    get open() {
      return open;
    },
    setOpen: apply,
    toggle: () => {
      apply(!open);
      return open;
    },
  };
}
