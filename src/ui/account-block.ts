/**
 * 账号身份锁阻塞覆盖层（v0.31，页侧）
 *
 * 宿主检测到同账号双窗口（hello 上报的 accountFingerprint 与已登记页重复）时，
 * 令本页 fail-closed：渲染全屏不可关闭的红底覆盖层，挡住一切 DeepSeek 交互，
 * 直到用户关闭本窗口或切换账号。
 *
 * 这是防封号铁律「1 槽位 : 1 账号 : 1 窗口」的执行手段——同账号多窗口并发正是
 * DeepSeek 风控封号判据。覆盖层刻意**无 Esc/点外关闭**（fail-closed，只能换号或关窗）。
 */

const STYLE_ID = 'ds-account-block-style';

const CSS = `
.ds-account-block-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(180, 24, 24, 0.97);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Microsoft YaHei", sans-serif;
}
.ds-account-block-card {
  max-width: 560px; margin: 0 24px; padding: 32px 28px;
  background: #fff; border-radius: 14px; color: #1a1a1a;
  box-shadow: 0 24px 60px rgba(0,0,0,.4);
}
.ds-account-block-title {
  font-size: 20px; font-weight: 700; color: #b41818; margin-bottom: 12px;
}
.ds-account-block-body {
  font-size: 15px; line-height: 1.7; color: #333; margin-bottom: 20px;
}
.ds-account-block-body strong { color: #b41818; }
.ds-account-block-hint {
  font-size: 13px; color: #666; margin-top: 16px; padding-top: 16px;
  border-top: 1px solid #eee;
}
`;

function ensureStyles(): void {
  const doc = globalThis.document;
  if (!doc) return;
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

let overlayEl: HTMLElement | null = null;

/**
 * 渲染阻塞覆盖层。幂等：重复调用不叠加（同窗口不会收两次 block）。
 * reason/duplicateOf 来自宿主下发的 account-duplicate-block 消息。
 */
export function showAccountBlockOverlay(reason: string, duplicateOf?: string): void {
  const doc = globalThis.document;
  if (!doc || !doc.body) return;
  if (overlayEl) return; // 已显示，幂等
  ensureStyles();

  const overlay = doc.createElement('div');
  overlay.className = 'ds-account-block-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');

  const card = doc.createElement('div');
  card.className = 'ds-account-block-card';

  const title = doc.createElement('div');
  title.className = 'ds-account-block-title';
  title.textContent = '⚠️ 账号冲突 — 本窗口已停用';

  const body = doc.createElement('div');
  body.className = 'ds-account-block-body';
  body.replaceChildren();
  const p1 = doc.createElement('div');
  p1.textContent = reason;
  const p2 = doc.createElement('div');
  p2.innerHTML = `同一 DeepSeek 账号在多个窗口并发登录会触发 <strong>风控封号</strong>。`;
  body.append(p1, p2);
  if (duplicateOf) {
    const p3 = doc.createElement('div');
    p3.textContent = `已占用该账号的窗口：bot=${duplicateOf}`;
    body.append(p3);
  }

  const hint = doc.createElement('div');
  hint.className = 'ds-account-block-hint';
  hint.textContent = '请关闭本窗口，或在本窗口登出后切换到另一个 DeepSeek 账号。本窗口的工具调用已被宿主拒绝（fail-closed）。';

  card.append(title, body, hint);
  overlay.append(card);
  doc.body.append(overlay);
  overlayEl = overlay;
}
