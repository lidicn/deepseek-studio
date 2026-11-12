/**
 * chat-send 能力（v0.3.3，send 风险，需用户同意）
 *
 * 提交当前输入框内容。针对真实 chat.deepseek.com DOM（v0.6 实测）：
 *   - 发送按钮不是 <button>，是 div.ds-button--primary--filled--circle（圆形主按钮）
 *   - 选择器级联：textarea 邻近圆形按钮 → 全局圆形按钮 → 传统候选 → Enter 键
 */

import type { ContentCapabilityController } from '../inject/types';
import type { ExecutableCapability, ExecuteResult } from './types';
import { queryFirst, clickElement, pressEnter } from './dom';

const LEGACY_SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label*="发送" i]',
  'button[aria-label*="send" i]',
  '.send-button',
  'button[type="submit"]',
];

/** 找输入框（真实站点是唯一 textarea，placeholder「给 DeepSeek 发送消息」）。 */
function findInput(doc: Document): HTMLTextAreaElement | HTMLElement | null {
  const ta = Array.from(doc.querySelectorAll('textarea')).find((t) => t.offsetWidth > 0);
  if (ta) return ta;
  return queryFirst(doc, ['[contenteditable="true"]']) as HTMLElement | null;
}

/** 从输入框向上找 composer 容器里的发送按钮（圆形填充主按钮）。 */
function findSendButtonNear(input: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = input;
  for (let depth = 0; depth < 6 && p; depth++) {
    p = p.parentElement;
    if (!p) break;
    const btn = queryFirst(p, [
      'div.ds-button--circle',
      '.ds-button--circle',
      'div.ds-button--filled',
      '[role="button"][aria-disabled="false"]',
    ]) as HTMLElement | null;
    if (btn && btn.offsetWidth > 0) return btn;
  }
  return null;
}

function findGlobalSendButton(doc: Document): HTMLElement | null {
  return queryFirst(doc, [
    'div.ds-button--circle',
    '.ds-button--circle',
  ]) as HTMLElement | null;
}

/**
 * N3-02 B：按钮是否处于禁用态。
 *
 * `clickElement`（dom.ts）只做 `el.click(); return true`，**不查 disabled** ——
 * 点一个灰按钮照样 ok:true，等于「什么都没发却报成功」。而发送中／生成中时站点
 * 恰好会把圆形主按钮置灰，所以这一判必须补在点击之前。
 *
 * 只在本能力内判，不动 `clickElement` 的公共语义（其它调用方依赖「点了就算点了」）。
 */
function isDisabled(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return el.hasAttribute('disabled');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 读取输入框当前文本（textarea / input 用 value，contenteditable 用 textContent）。 */
function readInputValue(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return el.textContent ?? '';
}

export function createChatSendCapability(): ContentCapabilityController & ExecutableCapability {
  return {
    id: 'chat-send',
    start() {},
    async stop() {},
    async execute(): Promise<ExecuteResult> {
      const doc = globalThis.document;
      if (!doc) return { ok: false, error: 'no-document' };

      const input = findInput(doc);
      // 策略 1/2：圆形发送按钮（输入框邻近 → 全局）。禁用态点它等于空转，不算成功。
      if (input) {
        const near = findSendButtonNear(input);
        if (near && !isDisabled(near) && clickElement(near)) {
          return { ok: true, data: { sent: true, via: 'circle-button-near' } };
        }
      }
      const globalBtn = findGlobalSendButton(doc);
      if (globalBtn && !isDisabled(globalBtn) && clickElement(globalBtn)) {
        return { ok: true, data: { sent: true, via: 'circle-button-global' } };
      }
      // 策略 3：传统候选（R2-C2 修复：原先 `input ? null : ...` 使有输入框时
      // 传统候选永不尝试，回退链实际少一环；改为无条件尝试）。
      const legacy = queryFirst(doc, LEGACY_SEND_SELECTORS);
      if (legacy && !isDisabled(legacy) && clickElement(legacy)) {
        return { ok: true, data: { sent: true, via: 'legacy-button' } };
      }
      // 策略 4：对输入框合成 Enter。
      // R2-C2 修复：合成 Enter 常被 React 受控输入忽略，此时消息并未发出。
      // 必须验证「输入框确已被清空」这一可判定证据，否则报 send-unconfirmed，
      // 不允许把「调用没抛错」当成「事情做成了」（假成功）。
      //
      // N3-02 B：清空是**异步**的（站点 onKeyDown 更新 state → 下一次渲染才写回 DOM），
      // 同步读 after 会把「真的发出去了」判成 send-unconfirmed，再叠上 web-engine 的重试
      // 就是同一条消息发两遍。等一帧再读。
      if (input) {
        const before = readInputValue(input);
        // **空输入框不许报成功**（续审 N3-02 后续卡）。
        // 改前 `before.length === 0` 走的是 `ok:true` 分支——按 Enter 什么都发不出去，
        // 却报 `sent:true`，宿主据此去等一条永远不来的回复（静默挂死）。
        // 空就是空：连 Enter 都不必按，直接判 input-empty，交给上层报错。
        if (before.length === 0) return { ok: false, error: 'input-empty' };
        pressEnter(input);
        await sleep(50);
        const after = readInputValue(input);
        // Enter 后已被清空（或文本已变）→ 视为发送成功
        if (after.length === 0 || after !== before) {
          return { ok: true, data: { sent: true, via: 'enter-key' } };
        }
        return {
          ok: false,
          error: 'send-unconfirmed',
          data: { via: 'enter-key', hint: '合成 Enter 未被采纳，输入框内容未变' },
        };
      }
      return { ok: false, error: 'send-button-not-found' };
    },
  };
}
