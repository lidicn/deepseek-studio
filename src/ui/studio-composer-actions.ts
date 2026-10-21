import { PANEL_POLICY_MODES, POLICY_MODE_LABELS, type PolicyMode } from '../shared/policy-contract';
import type { StudioControlsStore } from './studio-controls-store';
import { globalEvents, icon, Icons } from './studio-ui-core';

export type ComposerSettingsTab =
  | 'general'
  | 'workspace'
  | 'policy'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'diagnostics';

export interface ComposerActionAnchor {
  deepThink: HTMLElement;
  smartSearch: HTMLElement;
}

export interface ComposerActionsOptions {
  store: StudioControlsStore;
  openSettings(tab: ComposerSettingsTab): void;
  root?: Document;
  view?: Window;
}

export interface ComposerActionsHandle {
  container: HTMLElement;
  reposition(): void;
  destroy(): void;
}

const STYLE_ID = 'studio-composer-actions-styles';
const activeByDocument = new WeakMap<Document, ComposerActionsHandle>();
const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, '');

const styles = `
  .studio-composer-actions {
    position: fixed;
    z-index: 2147483638;
    display: none;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 4px;
    color: #5d6470;
    font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: auto;
    white-space: nowrap;
  }
  .studio-composer-actions.is-visible { display: inline-flex; }
  .studio-composer-actions-divider {
    width: 1px;
    height: 18px;
    margin: 0 3px;
    background: rgba(120, 128, 142, 0.26);
  }
  .studio-composer-action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    height: 28px;
    padding: 0 10px;
    border: 1px solid rgba(77, 107, 254, 0.2);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
    color: #536079;
    cursor: pointer;
    font: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .studio-composer-action:hover,
  .studio-composer-action[aria-expanded="true"] {
    border-color: rgba(77, 107, 254, 0.46);
    background: #eef1ff;
    color: #4059d6;
  }
  .studio-composer-action svg { flex: 0 0 auto; }
  .studio-composer-actions.is-compact .studio-composer-action {
    width: 28px;
    padding: 0;
    justify-content: center;
  }
  .studio-composer-actions.is-compact .studio-composer-action-label { display: none; }
  .studio-composer-policy {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 176px;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 12px 32px rgba(20, 27, 45, 0.18);
  }
  .studio-composer-policy[hidden] { display: none; }
  .studio-composer-policy-option {
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #333b4a;
    cursor: pointer;
    text-align: left;
    font: 500 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .studio-composer-policy-option:hover { background: #f1f4ff; }
  .studio-composer-policy-option[aria-checked="true"] { color: #4059d6; background: #edf1ff; }
  .studio-composer-policy-error {
    max-width: 210px;
    padding: 7px 8px 4px;
    color: #b42318;
    font-size: 11px;
    white-space: normal;
  }
  @media (prefers-color-scheme: dark) {
    .studio-composer-actions { color: #c8ceda; }
    .studio-composer-action {
      border-color: rgba(143, 160, 255, 0.26);
      background: rgba(32, 38, 52, 0.94);
      color: #d6dbea;
    }
    .studio-composer-action:hover,
    .studio-composer-action[aria-expanded="true"] {
      background: #2d3655;
      color: #fff;
    }
    .studio-composer-policy {
      border-color: rgba(255, 255, 255, 0.12);
      background: #202633;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
    }
    .studio-composer-policy-option { color: #e4e8f2; }
    .studio-composer-policy-option:hover { background: #2c3448; }
    .studio-composer-policy-option[aria-checked="true"] { color: #b8c5ff; background: #303a5c; }
  }
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = styles;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function findComposerActionAnchor(root: ParentNode = document): ComposerActionAnchor | null {
  // DeepSeek currently renders both toggles as div.ds-toggle-button[tabindex="0"],
  // while older builds used real buttons. Keep both shapes supported.
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('button,[role="button"],.ds-toggle-button,[tabindex="0"]'),
  );
  const findLast = (label: string): HTMLElement | null => {
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (normalize(candidates[i].textContent) === label) return candidates[i];
    }
    return null;
  };
  const deepThink = findLast('深度思考');
  const smartSearch = findLast('智能搜索');
  return deepThink && smartSearch ? { deepThink, smartSearch } : null;
}

function workspaceLabel(root: string | null): string {
  if (!root) return '工作区';
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? root;
}

function createActionButton(
  doc: Document,
  action: string,
  label: string,
  iconPath: string,
): { button: HTMLButtonElement; label: HTMLSpanElement } {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'studio-composer-action';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(icon(iconPath, 14));
  const text = doc.createElement('span');
  text.className = 'studio-composer-action-label';
  text.textContent = label;
  button.appendChild(text);
  return { button, label: text };
}

export function installComposerActions(options: ComposerActionsOptions): ComposerActionsHandle {
  const doc = options.root ?? document;
  const view = options.view ?? window;
  ensureStyles(doc);

  const container = doc.createElement('div');
  container.className = 'studio-composer-actions';
  container.setAttribute('role', 'toolbar');
  container.setAttribute('aria-label', 'Studio 快捷操作');

  const divider = doc.createElement('span');
  divider.className = 'studio-composer-actions-divider';
  divider.setAttribute('aria-hidden', 'true');
  container.appendChild(divider);

  const workspace = createActionButton(doc, 'workspace', '工作区', Icons.folder);
  const policy = createActionButton(doc, 'policy', POLICY_MODE_LABELS.auto, Icons.check);
  const skills = createActionButton(doc, 'skills', '技能', Icons.book);
  const settings = createActionButton(doc, 'settings', '设置', Icons.settings);
  policy.button.setAttribute('aria-haspopup', 'menu');
  policy.button.setAttribute('aria-expanded', 'false');
  container.append(workspace.button, policy.button, skills.button, settings.button);

  const policyMenu = doc.createElement('div');
  policyMenu.className = 'studio-composer-policy';
  policyMenu.setAttribute('role', 'menu');
  policyMenu.hidden = true;
  container.appendChild(policyMenu);

  const policyButtons = new Map<PolicyMode, HTMLButtonElement>();
  for (const mode of PANEL_POLICY_MODES) {
    const option = doc.createElement('button');
    option.type = 'button';
    option.className = 'studio-composer-policy-option';
    option.dataset.policy = mode;
    option.setAttribute('role', 'menuitemradio');
    option.textContent = POLICY_MODE_LABELS[mode];
    option.addEventListener('click', async (event) => {
      event.stopPropagation();
      const previous = options.store.getSnapshot().policyMode;
      const ok = await options.store.setPolicy(mode);
      if (ok) {
        closePolicyMenu();
        return;
      }
      render();
      const error = options.store.getSnapshot().error ?? '保存失败';
      const row = policyMenu.querySelector<HTMLElement>('.studio-composer-policy-error');
      if (row) row.textContent = `审批档位保存失败：${error}（仍为 ${POLICY_MODE_LABELS[previous]}）`;
    });
    policyButtons.set(mode, option);
    policyMenu.appendChild(option);
  }
  const policyError = doc.createElement('div');
  policyError.className = 'studio-composer-policy-error';
  policyError.hidden = true;
  policyMenu.appendChild(policyError);

  let visible = true;
  let missingAnchorWarned = false;
  let scheduled = 0;
  let observedAnchor: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let destroyed = false;

  function closePolicyMenu(): void {
    policyMenu.hidden = true;
    policy.button.setAttribute('aria-expanded', 'false');
    policyError.hidden = true;
    policyError.textContent = '';
  }

  function render(): void {
    const snapshot = options.store.getSnapshot();
    workspace.label.textContent = workspaceLabel(snapshot.workspaceRoot);
    workspace.button.title = snapshot.workspaceRoot ?? '选择工作区';
    policy.label.textContent = POLICY_MODE_LABELS[snapshot.policyMode];
    policy.button.title = `审批：${POLICY_MODE_LABELS[snapshot.policyMode]}`;
    policy.button.setAttribute('aria-label', policy.button.title);
    workspace.button.setAttribute('aria-busy', String(snapshot.loading));
    policy.button.setAttribute('aria-busy', String(snapshot.loading));
    for (const [mode, button] of policyButtons) {
      button.setAttribute('aria-checked', String(mode === snapshot.policyMode));
    }
    if (snapshot.error) {
      policyError.hidden = false;
      policyError.textContent = `宿主错误：${snapshot.error}`;
    }
  }

  function attachResizeObserver(anchor: HTMLElement | null): void {
    if (anchor === observedAnchor) return;
    resizeObserver?.disconnect();
    observedAnchor = anchor;
    if (!anchor || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(() => scheduleReposition());
    resizeObserver.observe(anchor);
  }

  function hide(): void {
    container.classList.remove('is-visible');
    closePolicyMenu();
  }

  function reposition(): void {
    if (destroyed) return;
    if (!visible) {
      hide();
      return;
    }
    const anchorState = findComposerActionAnchor(doc);
    attachResizeObserver(anchorState?.smartSearch ?? null);
    if (!anchorState) {
      hide();
      if (!missingAnchorWarned) {
        missingAnchorWarned = true;
        console.warn('[StudioUI] composer actions hidden: native 深度思考/智能搜索 anchor not found');
      }
      return;
    }

    const rect = anchorState.smartSearch.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || (rect.width <= 0 && rect.height <= 0)) {
      hide();
      return;
    }
    const viewportWidth = Number.isFinite(view.innerWidth) && view.innerWidth > 0
      ? view.innerWidth
      : 1024;
    const top = Math.max(6, rect.top + (rect.height - 30) / 2);
    const left = rect.right + 8;
    container.style.left = `${Math.round(left)}px`;
    container.style.top = `${Math.round(top)}px`;
    container.classList.add('is-visible');
    container.classList.remove('is-compact');

    const estimatedWidth = container.getBoundingClientRect().width || 236;
    if (left + estimatedWidth > viewportWidth - 12) {
      container.classList.add('is-compact');
    }
    const compactWidth = 132;
    const finalWidth = container.classList.contains('is-compact')
      ? (container.getBoundingClientRect().width || compactWidth)
      : estimatedWidth;
    if (left + finalWidth > viewportWidth - 8) {
      hide();
    }
  }

  function scheduleReposition(): void {
    if (scheduled !== 0) return;
    scheduled = view.setTimeout(() => {
      scheduled = 0;
      reposition();
    }, 40);
  }

  workspace.button.addEventListener('click', () => {
    closePolicyMenu();
    globalEvents.emit('ui:project-picker');
  });
  policy.button.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = policyMenu.hidden;
    policyMenu.hidden = !open;
    policyMenu.style.left = `${policy.button.offsetLeft}px`;
    policy.button.setAttribute('aria-expanded', String(open));
    if (open) void options.store.refresh();
  });
  skills.button.addEventListener('click', () => {
    closePolicyMenu();
    options.openSettings('skills');
  });
  settings.button.addEventListener('click', () => {
    closePolicyMenu();
    options.openSettings('general');
  });

  const onDocumentClick = (event: MouseEvent): void => {
    if (!container.contains(event.target as Node)) closePolicyMenu();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePolicyMenu();
  };
  const onVisibility = (event: Event): void => {
    const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
    if (typeof detail?.visible !== 'boolean') return;
    visible = detail.visible;
    if (visible) reposition();
    else hide();
  };

  doc.addEventListener('click', onDocumentClick, true);
  doc.addEventListener('keydown', onKeyDown, true);
  view.addEventListener('resize', scheduleReposition);
  view.addEventListener('scroll', scheduleReposition, true);
  view.addEventListener('studio:visibility-changed', onVisibility as EventListener);

  const observer = new MutationObserver(() => scheduleReposition());
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
  const unsubscribe = options.store.subscribe(render);
  const offWorkspaceChanged = globalEvents.on('ui:workspace-changed', () => {
    void options.store.refresh();
  });
  const offProjectSwitched = globalEvents.on('ui:project-switched', () => {
    void options.store.refresh();
  });
  render();
  if (doc.body) doc.body.appendChild(container);
  else doc.documentElement.appendChild(container);
  scheduleReposition();
  void options.store.refresh();

  const handle: ComposerActionsHandle = {
    container,
    reposition,
    destroy() {
      destroyed = true;
      observer.disconnect();
      resizeObserver?.disconnect();
      unsubscribe();
      offWorkspaceChanged();
      offProjectSwitched();
      doc.removeEventListener('click', onDocumentClick, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      view.removeEventListener('resize', scheduleReposition);
      view.removeEventListener('scroll', scheduleReposition, true);
      view.removeEventListener('studio:visibility-changed', onVisibility as EventListener);
      if (scheduled !== 0) view.clearTimeout(scheduled);
      container.remove();
      if (activeByDocument.get(doc) === handle) activeByDocument.delete(doc);
    },
  };
  activeByDocument.get(doc)?.destroy();
  activeByDocument.set(doc, handle);
  return handle;
}
