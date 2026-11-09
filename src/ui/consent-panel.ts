/**
 * K3（审批重设计 v1，2026-11-09）审批窗口页面：在**独立 Tauri 窗口**内渲染 K2
 * 下发的待审批请求（`GET /v1/consent/pending`），决策经 `POST /v1/consent/reply` 回执。
 *
 * 定位（设计稿 §3.1/§3.4）：
 *   - 高风险审批从此落在本窗（页内模态那套路由由 K4 退役）；本窗不在聊天页的
 *     webview 里，main-world 注入脚本进不来（「agent 无法控制的审批界面」）。
 *   - 诚实边界（§3.3）：窗口仍是 WebView，不宣称 OS 级不可伪造；回执靠宿主侧
 *     nonce（常数时间相等＋一次性消费＋ownerId 绑定，K2 沿用 page-runtime 既有逻辑）
 *     把决议绑到「这一次真实手势」上。
 *
 * 复用（卡 I 的视觉组件，**不重写一套样式**）：
 *   - 呈现助手：describeConsentRequest / isHighRiskPresentation / describeRiskReason
 *   - 徽标行：buildBadges（页内模态同源）
 *   - 视觉 CSS：CONSENT_MODAL_CSS（渲染时注入，与页内模态共用类名）
 *   - 本文件只提供窗口壳 CSS（src/ui/consent-window.css）与状态块（.cw-*）。
 *
 * 三按钮（K3 卡面）：允许一次 ／ 本对话始终允许 ／ 拒绝。
 *   - 点「本对话始终允许」**先展示「将记住什么」**（CONVERSATION_GRANT_REMEMBERED_TEXT，
 *     OpenCode `permissionAlwaysLines` 同族；设计稿 §4.2 的安全代价必须让用户看见），
 *     再显式确认才发 `allow-conversation` 回执。
 *   - 拒绝不带反馈（设计稿阶段三再做）。
 *
 * 数据面（K2 契约，设计稿 §3.3）：
 *   - token 由 Rust init script 注入本窗 `window.__STUDIO_TOKEN__`；origin 取
 *     `window.__STUDIO_API_ORIGIN__`（缺省回落 `location.origin`）。
 *   - 壳（consent-window.html）零秘密：服务端逐字节返回磁盘文件，绝不做替换。
 *
 * fail-closed（§3.4，与卡 I ⑤ 同口径）：
 *   - 无 pending / 无 token / 网络失败 → 等待或错误状态，**不显示假审批卡**；
 *   - 请求无 nonce → 不渲染允许类按钮（回执无法绑定），只给「拒绝」＋说明，
 *     宿主超时拒（最终兜底）；
 *   - 渲染异常 → 立即 POST `deny`（弹不出 ≠ 静默放行）。
 */

import {
  CONSENT_MODAL_CSS,
  buildBadges,
  describeConsentRequest,
  describeRiskReason,
  isHighRiskPresentation,
  type ConsentDecision,
  type ConsentMeta,
} from './consent';

declare global {
  interface Window {
    /** Rust init script 注入的全权宿主 token（本页数据面 Bearer 用）。 */
    __STUDIO_TOKEN__?: string;
    /** Rust init script 注入的服务端 origin；缺省回落 `location.origin`。 */
    __STUDIO_API_ORIGIN__?: string;
  }
}

/** K2 契约（设计稿 §3.3）：`GET /v1/consent/pending` 返回的待审批请求。 */
export interface ConsentPendingRequest {
  callId?: string;
  tool: string;
  /** 宿主翻译好的参数摘要（脱敏在宿主侧；页端不碰全量参数）。 */
  paramsSummary?: string;
  /** 宿主翻译好的档位展示名（缺省时徽标行回落 meta.modeLabel）。 */
  modeLabel?: string;
  /** 风险事实 / 呈现字段（与页内模态 ConsentMeta 同源）。 */
  meta?: ConsentMeta;
  /** 一次性 nonce：回执必须原样带回；缺失 ⇒ 页端不得产生允许类回执（fail-closed）。 */
  nonce?: string;
}

export interface ConsentPendingPayload {
  pending: boolean;
  request?: ConsentPendingRequest;
}

/** K3 卡面死字面：点「本对话始终允许」前先展示的「将记住什么」范围（§4.2 安全代价明示）。 */
export const CONVERSATION_GRANT_REMEMBERED_TEXT =
  '本对话内所有工具（含代码执行、删除记忆）不再询问，换对话/工作区/档位后失效。';

export interface ConsentPanelOptions {
  /** 挂载根（壳的 #consent-root）。 */
  root: HTMLElement;
  /** 缺省读 `window.__STUDIO_TOKEN__`。 */
  token?: string;
  /** 缺省读 `window.__STUDIO_API_ORIGIN__`（再缺省回落 `location.origin`）。 */
  origin?: string;
  /** 轮询间隔 ms（缺省 2000；窗口生命周期归 K1 的 Rust 线程，这里是页面数据面兜底）。 */
  pollMs?: number;
  /** 测试注入：fetch 实现（缺省用全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 测试注入：定时器实现（缺省用全局 setInterval/clearInterval）。 */
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (id: unknown) => void;
}

export interface ConsentPanel {
  /** 拉一次 pending 并渲染（首帧已自动跑过一次；测试可手动驱动）。 */
  tick(): Promise<void>;
  /** 发一次回执（按钮回调内部使用；测试可直调）。 */
  reply(decision: ConsentDecision): Promise<boolean>;
  /** 停止轮询。 */
  stop(): void;
}

const STYLE_ID = 'ds-consent-window-style';
const POLL_MS_DEFAULT = 2000;

export function mountConsentPanel(options: ConsentPanelOptions): ConsentPanel {
  const doc = globalThis.document;
  const token = options.token ?? window.__STUDIO_TOKEN__ ?? '';
  const origin =
    options.origin ??
    window.__STUDIO_API_ORIGIN__ ??
    (typeof location !== 'undefined' ? location.origin : '');
  const fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? (globalThis as { fetch: typeof fetch }).fetch : undefined);
  const setIntervalImpl = options.setIntervalImpl ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const clearIntervalImpl = options.clearIntervalImpl ?? ((id: unknown) => globalThis.clearInterval(id as ReturnType<typeof setTimeout>));

  const state: {
    current: ConsentPendingRequest | undefined;
    responding: boolean;
    timer: unknown;
    stopped: boolean;
  } = { current: undefined, responding: false, timer: undefined, stopped: false };

  function renderState(message: string, isError = false): void {
    const root = options.root;
    root.innerHTML = '';
    const box = doc.createElement('div');
    box.className = isError ? 'cw-state is-error' : 'cw-state';
    box.textContent = message;
    root.append(box);
  }

  function injectConsentCss(): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CONSENT_MODAL_CSS;
    (doc.head ?? doc.documentElement).append(style);
  }

  async function fetchPending(): Promise<ConsentPendingPayload | null> {
    const r = await fetchImpl!(`${origin}/v1/consent/pending`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as ConsentPendingPayload;
  }

  async function tick(): Promise<void> {
    if (state.stopped) return;
    if (!fetchImpl) {
      renderState('数据面未装配（fetch 不可用），本窗口无法审批', true);
      return;
    }
    let payload: ConsentPendingPayload | null;
    try {
      payload = await fetchPending();
    } catch (error) {
      // 网络失败 / 401（token 缺失）/ K2 未就绪（404）：可见错误，保持重试，不出假卡。
      renderState(`读取待审批请求失败（${(error as Error).message}），将继续重试`, true);
      state.current = undefined;
      return;
    }
    const req = payload?.pending ? payload.request : undefined;
    if (!req) {
      state.current = undefined;
      renderState('暂无待审批请求');
      return;
    }
    // 同一条请求已在屏上展示：不重渲染（防止用户读到一半被轮询闪烁重置）。
    // 换了一条新请求（callId 变化）：替换卡片。
    if (state.current) {
      if (req.callId && state.current.callId && req.callId !== state.current.callId) {
        state.current = req;
        try {
          renderRequest(req);
        } catch (error) {
          await failClosedOnRender(error);
        }
      }
      return;
    }
    state.current = req;
    try {
      renderRequest(req);
    } catch (error) {
      await failClosedOnRender(error);
    }
  }

  /** §3.4 渲染失败 fail-closed：弹不出 ≠ 静默放行 —— 立即 deny（与卡 I ⑤ 同口径）。
   * 顺序＝回执优先于画面：reply 内部已会画出结果状态（已处理 / 回执失败），
   * 即便这里的 DOM 再抛异常，拒绝回执也已发出，不会静默放行。 */
  async function failClosedOnRender(error: unknown): Promise<void> {
    console.error('[consent-window] render failed → fail-closed deny', error);
    // 回执优先：reply 依赖 state.current 组载荷，清状态是 reply 的职责
    // （成功/失败两路都会清）。这里先清会让 reply 读到空请求、静默不发——
    // 那正是 fail-closed 不能出现的「静默放行」形状。
    await reply('deny');
  }

  function renderRequest(req: ConsentPendingRequest): void {
    const root = options.root;
    root.innerHTML = '';
    injectConsentCss();

    const card = doc.createElement('div');
    card.className = 'ds-consent-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const presentation = describeConsentRequest({ tool: req.tool });

    const title = doc.createElement('div');
    title.className = 'ds-consent-title';
    title.textContent = presentation.title;

    const toolEl = doc.createElement('div');
    toolEl.className = 'ds-consent-tool';
    toolEl.textContent = presentation.headline;

    // 卡 I 视觉组件：高风险切危险外观（同一套弹层语言内的红色系强调）
    const highRisk = isHighRiskPresentation(req.meta);
    if (highRisk) card.dataset.risk = 'high';

    // 徽标行（卡 I 同源 buildBadges：高风险 / 风险 / 档位 / 工作区外 / 风险项）
    const mergedMeta: ConsentMeta = { ...req.meta, modeLabel: req.modeLabel ?? req.meta?.modeLabel };
    const badges = buildBadges(mergedMeta, highRisk);

    const summary = doc.createElement('div');
    summary.className = 'ds-consent-summary';
    summary.textContent = req.paramsSummary || presentation.summary;

    // 卡 I 视觉组件：「风险原因」说明行（宿主把 meta 翻译成展示串下发，页端只拼装不判定）
    let riskLine: HTMLElement | undefined;
    const reasonText = describeRiskReason(req.meta);
    if (reasonText) {
      riskLine = doc.createElement('div');
      riskLine.className = 'ds-consent-risk-reason';
      riskLine.textContent = `风险：${reasonText}`;
    }

    // 档位 · 目标显形（卡 I T4 scope-hint 同族：工具名 · 审批类 · 规范目标）
    const classLabel =
      req.meta?.approvalClass === 'always' ? '高风险（始终审批）'
      : req.meta?.approvalClass === 'hard-deny' ? '硬拒绝'
      : req.meta?.approvalClass === 'mode' ? '按档位'
      : req.meta?.approvalClass === 'none' ? '免审批'
      : req.meta?.approvalClass ? req.meta.approvalClass
      : '';
    const scopeParts = [
      presentation.headline,
      classLabel,
      req.meta?.canonicalTarget ? `目标：${req.meta.canonicalTarget}` : '',
    ].filter(Boolean);
    let scopeHint: HTMLElement | undefined;
    if (scopeParts.length > 0) {
      scopeHint = doc.createElement('div');
      scopeHint.className = 'ds-consent-scope-hint';
      scopeHint.textContent = scopeParts.join(' · ');
    }

    // ── 三按钮（K3 卡面）：允许一次 ／ 本对话始终允许 ／ 拒绝 ──
    const actions = doc.createElement('div');
    actions.className = 'ds-consent-actions';
    const btnDeny = mkBtn('拒绝', 'ds-consent-deny');
    const hasNonce = typeof req.nonce === 'string' && req.nonce !== '';
    let btnAllowOnce: HTMLButtonElement | undefined;
    let btnAllowConversation: HTMLButtonElement | undefined;

    // 「将记住什么」确认块（OpenCode permissionAlwaysLines 同族）：先展示、再显式确认
    const rememberedBox = doc.createElement('div');
    rememberedBox.className = 'cw-remembered';
    rememberedBox.hidden = true;
    const rememberedTitle = doc.createElement('div');
    rememberedTitle.className = 'cw-remembered-title';
    rememberedTitle.textContent = '将记住什么';
    const rememberedText = doc.createElement('div');
    rememberedText.textContent = CONVERSATION_GRANT_REMEMBERED_TEXT;
    const rememberedActions = doc.createElement('div');
    rememberedActions.className = 'cw-remembered-actions';
    const btnConfirmConversation = mkBtn('确认：本对话始终允许', 'ds-consent-allow-conversation');
    const btnCancel = mkBtn('取消', 'ds-consent-deny');
    rememberedActions.append(btnConfirmConversation, btnCancel);
    rememberedBox.append(rememberedTitle, rememberedText, rememberedActions);

    /** R2-01 同族守卫：回执必须来自真实用户手势（isTrusted）；合成事件不产生回执。 */
    function guarded(decision: ConsentDecision): (e: Event) => void {
      return (e: Event) => {
        if (e.isTrusted !== true) return;
        void reply(decision);
      };
    }

    if (hasNonce) {
      btnAllowOnce = mkBtn('允许一次', 'ds-consent-allow-once');
      btnAllowConversation = mkBtn('本对话始终允许', 'ds-consent-allow-conversation');
      actions.append(btnAllowOnce, btnDeny, btnAllowConversation);

      btnAllowOnce.addEventListener('click', guarded('allow-once'));
      btnDeny.addEventListener('click', guarded('deny'));
      btnAllowConversation.addEventListener('click', (e: Event) => {
        if (e.isTrusted !== true) return;
        // 两级：先展示「将记住什么」，再显式确认才发 allow-conversation 回执
        actions.hidden = true;
        rememberedBox.hidden = false;
      });
      btnConfirmConversation.addEventListener('click', guarded('allow-conversation'));
      btnCancel.addEventListener('click', (e: Event) => {
        if (e.isTrusted !== true) return;
        rememberedBox.hidden = true;
        actions.hidden = false;
      });
    } else {
      // fail-closed：无 nonce ⇒ 回执无法绑定到这次请求 ⇒ 允许类按钮不渲染，
      // 只给「拒绝」（宿主对无 nonce 回执按忽略处理，最终由宿主超时拒）。
      actions.append(btnDeny);
      btnDeny.addEventListener('click', guarded('deny'));
      const note = doc.createElement('div');
      note.className = 'cw-invalid-note';
      note.textContent = '该请求缺少一次性凭据（nonce），无法在本窗口批准；宿主将超时拒绝。';
      card.append(note);
    }

    card.append(
      title,
      toolEl,
      ...(badges ? [badges] : []),
      summary,
      ...(riskLine ? [riskLine] : []),
      ...(scopeHint ? [scopeHint] : []),
      actions,
      // 「将记住什么」块是 actions 的兄弟（DOM 序在其后）：点「本对话始终允许」时
      // actions 整行隐藏、rememberedBox 显形；若嵌在 actions 里会被一起藏掉。
      ...(hasNonce ? [rememberedBox] : []),
    );
    root.append(card);
  }

  async function reply(decision: ConsentDecision): Promise<boolean> {
    const req = state.current;
    if (!req || state.responding || !fetchImpl) return false;
    state.responding = true;
    try {
      const r = await fetchImpl(`${origin}/v1/consent/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ callId: req.callId, decision, nonce: req.nonce }),
      });
      if (!r.ok) {
        // 回执未被受理：不静默、不重试（宿主超时拒绝是兜底），可见报错。
        state.current = undefined;
        renderState(`回执未被受理（HTTP ${r.status}），该请求将由宿主超时拒绝`, true);
        return false;
      }
      state.current = undefined;
      renderState('已处理：宿主将按你的决议继续执行');
      return true;
    } catch (error) {
      state.current = undefined;
      renderState(`回执发送失败（${(error as Error).message}），该请求将由宿主超时拒绝`, true);
      return false;
    } finally {
      state.responding = false;
    }
  }

  // 首帧立即拉一次；随后轮询（窗口开/关归 K1 的 Rust 线程，这里只是数据面兜底）。
  void tick();
  state.timer = setIntervalImpl(() => {
    void tick();
  }, options.pollMs ?? POLL_MS_DEFAULT);

  return {
    tick,
    reply,
    stop() {
      state.stopped = true;
      clearIntervalImpl(state.timer);
    },
  };
}

function mkBtn(label: string, cls: string): HTMLButtonElement {
  const b = globalThis.document.createElement('button');
  b.className = cls;
  b.textContent = label;
  return b;
}

// ── 壳挂载（与 mcp-settings-panel.ts 同一形态）：#consent-root 缺失 = 壳与 JS 版本错配，
//    可见降级（warn），不崩、不静默。 ──
if (typeof document !== 'undefined') {
  const rootEl = document.getElementById('consent-root');
  if (rootEl) {
    mountConsentPanel({ root: rootEl });
  } else {
    console.warn('[StudioUI] #consent-root missing, 审批窗口无法挂载审批卡');
  }
}

export {};
