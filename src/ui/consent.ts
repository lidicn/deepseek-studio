/**
 * 页侧同意模态（v0.3.2）
 *
 * 非侵入式浮层：半透明遮罩 + 居中圆角卡片，展示工具名与脱敏参数摘要，提供三个动作：
 *   允许一次 / 拒绝 / 本次会话允许。
 * fail-closed：点遮罩外、Esc、或超时（默认 60s）→ 视为 deny。
 * 样式内联注入（适配注入式 IIFE，不依赖外部 css 文件）；明暗跟随系统。
 */

import { POLICY_MODE_LABELS, isPolicyMode } from '../shared/policy-contract';
import type { ConsentDecision as _CD, ConsentMeta as _CM } from '../shared/consent-contract';

// A5：单一真源在 shared/consent-contract.ts；这里 re-export 保持旧 import 路径不破。
export type ConsentDecision = _CD;
export type ConsentMeta = _CM;

export interface ConsentRequest {
  tool: string;
  /** 工具参数（用于呈现脱敏摘要），不显示完整文本。 */
  params?: unknown;
  /** 超时（毫秒）后默认拒绝，默认 60000。 */
  timeoutMs?: number;
  /** 风险呈现信息（由宿主翻译成展示字符串后下发，本模块不做枚举翻译）。 */
  meta?: ConsentMeta;
}

export type ConsentCallback = (decision: ConsentDecision) => void;

export interface ConsentHandle {
  decide(decision: ConsentDecision): void;
  dispose(): void;
}

interface ConsentPresentation {
  title: string;
  headline: string;
  summary: string;
  allowOnceLabel: string;
  allowSessionLabel: string;
}

const STYLE_ID = 'ds-consent-style';

// 审批请求串行展示：同一时刻只保留一个模态，后来者排队，不能把正在等待的请求判拒绝。
interface QueuedConsent {
  readonly request: ConsentRequest;
  readonly onDecision: ConsentCallback;
  settled: boolean;
  shown: boolean;
  overlay?: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
  removeListeners?: () => void;
}

let activeConsent: QueuedConsent | undefined;
const pendingConsents: QueuedConsent[] = [];

const CSS = `
.ds-consent-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
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
.ds-consent-allow-conversation { background: rgba(77,107,254,0.12); color: #4D6BFE; }
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

/** 把审批请求排入队列；只有队首会渲染。fail-closed 由超时与遮罩/Esc 兜底。 */
export function showConsent(request: ConsentRequest, onDecision: ConsentCallback): ConsentHandle {
  const entry: QueuedConsent = { request, onDecision, settled: false, shown: false };
  pendingConsents.push(entry);
  presentNextConsent();

  return {
    decide(decision) {
      settleConsent(entry, decision);
    },
    dispose() {
      if (entry.settled) return;
      entry.settled = true;
      if (!entry.shown) {
        const index = pendingConsents.indexOf(entry);
        if (index >= 0) pendingConsents.splice(index, 1);
        return;
      }
      cleanupConsent(entry);
      if (activeConsent === entry) {
        activeConsent = undefined;
        presentNextConsent();
      }
    },
  };
}

function presentNextConsent(): void {
  if (activeConsent) return;
  const next = pendingConsents.shift();
  if (!next || next.settled) {
    if (next) presentNextConsent();
    return;
  }
  activeConsent = next;
  next.shown = true;
  renderConsent(next);
}

function settleConsent(entry: QueuedConsent, decision: ConsentDecision): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.shown) cleanupConsent(entry);
  else {
    const index = pendingConsents.indexOf(entry);
    if (index >= 0) pendingConsents.splice(index, 1);
  }
  if (activeConsent === entry) {
    activeConsent = undefined;
  }
  try {
    entry.onDecision(decision);
  } catch (error) {
    // 单个回调异常不能卡死队列；错误仍留给控制台便于定位。
    console.error('[consent] decision callback failed', error);
  } finally {
    presentNextConsent();
  }
}

function cleanupConsent(entry: QueuedConsent): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.overlay?.remove();
  entry.overlay = undefined;
  entry.removeListeners?.();
  entry.removeListeners = undefined;
}

function renderConsent(entry: QueuedConsent): void {
  const { request } = entry;
  const doc = globalThis.document;
  const timeoutMs = request.timeoutMs ?? 60_000;

  ensureStyles();
  const overlay = doc.createElement('div');
  overlay.className = 'ds-consent-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const card = doc.createElement('div');
  card.className = 'ds-consent-card';

  const title = doc.createElement('div');
  title.className = 'ds-consent-title';
  const presentation = describeConsentRequest(request);
  title.textContent = presentation.title;

  const tool = doc.createElement('div');
  tool.className = 'ds-consent-tool';
  tool.textContent = presentation.headline;

  const badges = buildBadges(request.meta);

  const summary = doc.createElement('div');
  summary.className = 'ds-consent-summary';
  summary.textContent = presentation.summary;

  // T4（2026-10-27 E-01）：审批弹窗作用域 + 时长副文案，让用户一眼看懂
  // 「允许一次」与「本会话允许」的区别，以及 hideAllowSession=true 时为何只有前者。
  const meta = request.meta;
  const scopeHint = doc.createElement('div');
  scopeHint.className = 'ds-consent-scope-hint';
  // 注意：scopeHint 只放自然语言显示名，原始协议名（request.tool）只进 trace/日志。
  const toolLabel = describeConsentRequest(request).headline;
  const classLabel = meta?.approvalClass === 'always' ? '高风险（始终审批）'
    : meta?.approvalClass === 'hard-deny' ? '硬拒绝'
    : meta?.approvalClass === 'mode' ? '按档位'
    : meta?.approvalClass === 'none' ? '免审批'
    : meta?.approvalClass ? meta.approvalClass : '';
  const targetLabel = meta?.canonicalTarget ? `目标：${meta.canonicalTarget}` : '';
  const scopeParts = [toolLabel, classLabel, targetLabel].filter(Boolean);
  if (scopeParts.length > 0) {
    scopeHint.textContent = scopeParts.join(' · ');
  }

  const actions = doc.createElement('div');
  actions.className = 'ds-consent-actions';

  const btnAllowOnce = mkButton(presentation.allowOnceLabel, 'ds-consent-allow-once');
  const btnDeny = mkButton('拒绝', 'ds-consent-deny');
  const btnAllowSession = mkButton(presentation.allowSessionLabel, 'ds-consent-allow-session');
  // A5：动态按钮——meta.hideAllowSession 为 true 时不渲染「本次会话允许」。
  if (meta?.hideAllowSession) {
    actions.append(btnAllowOnce, btnDeny);
  } else {
    actions.append(btnAllowOnce, btnDeny, btnAllowSession);
  }
  // 「本次对话始终允许」：宿主确认本次调用带对话身份时下发。
  // 点了它 → 本对话内后续调用不再逐次询问；换对话 / 换工作区 / 换档位自动失效。
  let btnAllowConversation: HTMLButtonElement | undefined;
  if (meta?.allowConversation === true) {
    btnAllowConversation = mkButton('本次对话始终允许', 'ds-consent-allow-conversation');
    actions.append(btnAllowConversation);
  }
  // T4：hideAllowSession=true 时追加说明——该工具属 always 类，会话级 grant 会绕过逐次确认。
  const sessionHint = doc.createElement('div');
  sessionHint.className = 'ds-consent-session-hint';
  if (meta?.hideAllowSession) {
    const reasonForNoSession = meta.approvalClass === 'always'
      ? '此操作属高风险类，本会话放行将绕过后续逐次确认，因此仅提供「允许一次」。'
      : '此操作不支持会话级放行，仅提供「允许一次」。';
    sessionHint.textContent = reasonForNoSession;
  }

  card.append(title, tool, ...(badges ? [badges] : []), summary,
    ...(scopeParts.length > 0 ? [scopeHint] : []),
    actions,
    ...(meta?.hideAllowSession ? [sessionHint] : []));
  overlay.append(card);
  doc.body.append(overlay);
  entry.overlay = overlay;

  function settle(decision: ConsentDecision): void {
    settleConsent(entry, decision);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') settle('deny');
    else if (e.key === 'Enter') settle('allow-once');
  }

  btnAllowOnce.addEventListener('click', () => settle('allow-once'));
  btnDeny.addEventListener('click', () => settle('deny'));
  btnAllowSession.addEventListener('click', () => settle('allow-session'));
  btnAllowConversation?.addEventListener('click', () => settle('allow-conversation'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) settle('deny');
  });
  doc.addEventListener('keydown', onKey);
  entry.removeListeners = () => doc.removeEventListener('keydown', onKey);

  // 超时从真正展示时开始计时；排队时间不消耗用户决策时间。
  entry.timer = setTimeout(() => settle('deny'), timeoutMs);
}

/** 仅供测试：清空队列与活动模态，不触发回调。 */
export function __resetConsentQueueForTests(): void {
  if (activeConsent) {
    activeConsent.settled = true;
    cleanupConsent(activeConsent);
  }
  for (const entry of pendingConsents) entry.settled = true;
  pendingConsents.length = 0;
  activeConsent = undefined;
}

/**
 * 协议级工具名 → 用户可见的自然语言操作名。
 * 未知工具不得把原始协议名直接展示给用户——原始名只进 trace/日志。
 */
const TOOL_DISPLAY_MAP: Record<string, string> = {
  'policy.set': '修改审批档位',
  'workspace.set': '修改工作区',
  'shell.exec': '执行终端命令',
  'file.read': '读取文件',
  'file.write': '写入文件',
  'file.edit': '编辑文件',
  'search_files': '搜索文件',
  'search_code': '搜索代码',
  'chat-send': '发送对话',
  'chat-read': '读取对话',
  'memory.select': '查询记忆',
  'memory.save': '保存记忆',
  'memory.delete': '失效记忆',
  // C1-UX1：补齐真实触达的记忆工具名，让审批弹窗不再裸奔原始协议名。
  'memory.unarchive': '恢复已归档记忆',
  'memory.purge': '永久删除记忆',
  'memory.listArchived': '查看已归档记忆',
};

function toolDisplayName(tool: string): string {
  return TOOL_DISPLAY_MAP[tool] ?? '该操作';
}

/** 把协议级工具名和参数翻译成用户能直接判断后果的文案。 */
export function describeConsentRequest(request: ConsentRequest): ConsentPresentation {
  if (request.tool === 'policy.set') {
    const rawMode = (request.params as { mode?: unknown } | undefined)?.mode;
    const modeLabel = isPolicyMode(rawMode) ? POLICY_MODE_LABELS[rawMode] : '所选档位';
    return {
      title: 'Studio 请求修改审批档位',
      headline: `将审批档位改为「${modeLabel}」`,
      summary: rawMode === 'full'
        ? '允许后，后续工具将按"完全放开"执行，普通操作可能不再逐次向你确认。请确认你了解这项变更的影响。'
        : `允许后，后续工具将按"${modeLabel}"档位执行。该设置会改变工具执行前的确认强度。`,
      allowOnceLabel: '允许本次修改',
      allowSessionLabel: '本次会话允许修改',
    };
  }

  if (request.tool === 'workspace.set') {
    const root = (request.params as { root?: unknown } | undefined)?.root;
    const shownRoot = typeof root === 'string' && root ? root : '所选目录';
    return {
      title: 'Studio 请求修改工作区',
      headline: '将工具工作区切换到新目录',
      summary: `允许后，文件与命令操作将以「${shownRoot}」作为可信根目录。`,
      allowOnceLabel: '允许本次修改',
      allowSessionLabel: '本次会话允许修改',
    };
  }

  // C1-UX1：高风险记忆操作定制弹窗文案——让用户明确知道"操作对象、后果、是否可恢复"。
  if (request.tool === 'memory.purge') {
    return {
      title: '永久删除记忆（不可恢复）',
      headline: '彻底删除一条记忆',
      summary: '此操作会永久删除选中的记忆条目，不可撤销。确认前请仔细核对。',
      allowOnceLabel: '确认永久删除',
      allowSessionLabel: '本次会话允许永久删除',
    };
  }

  if (request.tool === 'memory.unarchive') {
    return {
      title: '恢复已归档记忆',
      headline: '将一条归档记忆恢复为有效状态',
      summary: '允许后，该记忆将重新出现在有效列表中，可被查询和注入提示词。',
      allowOnceLabel: '允许恢复',
      allowSessionLabel: '本次会话允许恢复',
    };
  }

  if (request.tool === 'memory.listArchived') {
    return {
      title: '查看已归档记忆',
      headline: '请求列出已归档的记忆条目',
      summary: '此操作只读，不会修改任何记忆数据。',
      allowOnceLabel: '允许查看',
      allowSessionLabel: '本次会话允许查看',
    };
  }

  const displayName = toolDisplayName(request.tool);
  return {
    title: 'DeepSeek++ Studio 请求执行工具',
    headline: displayName,
    summary: summarizeParams(request.params),
    allowOnceLabel: '允许一次',
    allowSessionLabel: '本次会话允许',
  };
}

/** 导出供测试验证与宿主 trace 使用。宿主日志仍可直接读 request.tool 原始名。 */
export { toolDisplayName };
export function getRawToolName(request: ConsentRequest): string { return request.tool; }

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
