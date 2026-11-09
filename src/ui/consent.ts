/**
 * 页侧同意模态（v0.3.2）
 *
 * 非侵入式浮层：半透明遮罩 + 居中圆角卡片，展示工具名与脱敏参数摘要，提供动作：
 *   允许一次 / 拒绝 / 本次会话允许（always 类隐藏会话按钮）/ 本次对话始终允许（宿主
 *   确认有对话身份时）。
 * fail-closed：点遮罩外、Esc、Enter（2026-11-02 起键盘只通向拒绝）、或超时（默认 60s）
 * → 视为 deny；渲染失败同样立即 deny（卡 I：弹不出 ≠ 静默放行）。
 * 卡 I（2026-11-09）：高风险请求（meta 事实字段 outside/hardRule/riskFlags 命中）在本
 * 模态内呈现——危险外观（红边/红字）＋「高风险」徽标＋「风险原因」说明行＋档位与
 * 规范目标显形，按钮集为 允许一次 / 拒绝 / 本次对话始终允许；宿主原生框只作为
 * 页内模态不可用时的降级（降级与审计留痕在宿主侧）。
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
  /**
   * R2-01：本次同意请求的一次性 nonce（宿主生成、常数时间比对、消费即失效）。
   * 页端回执必须原样带回，宿主据此把决议绑到「这一次真实手势」上——防伪造回执。
   *
   * **缺失即不渲染**：R2-01 把工具分两档——低风险走页端模态（带 nonce），
   * 高风险（宿主 `isHighRiskConsent` 四条事实判据：outside / hardRule /
   * allowConversation / riskFlags）当前走宿主**原生框**，原生档**不会把
   * consent-required 发给页面**。因此页端若收到一个没有 nonce 的 consent-required，
   * 说明它本不该由页端处理（宿主已改走原生/正在原生降级中），此时**不渲染模态、
   * 也不回执**，把决定权完全交回宿主——避免页内脚本抢在原生框之前伪造决议。
   * （卡 I 之后宿主侧把高风险改走页内模态主路径、原生框只作降级时，此守卫仍是
   * 安全边界：无 nonce 一律不渲染，防竞态伪造。）
   */
  nonce?: string;
}

/**
 * R2-01：决议回执。`nonce` 是本次手势的一次性凭据（从 ConsentRequest 原样带回），
 * 宿主侧常数时间比对 + 一次性消费；无 nonce 的回执会被宿主忽略（保持 pending → 超时 deny）。
 */
export interface ConsentReceipt {
  decision: ConsentDecision;
  nonce?: string;
}

/** 决议回调：收到回执后由宿主客户端发 consent-decision（带 nonce）给宿主。 */
export type ConsentCallback = (receipt: ConsentReceipt) => void;

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

/**
 * 卡 I（2026-11-09）呈现层「高风险」判定：只认与宿主 `isHighRiskConsent` 同源的
 * 事实字段（outside / hardRule / riskFlags）。`allowConversation` 是放行能力、不是
 * 风险事实；`riskLabel` / `riskFlagLabels` 等展示字段同样不参与判定（#35 判据
 * 「只认事实字段」的呈现层镜像——判定本体仍在宿主，页端这里只决定「怎么画」）。
 */
export function isHighRiskPresentation(meta?: ConsentMeta): boolean {
  if (!meta) return false;
  if (meta.outside === true) return true;
  if (typeof meta.hardRule === 'string' && meta.hardRule !== '') return true;
  return (meta.riskFlags?.length ?? 0) > 0;
}

/**
 * 卡 I：「风险原因」说明行（原生框 `consentRiskReason` 的页端对应物）。
 * 纯展示层拼装：只用宿主已翻译好的 meta 字段（越出工作区 / 命中硬拒规则 /
 * riskLabel / riskFlagLabels，去重保序），不做任何判定。高风险请求拼装为空时
 * 兜底「高风险操作」，保证该行对高风险模态永不消失。
 */
export function describeRiskReason(meta?: ConsentMeta): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.outside === true) parts.push('越出工作区');
  if (typeof meta.hardRule === 'string' && meta.hardRule !== '') parts.push(`命中硬拒规则(${meta.hardRule})`);
  if (meta.riskLabel) parts.push(meta.riskLabel);
  for (const flag of meta.riskFlagLabels ?? []) parts.push(flag);
  const uniq = [...new Set(parts)];
  if (uniq.length === 0) return isHighRiskPresentation(meta) ? '高风险操作' : '';
  return uniq.join(' · ');
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
/* 卡 I：高风险徽标（与 danger 同色系，加粗以区分「等级提示」与「单项风险」） */
.ds-consent-badge[data-level="high-risk"] {
  background: rgba(212,56,13,0.14); color: #D4380D; border-color: rgba(212,56,13,0.35); font-weight: 600;
}
/* 卡 I：高风险卡片危险外观——沿用本模态同一套 DOM/视觉语言（圆角卡片/遮罩/动画），
   只把边框、投影、工具名颜色切到红色系，与「Studio 现有弹层」保持一体。 */
.ds-consent-card[data-risk="high"] {
  border-color: rgba(212,56,13,0.55); box-shadow: 0 12px 40px rgba(212,56,13,0.2);
}
.ds-consent-card[data-risk="high"] .ds-consent-tool { color: #D4380D; }
/* 卡 I：「风险原因」说明行（宿主原生框 riskReason 的页端对应物） */
.ds-consent-risk-reason {
  margin-top: 8px; font-size: 12px; line-height: 1.5; font-weight: 500; color: #D4380D;
}
@media (prefers-color-scheme: dark) {
  .ds-consent-badge[data-level="danger"] { color: #FF7A5C; }
  .ds-consent-badge[data-level="warn"] { color: #E8A33D; }
  .ds-consent-badge[data-level="high-risk"] { color: #FF7A5C; }
  .ds-consent-card[data-risk="high"] { border-color: rgba(255,122,92,0.5); box-shadow: 0 12px 40px rgba(212,56,13,0.25); }
  .ds-consent-card[data-risk="high"] .ds-consent-tool { color: #FF7A5C; }
  .ds-consent-risk-reason { color: #FF7A5C; }
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

/**
 * K3（2026-11-09）：导出页内模态的视觉 CSS（单一真源）。
 * 审批窗口（src/ui/consent-panel.ts）注入同一份样式、共用同一套类名——
 * 「复用卡 I 的视觉组件、不重写一套样式」的物理保证就在这里。
 */
export const CONSENT_MODAL_CSS = CSS;

function ensureStyles(): void {
  if (globalThis.document.getElementById(STYLE_ID)) return;
  const style = globalThis.document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  globalThis.document.head.appendChild(style);
}

/** 把审批请求排入队列；只有队首会渲染。fail-closed 由超时与遮罩/Esc 兜底。 */
export function showConsent(request: ConsentRequest, onDecision: ConsentCallback): ConsentHandle {
  // R2-01：无 nonce 的 consent-required 说明宿主已把该请求改走原生框（高风险档），
  // 或请求本不该由页端处理。此时**不渲染、不回执**，把决定权完全交回宿主，
  // 防止页内脚本抢在原生框之前伪造决议。返回的句柄是 no-op（不占队列、不触发回调）。
  if (!request.nonce) {
    return {
      decide() { /* no-op：页端不处理，宿主原生框已接管 */ },
      dispose() { /* no-op */ },
    };
  }
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
  try {
    renderConsent(next);
  } catch (error) {
    // 卡 I：页内模态渲染失败（页面损坏 / document 不可用）→ 不许留 pending、更不许静默放行：
    // 立即 deny（fail-closed）并把回执发回宿主。宿主侧的降级链（原生框）与审计留痕归宿主，
    // 页端这一侧的保证是「弹不出就拒绝」，与超时 / Esc / 点遮罩的 fail-closed 同口径。
    console.error('[consent] modal render failed → fail-closed deny', error);
    settleConsent(next, 'deny');
  }
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
    entry.onDecision({ decision, nonce: entry.request.nonce });
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

  // 卡 I：高风险请求切危险外观（同一套弹层语言内的红色系强调），并给徽标行补「高风险」chip
  const highRisk = isHighRiskPresentation(request.meta);
  if (highRisk) card.dataset.risk = 'high';
  const badges = buildBadges(request.meta, highRisk);

  const summary = doc.createElement('div');
  summary.className = 'ds-consent-summary';
  summary.textContent = presentation.summary;

  // 卡 I：「风险原因」说明行——宿主把 meta 翻译成展示串下发，页端只拼装不判定
  const reasonText = describeRiskReason(request.meta);
  let riskLine: HTMLElement | undefined;
  if (reasonText) {
    riskLine = doc.createElement('div');
    riskLine.className = 'ds-consent-risk-reason';
    riskLine.textContent = `风险：${reasonText}`;
  }

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
    ...(riskLine ? [riskLine] : []),
    ...(scopeParts.length > 0 ? [scopeHint] : []),
    actions,
    ...(meta?.hideAllowSession ? [sessionHint] : []));
  overlay.append(card);
  doc.body.append(overlay);
  entry.overlay = overlay;

  function settle(decision: ConsentDecision): void {
    settleConsent(entry, decision);
  }

  /**
   * 键盘处理。
   *
   * 两个安全修复（2026-11-02）：
   *
   * 1. **输入法守卫**：中文输入法按回车是「确认候选词」，不是「批准」。
   *    没有守卫时，用户在输入法里选词按回车 → 直接批准工具执行。
   *    `isComposing` 是标准判定；`keyCode === 229` 是旧浏览器的兼容路径
   *    （部分 IME 在 isComposing 置位前就派发 keydown）。
   *    命中任一 → **直接忽略该次按键**，不 settle（保守：宁可让用户再点一次）。
   *
   * 2. **Enter 改绑 deny**：原先 Enter = allow-once，误触即放行。
   *    现在 Enter 与 Escape 一样是「拒绝」——拒绝是安全侧的默认。
   *    「允许一次」只走**显式点击**；键盘用户仍可用
   *    Tab 聚焦到「允许一次」按钮后按 Enter/Space（原生 `<button>` 激活），
   *    不丢键盘可达性。
   */
  function onKey(e: KeyboardEvent): void {
    // 输入法组字中：回车是选词，不是决策 → 整个弹窗不响应。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') settle('deny');
    else if (e.key === 'Enter') settle('deny');
  }

  /**
   * R2-01：决议必须来自真实用户手势。
   *
   * 合成事件（`dispatchEvent` / 脚本 `.click()`）的 `isTrusted === false`——页内脚本
   * 若能在用户不知情时伪造「允许一次」，等于绕过同意闸门。因此四个动作按钮的回调都
   * 校验 `e.isTrusted === true`，非真实手势**不产生回执**（保持 pending，宿主超时 deny）。
   *
   * 键盘（Enter/Esc）与遮罩点击保持原逻辑：它们只通向 **deny**（安全侧默认），
   * 不产生 allow 回执，无伪造放行风险。
   */
  function trustedGesture(e: Event, decision: ConsentDecision): void {
    if (e.isTrusted !== true) return;
    settle(decision);
  }

  btnAllowOnce.addEventListener('click', (e) => trustedGesture(e, 'allow-once'));
  btnDeny.addEventListener('click', (e) => trustedGesture(e, 'deny'));
  btnAllowSession.addEventListener('click', (e) => trustedGesture(e, 'allow-session'));
  btnAllowConversation?.addEventListener('click', (e) => trustedGesture(e, 'allow-conversation'));
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
        ? '允许后，所有工具（含删除记忆、执行代码、修改设置）将按"完全放开"执行、不再逐次询问；仍需确认的只有两种情况——要出工作区的操作、彻底删除记忆（不可恢复）；安全硬规则直接拒绝、不弹窗。请确认你了解这项变更的影响。'
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
/**
 * K3（2026-11-09）：徽标行构造导出（原为模块内部函数）。
 * 审批窗口复用本函数拼「高风险 / 风险 / 档位 / 工作区外 / 风险项」徽标行，
 * 保证窗口与页内模态的徽标逻辑单一真源。
 */
export function buildBadges(meta: ConsentMeta | undefined, highRisk: boolean): HTMLElement | null {
  if (!meta && !highRisk) return null;
  const items: { text: string; level: 'info' | 'warn' | 'danger' | 'high-risk' }[] = [];
  if (highRisk) items.push({ text: '高风险', level: 'high-risk' });
  if (meta?.riskLabel) items.push({ text: meta.riskLabel, level: 'danger' });
  if (meta?.modeLabel) items.push({ text: meta.modeLabel, level: 'info' });
  if (meta?.outside) items.push({ text: '工作区外', level: 'warn' });
  for (const flag of meta?.riskFlagLabels ?? []) items.push({ text: flag, level: 'danger' });
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
