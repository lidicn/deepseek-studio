// @vitest-environment jsdom
/**
 * 同意模态测试（v0.3.2）
 *
 * 验证：允许一次/拒绝/点遮罩外 → 对应决策；超时（默认 60s 可配）→ fail-closed 视为 deny。
 */

import { showConsent } from '../../src/ui/consent';

describe('同意模态', () => {
  it('允许一次回调', () => {
    let decision = '';
    showConsent({ tool: 'chat-send' }, (d) => {
      decision = d;
    });
    (document.querySelector('.ds-consent-allow-once') as HTMLButtonElement).click();
    expect(decision).toBe('allow-once');
  });

  it('拒绝回调', () => {
    let decision = '';
    showConsent({ tool: 'chat-send' }, (d) => {
      decision = d;
    });
    (document.querySelector('.ds-consent-deny') as HTMLButtonElement).click();
    expect(decision).toBe('deny');
  });

  it('点遮罩外 → 拒绝', () => {
    let decision = '';
    showConsent({ tool: 'chat-send' }, (d) => {
      decision = d;
    });
    const overlay = document.querySelector('.ds-consent-overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(decision).toBe('deny');
  });

  it('超时默认拒绝（fail-closed）', async () => {
    let decision = '';
    showConsent({ tool: 'chat-send', timeoutMs: 30 }, (d) => {
      decision = d;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(decision).toBe('deny');
  });
});
