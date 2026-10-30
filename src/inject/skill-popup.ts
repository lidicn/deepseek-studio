/**
 * 对话框输入 `/` 的技能提示弹窗（移植自 deepseek++ 的 src/core/ui/skill-popup.ts）。
 *
 * 为什么要有：Studio 已经有 skill.list 能力（src/host/desktop-host.ts），
 * 但用户在 DeepSeek 输入框里打 `/` 时看不到任何提示，只能凭记忆敲技能名。
 * 本模块把 dpp 的交互整套搬过来：候选过滤、上下键选择、Enter 写入、空列表提示。
 *
 * 与 dpp 的差异（有意为之）：
 *   - 类名/样式前缀 `ds-studio-*`（对齐 studio 注入层既有约定，如 ds-studio-tool-card）。
 *   - 样式不依赖 dpp 的 `--dpp-ui-*` 变量，改用 studio 自己的浅色配色 + 暗色媒体查询。
 *   - 诊断钩子改名 `__studioSkillPopup`。
 *
 * 关键实现点（照搬 dpp 的修复结论，不要退化）：
 *   - keydown / input 都挂在 document 捕获阶段：composer 被 React 重建也不必重绑。
 *   - input 用事件委托取当前 textarea，不依赖"记住的引用还活着"。
 *   - 写入值必须走原生 setter 并作废 React 的 _valueTracker，否则页面拿不到这次输入。
 *   - 定位前必须 isConnected 检查；空列表也要弹提示，否则用户完全看不到反馈。
 */

export interface SkillPopupItem {
  readonly name: string;
  readonly description: string;
}

export interface SkillPopupCopy {
  readonly hint: string;
  /** 技能列表为空时的提示（后台未就绪 / 一个技能都没存）。 */
  readonly emptyHint?: string;
}

const DEFAULT_COPY: SkillPopupCopy = {
  hint: '↑↓ Navigate · Enter Select · Esc Close',
  emptyHint: 'No saved skills yet — save one from the conversation first',
};

let popupEl: HTMLElement | null = null;
let skills: SkillPopupItem[] = [];
let filtered: SkillPopupItem[] = [];
let activeIdx = 0;
let textarea: HTMLTextAreaElement | null = null;
let copy: SkillPopupCopy = DEFAULT_COPY;
let textareaObserver: MutationObserver | null = null;

let initialized = false;
/** 空列表时也要弹（否则用户完全看不到反馈）。 */
let showingEmptyHint = false;

export function initSkillPopup(initialSkills: readonly SkillPopupItem[], nextCopy: Partial<SkillPopupCopy> = {}): void {
  skills = [...initialSkills];
  copy = { ...DEFAULT_COPY, ...nextCopy };
  if (isVisible()) buildItems();
  if (initialized) return;
  initialized = true;
  // 注入脚本在 document_start 执行，此时 document.head / document.body 可能还不存在。
  // 之前直接 appendChild 会抛 TypeError，被上层 catch 吃掉，导致整个浮层静默不安装。
  mountWhenDomReady();
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('input', onInputCapture, true);
  document.addEventListener('mousedown', onClickOutside);
  installDiag();
}

/** 尽早挂样式与输入框观察；DOM 未就绪时等到 DOMContentLoaded 再补一次。 */
function mountWhenDomReady(): void {
  const mount = (): void => {
    injectStyles();
    watchTextarea();
  };
  if (document.body) {
    mount();
    return;
  }
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      try {
        mount();
      } catch {
        // 诊断不能影响主流程；挂载失败下次输入仍会尝试定位输入框
      }
    },
    { once: true },
  );
}

/** 技能清单更新（面板里新增技能后）时热更新，不必重装。 */
export function setSkillPopupSkills(next: readonly SkillPopupItem[]): void {
  skills = [...next];
  if (!initialized) return;
  // 列表变了 → 现有过滤结果可能已过期，重新按当前输入算一次。
  handleInput(textarea);
}

export function stopSkillPopup(): void {
  if (!initialized) return;
  initialized = false;
  textareaObserver?.disconnect();
  textareaObserver = null;
  textarea = null;
  document.removeEventListener('keydown', onKeydown, true);
  document.removeEventListener('input', onInputCapture, true);
  document.removeEventListener('mousedown', onClickOutside);
  popupEl?.remove();
  popupEl = null;
  document.getElementById('ds-studio-skill-popup-css')?.remove();
  skills = [];
  filtered = [];
  activeIdx = 0;
  showingEmptyHint = false;
  copy = DEFAULT_COPY;
  removeDiag();
}

function watchTextarea(): void {
  tryAttach();
  textareaObserver?.disconnect();
  // 只用来"提前拿到一次引用"（定位弹窗用），不再是功能依赖。
  textareaObserver = new MutationObserver(() => {
    if (!textarea || !textarea.isConnected) tryAttach();
  });
  textareaObserver.observe(document.body, { childList: true, subtree: true });
}

function tryAttach(): void {
  const el = document.querySelector<HTMLTextAreaElement>('textarea#chat-input')
    || document.querySelector<HTMLTextAreaElement>('textarea');
  if (!el) return;
  textarea = el;
}

/** 事件委托：谁触发 input，谁就是当前 composer。 */
function onInputCapture(e: Event): void {
  const el = e.target;
  if (!(el instanceof HTMLTextAreaElement)) return;
  if (el.isConnected) textarea = el;
  handleInput(el);
}

function handleInput(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  textarea = el;
  const val = el.value;

  if (val.startsWith('/') && !val.slice(1).includes(' ')) {
    const query = val.slice(1).toLowerCase();
    filtered = query === ''
      ? [...skills]
      : skills.filter((s) => s.name.toLowerCase().startsWith(query));

    if (filtered.length === 0) {
      if (skills.length === 0) {
        // 空列表也要给反馈（后台未就绪 / 还没保存技能）
        showingEmptyHint = true;
        activeIdx = 0;
        showPopup();
      } else {
        hidePopup();
      }
      return;
    }

    showingEmptyHint = false;
    activeIdx = 0;
    showPopup();
    return;
  }
  hidePopup();
}

function onKeydown(e: KeyboardEvent): void {
  if (!isVisible()) return;
  if (showingEmptyHint) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      hidePopup();
    }
    return;
  }

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      e.stopImmediatePropagation();
      activeIdx = (activeIdx + 1) % filtered.length;
      highlightActive();
      break;
    case 'ArrowUp':
      e.preventDefault();
      e.stopImmediatePropagation();
      activeIdx = (activeIdx - 1 + filtered.length) % filtered.length;
      highlightActive();
      break;
    case 'Tab':
    case 'Enter':
      // Shift+Enter 放行：弹窗开着时用户仍能插入换行
      if (e.shiftKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      selectSkill(filtered[activeIdx]);
      break;
    case 'Escape':
      e.preventDefault();
      e.stopImmediatePropagation();
      hidePopup();
      break;
  }
}

function onClickOutside(e: MouseEvent): void {
  if (!isVisible()) return;
  if (popupEl?.contains(e.target as Node)) return;
  if (e.target === textarea) return;
  hidePopup();
}

function selectSkill(skill: SkillPopupItem | undefined): void {
  if (!textarea || !skill || !textarea.isConnected) return;

  const newVal = `/${skill.name} `;

  // 作废 React 的 value tracker，否则页面认为值没变，插入的技能名不会生效。
  const tracker = (textarea as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker;
  if (tracker) tracker.setValue('');

  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value',
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, newVal);
  } else {
    textarea.value = newVal;
  }

  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(newVal.length, newVal.length);
  hidePopup();
}

function showPopup(): void {
  // 游离节点 rect 全 0，会把弹窗画到屏幕外；先尝试重连，连不上就不弹。
  if (!textarea || !textarea.isConnected) {
    tryAttach();
    if (!textarea || !textarea.isConnected) return;
  }

  if (!popupEl) {
    popupEl = document.createElement('div');
    popupEl.className = 'ds-studio-skill-popup';
    popupEl.setAttribute('data-ds-studio-skill-popup', 'true');
    document.body.appendChild(popupEl);
  }

  const rect = textarea.getBoundingClientRect();
  Object.assign(popupEl.style, {
    display: 'block',
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`,
    bottom: `${Math.max(8, window.innerHeight - rect.top + 6)}px`,
    width: `${Math.min(Math.max(rect.width * 0.5, 200), 280)}px`,
  });

  buildItems();
}

function buildItems(): void {
  if (!popupEl) return;

  if (showingEmptyHint) {
    popupEl.innerHTML = `
      <div class="ds-studio-skill-empty">${escapeHtml(copy.emptyHint ?? '')}</div>
      <div class="ds-studio-skill-hint">${escapeHtml(copy.hint)}</div>
    `;
    return;
  }

  popupEl.innerHTML = filtered.map((s, i) => `
    <div class="ds-studio-skill-item${i === activeIdx ? ' ds-studio-active' : ''}" data-i="${i}">
      <div class="ds-studio-skill-head">
        <code class="ds-studio-skill-trigger">/${escapeHtml(s.name)}</code>
      </div>
      <div class="ds-studio-skill-desc">${escapeHtml(s.description)}</div>
    </div>
  `).join('')
    + `<div class="ds-studio-skill-hint">${escapeHtml(copy.hint)}</div>`;

  popupEl.querySelectorAll('.ds-studio-skill-item').forEach((el) => {
    const i = parseInt((el as HTMLElement).dataset.i || '0', 10);
    el.addEventListener('mouseenter', () => {
      activeIdx = i;
      highlightActive();
    });
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectSkill(filtered[i]);
    });
  });
}

function highlightActive(): void {
  if (!popupEl) return;
  popupEl.querySelectorAll('.ds-studio-skill-item').forEach((el, i) => {
    el.classList.toggle('ds-studio-active', i === activeIdx);
    if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function hidePopup(): void {
  if (popupEl) popupEl.style.display = 'none';
  showingEmptyHint = false;
}

function isVisible(): boolean {
  return popupEl !== null && popupEl.style.display !== 'none';
}

/** 控制台诊断钩子：window.__studioSkillPopup()。 */
function installDiag(): void {
  try {
    (window as unknown as Record<string, unknown>).__studioSkillPopup = () => {
      if (!textarea || !textarea.isConnected) tryAttach();
      return {
        initialized,
        hasCss: Boolean(document.getElementById('ds-studio-skill-popup-css')),
        skills: skills.length,
        skillNames: skills.map((s) => s.name),
        filtered: filtered.length,
        showingEmptyHint,
        visible: isVisible(),
        textareaConnected: Boolean(textarea?.isConnected),
        textareaValue: textarea?.isConnected ? textarea.value : null,
      };
    };
  } catch {
    // 诊断不能影响主流程
  }
}

function removeDiag(): void {
  try {
    delete (window as unknown as Record<string, unknown>).__studioSkillPopup;
  } catch {
    // ignore
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function injectStyles(): void {
  if (document.getElementById('ds-studio-skill-popup-css')) return;
  const style = document.createElement('style');
  style.id = 'ds-studio-skill-popup-css';
  style.textContent = `
.ds-studio-skill-popup {
  position: fixed;
  z-index: 99999;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 4px;
  box-shadow: 0 8px 28px rgba(17, 24, 39, 0.16);
  display: none;
  animation: ds-studio-slide-up .15s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif;
  backdrop-filter: blur(8px);
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior: contain;
  color: #111827;
}
@keyframes ds-studio-slide-up {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.ds-studio-skill-item {
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background .1s;
}
.ds-studio-skill-item.ds-studio-active {
  background: #f3f4f6;
}
.ds-studio-skill-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ds-studio-skill-trigger {
  color: #1d4ed8;
  font-size: 13px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-weight: 600;
  background: #eff6ff;
  padding: 1px 6px;
  border-radius: 4px;
}
.ds-studio-skill-desc {
  color: #6b7280;
  font-size: 11px;
  margin-top: 2px;
}
.ds-studio-skill-empty {
  padding: 10px 12px;
  color: #6b7280;
  font-size: 12px;
  text-align: center;
}
.ds-studio-skill-hint {
  text-align: center;
  color: #9ca3af;
  font-size: 10px;
  padding: 4px 0 2px;
  border-top: 1px solid #f3f4f6;
  margin-top: 4px;
}
@media (prefers-color-scheme: dark) {
  .ds-studio-skill-popup {
    background: #1f2937;
    border-color: #374151;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    color: #f3f4f6;
  }
  .ds-studio-skill-item.ds-studio-active { background: #374151; }
  .ds-studio-skill-trigger { color: #93c5fd; background: rgba(37, 99, 235, 0.18); }
  .ds-studio-skill-desc { color: #9ca3af; }
  .ds-studio-skill-empty { color: #9ca3af; }
  .ds-studio-skill-hint { color: #6b7280; border-top-color: #374151; }
}
`;
  document.head.appendChild(style);
}
