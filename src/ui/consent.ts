/**
 * 页侧同意模态（v0.3.2）
 *
 * 非侵入式浮层：半透明遮罩 + 居中圆角卡片，展示工具名与脱敏参数摘要，提供三个动作：
 *   允许一次 / 拒绝 / 本次会话允许。
 * fail-closed：点遮罩外、Esc、或超时（默认 60s）→ 视为 deny。
 * 样式内联注入（适配注入式 IIFE，不依赖外部 css 文件）；明暗跟随系统。
 */

export type ConsentDecision = 'allow-once' | 'deny' | 'allow-session';

export interface ConsentRequest {
  tool: string;
  /** 工具参数（用于呈现脱敏摘要），不显示完整文本。 */
  params?: unknown;
  /** 超时（毫秒）后默认拒绝，默认 60000。 */
  timeoutMs?: number;
  /** 风险呈现信息（由宿主翻译成展示字符串后下发，本模块不做枚举翻译）。 */
  meta?: ConsentMeta;
}

export interface ConsentMeta {
  riskLabel?: string;
  modeLabel?: string;
  riskFlagLabels?: readonly string[];
  outside?: boolean;
}

export type ConsentCallback = (decision: ConsentDecision) => void;

export interface ConsentHandle {
  decide(decision: ConsentDecision): void;
  dispose(): void;
}

const STYLE_ID = 'ds-consent-style';

const CSS = `
.ds-consent-overlay {
  position: fixed; inset: 0; z-index: 2147483646;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(2px);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  animation: ds-consent-fade 120ms ease-out;
}
.ds-consent-card {
  min-width: 300px; max-width: 420px; padding: 20px 22px;
  border-radius: 16px; background: rgba(255,255,255,0.92);
  box-shadow: 0 12px 40px rgba(20,30,60,0.25);
  border: 1px solid rgba(77,107,254,0.18);
  color: #1F2329; animation: ds-consent-pop 120ms ease-out;
}
@media (prefers-color-scheme: dark) {
  .ds-consent-card { background: rgba(30,31,35,0.94); color: #E8EAED; border-color: rgba(77,107,254,0.35); }
}
.ds-consent-title { font-size: 13px; font-weight: 500; opacity: 0.7; }
.ds-consent-tool {
  margin-top: 8px; font-size: 15px; font-weight: 600; color: #4D6BFE;
}
@media (prefers-color-scheme: dark) { .ds-consent-tool { color: #6E8BFF; } }
.ds-consent-summary {
  margin-top: 10px; font-size: 13px; line-height: 1.5; opacity: 0.85;
  max-height: 140px; overflow: auto; word-break: break-all;
}
.ds-consent-badges { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.ds-consent-badge {
  font-size: 11px; line-height: 1.4; padding: 2px 8px; border-radius: 999px;
  background: rgba(77,107,254,0.12); color: #4D6BFE; border: 1px solid rgba(77,107,254,0.25);
}
.ds-consent-badge[data-level="danger"] {
  background: rgba(212,56,13,0.12); color: #D4380D; border-color: rgba(212,56,13,0.3);
}
.ds-consent-badge[data-level="warn"] {
  background: rgba(212,138,13,0.14); color: #B26A00; border-color: rgba(212,138,13,0.3);
}
@media (prefers-color-scheme: dark) {
  .ds-consent-badge[data-level="danger"] { color: #FF7A5C; }
  .ds-consent-badge[data-level="warn"] { color: #E8A33D; }
}
.ds-consent-actions { margin-top: 18px; display: flex; gap: 10px; justify-content: flex-end; }
.ds-consent-actions button {
  border: none; border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 500;
  cursor: pointer; transition: transform 80ms ease, filter 80ms ease;
}
.ds-consent-actions button:hover { filter: brightness(1.05); }
.ds-consent-actions button:active { transform: scale(0.97); }
.ds-consent-deny { background: rgba(212,56,13,0.12); color: #D4380D; }
.ds-consent-allow-once { background: #4D6BFE; color: #fff; }
.ds-consent-allow-session { background: rgba(43,164,113,0.14); color: #2BA471; }
@keyframes ds-consent-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ds-consent-pop { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;

function ensureStyles(): void {
  if (globalThis.document.getElementById(STYLE_ID)) return;
  const style = globalThis.document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  globalThis.document.head.appendChild(style);
}

/** 渲染模态并注册决策回调；返回 handle（decide/dispose）。fail-closed 由超时与遮罩/Esc 兜底。 */
export function showConsent(request: ConsentRequest, onDecision: ConsentCallback): ConsentHandle {
  const doc = globalThis.document;
  const timeoutMs = request.timeoutMs ?? 60_000;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  ensureStyles();
  const overlay = doc.createElement('div');
  overlay.className = 'ds-consent-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const card = doc.createElement('div');
  card.className = 'ds-consent-card';

  const title = doc.createElement('div');
  title.className = 'ds-consent-title';
  title.textContent = 'DeepSeek++ Studio 请求执行工具';

  const tool = doc.createElement('div');
  tool.className = 'ds-consent-tool';
  tool.textContent = request.tool;

  const badges = buildBadges(request.meta);

  const summary = doc.createElement('div');
  summary.className = 'ds-consent-summary';
  summary.textContent = summarizeParams(request.params);

  const actions = doc.createElement('div');
  actions.className = 'ds-consent-actions';

  const btnAllowOnce = mkButton('允许一次', 'ds-consent-allow-once');
  const btnDeny = mkButton('拒绝', 'ds-consent-deny');
  const btnAllowSession = mkButton('本次会话允许', 'ds-consent-allow-session');

  actions.append(btnAllowOnce, btnDeny, btnAllowSession);
  card.append(title, tool, ...(badges ? [badges] : []), summary, actions);
  overlay.append(card);
  doc.body.append(overlay);

  function settle(decision: ConsentDecision): void {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    overlay.remove();
    doc.removeEventListener('keydown', onKey);
    onDecision(decision);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') settle('deny');
    else if (e.key === 'Enter') settle('allow-once');
  }

  btnAllowOnce.addEventListener('click', () => settle('allow-once'));
  btnDeny.addEventListener('click', () => settle('deny'));
  btnAllowSession.addEventListener('click', () => settle('allow-session'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) settle('deny');
  });
  doc.addEventListener('keydown', onKey);

  timer = setTimeout(() => settle('deny'), timeoutMs);

  return {
    decide: settle,
    dispose() {
      if (timer) clearTimeout(timer);
      overlay.remove();
      doc.removeEventListener('keydown', onKey);
    },
  };
}

/**
 * 组装风险徽标行。用户看到的信息必须能回答三个问题：
 * 「这是什么等级」「为什么需要我批准」「是否触碰工作区之外」。
 */
function buildBadges(meta: ConsentMeta | undefined): HTMLElement | null {
  if (!meta) return null;
  const items: { text: string; level: 'info' | 'warn' | 'danger' }[] = [];
  if (meta.riskLabel) items.push({ text: meta.riskLabel, level: 'danger' });
  if (meta.modeLabel) items.push({ text: meta.modeLabel, level: 'info' });
  if (meta.outside) items.push({ text: '工作区外', level: 'warn' });
  for (const flag of meta.riskFlagLabels ?? []) items.push({ text: flag, level: 'danger' });
  if (items.length === 0) return null;

  const doc = globalThis.document;
  const wrap = doc.createElement('div');
  wrap.className = 'ds-consent-badges';
  for (const it of items) {
    const b = doc.createElement('span');
    b.className = 'ds-consent-badge';
    b.dataset.level = it.level;
    b.textContent = it.text;
    wrap.append(b);
  }
  return wrap;
}

function mkButton(label: string, cls: string): HTMLButtonElement {
  const b = globalThis.document.createElement('button');
  b.className = cls;
  b.textContent = label;
  return b;
}

/** 参数脱敏摘要：仅顶层键与截断值，不泄露完整文本（防敏感内容出现在 UI）。 */
function summarizeParams(params: unknown): string {
  if (params == null) return '（无参数）';
  if (typeof params !== 'object') return String(params).slice(0, 64);
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length === 0) return '（无参数）';
  return entries
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const shown = s.length > 32 ? `${s.slice(0, 32)}…` : s;
      return `${k}: ${shown}`;
    })
    .join('；');
}
