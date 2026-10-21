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

  it('修改审批档位使用自然语言，不暴露协议字段', () => {
    const handle = showConsent({
      tool: 'policy.set',
      params: { mode: 'full' },
      meta: { riskLabel: '特权级', modeLabel: '风险审批' },
    }, () => {});

    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    expect(card.textContent).toContain('Studio 请求修改审批档位');
    expect(card.textContent).toContain('将审批档位改为「完全放开」');
    expect(card.textContent).toContain('普通操作可能不再逐次向你确认');
    expect(card.textContent).not.toContain('policy.set');
    expect(card.textContent).not.toContain('mode:');
    expect(document.querySelector('.ds-consent-allow-once')?.textContent).toBe('允许本次修改');
    handle.dispose();
  });

  it('修改工作区使用自然语言，不暴露参数键名', () => {
    const handle = showConsent({
      tool: 'workspace.set',
      params: { root: 'E:\\NAS' },
      meta: { riskLabel: '特权级' },
    }, () => {});

    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    expect(card.textContent).toContain('将工具工作区切换到新目录');
    expect(card.textContent).toContain('E:\\NAS');
    expect(card.textContent).not.toContain('workspace.set');
    expect(card.textContent).not.toContain('root:');
    handle.dispose();
  });
});
