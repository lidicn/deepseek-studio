// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * R2-01 页端半张 · host-client 侧：consent nonce 绑定的**发送链路**。
 *
 * 打真实入口 `createHostClient`（可注入 wsFactory 捕获真实线上帧）+ 真实 `showConsent`
 * 模态（jsdom DOM），逐字锁定 `protocol.ts` 的契约：
 *   - consent-required（带 nonce）→ 渲染模态；真实手势点击 →
 *     `ws.send({ type:'consent-decision', callId, decision, nonce })`（nonce 原样带回）；
 *   - **主负控**：合成点击（jsdom `.click()`，isTrusted=false）→ **不产生任何
 *     consent-decision 帧**（页内脚本伪造决议被拒，宿主保持 pending → 超时 deny）；
 *   - consent-required（无 nonce = 高风险走宿主原生框）→ 页端**不渲染模态**，
 *     立即 fail-closed 发 `consent-decision { decision:'deny' }`（不带 nonce）。
 */

import { createHostClient } from '../../src/desktop/host-client';
import { __resetConsentQueueForTests } from '../../src/ui/consent';

type Handler = ((...args: unknown[]) => void) | null;

function makeFakeWs() {
  const sent: string[] = [];
  const sockets: Array<Record<string, unknown>> = [];
  const factory = (url: string) => {
    const ws = {
      url,
      readyState: 0,
      onopen: null as Handler,
      onmessage: null as Handler,
      onclose: null as Handler,
      onerror: null as Handler,
      send(data: string) { sent.push(data); },
      close() { this.readyState = 3; },
    };
    sockets.push(ws);
    return ws;
  };
  return { sent, sockets, factory };
}

function installClient() {
  const ws = makeFakeWs();
  const host = createHostClient({
    url: 'ws://127.0.0.1:8760/studio',
    capabilities: [],
    wsFactory: ws.factory,
  });
  host.connect();
  const sock = ws.sockets[0] as { readyState: number; onopen: Handler; onmessage: Handler };
  // 翻到 OPEN 再触发 onopen（hello 出站），与 R3-03 同一套 fake ws 模式。
  sock.readyState = 1;
  sock.onopen?.();
  const deliver = (msg: Record<string, unknown>) => { sock.onmessage?.({ data: JSON.stringify(msg) }); };
  return { host, sent: ws.sent, deliver };
}

/** 从线上帧挑出 consent-decision（走真实 JSON 序列化，非私有函数）。 */
function consentDecisions(sent: string[]): Array<Record<string, unknown>> {
  return sent
    .map((f) => { try { return JSON.parse(f) as Record<string, unknown>; } catch { return null; } })
    .filter((m): m is Record<string, unknown> => !!m && m.type === 'consent-decision');
}

/**
 * jsdom 造不出 isTrusted=true 的事件（且 isTrusted 非可配置），模拟「真点击」：
 * 渲染前在 HTMLButtonElement.prototype.addEventListener 挂 spy，捕获 R2-01 守卫挂在
 * 按钮上的**真实 click 监听器**，再用 isTrusted=true 的最小事件对象调用它。
 * （与 tests/desktop/consent.test.ts 的 captureButtonClicks 同口径的小件复制。）
 */
function captureButtonClicks() {
  const handlers = new Map<string, (e: Event) => void>();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const spy = vi.spyOn(HTMLButtonElement.prototype, 'addEventListener').mockImplementation(
    function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
      if (type === 'click' && typeof listener === 'function') {
        handlers.set(((this as HTMLButtonElement).className ?? ''), listener as (e: Event) => void);
      }
      return nativeAdd.call(this, type, listener, options);
    },
  );
  return {
    handlers,
    trustedEvent: () => ({ isTrusted: true } as unknown as Event),
    stop: () => { spy.mockRestore(); },
  };
}

afterEach(() => {
  __resetConsentQueueForTests();
  document.querySelectorAll('.ds-consent-overlay, .ds-consent-card').forEach((el) => el.remove());
  document.body.textContent = '';
});

describe('R2-01 · host-client 页端：consent nonce 绑定发送链路', () => {
  it('consent-required（带 nonce）+ 真实手势 → consent-decision 带原 nonce 回宿主', () => {
    const { sent, deliver } = installClient();
    const cap = captureButtonClicks();
    try {
      deliver({ type: 'consent-required', callId: 'c1', tool: 'file.write', params: { path: 'E:/x' }, nonce: 'nonce-abc' });
      // 模态渲染了
      expect(document.querySelector('.ds-consent-overlay')).not.toBeNull();
      // 真实手势点「允许一次」
      cap.handlers.get('ds-consent-allow-once')!(cap.trustedEvent());
      const dec = consentDecisions(sent);
      expect(dec.length).toBe(1);
      // payload 逐字对齐 protocol.ts：{ type, callId, decision, nonce }
      expect(dec[0]).toEqual({ type: 'consent-decision', callId: 'c1', decision: 'allow-once', nonce: 'nonce-abc' });
    } finally {
      cap.stop();
    }
  });

  it('主负控：consent-required（带 nonce）+ 合成点击（isTrusted=false）→ 不产生任何 consent-decision 帧', () => {
    const { sent, deliver } = installClient();
    deliver({ type: 'consent-required', callId: 'c2', tool: 'shell.exec', params: { command: 'whoami' }, nonce: 'nonce-xyz' });
    expect(document.querySelector('.ds-consent-overlay')).not.toBeNull();
    // jsdom 的 .click() 事件 isTrusted 恒 false → 被手势守卫拦下，不结算。
    (document.querySelector('.ds-consent-allow-once') as HTMLButtonElement).click();
    (document.querySelector('.ds-consent-deny') as HTMLButtonElement).click();
    expect(consentDecisions(sent).length).toBe(0);
    // 模态仍在：等真实手势，或宿主 consent-abort / 超时 deny（宿主侧 r2-01-consent-gesture.test.ts 覆盖）。
    expect(document.querySelector('.ds-consent-overlay')).not.toBeNull();
  });

  it('consent-required（无 nonce = 高风险走宿主原生框）→ 不渲染模态 + fail-closed deny 帧（不带 nonce）', () => {
    const { sent, deliver } = installClient();
    deliver({ type: 'consent-required', callId: 'c3', tool: 'file.write', params: { path: 'E:/x' } });
    // 页端不渲染：宿主自己弹原生框，页内脚本没有可点的东西、也没有可绑的 nonce。
    expect(document.querySelector('.ds-consent-overlay')).toBeNull();
    const dec = consentDecisions(sent);
    expect(dec.length).toBe(1);
    expect(dec[0]).toEqual({ type: 'consent-decision', callId: 'c3', decision: 'deny' });
    expect(dec[0].nonce).toBeUndefined();
  });
});
