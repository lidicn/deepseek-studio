// @vitest-environment jsdom
/**
 * 同意模态测试（v0.3.2 + T8-1/T8-2 修订）
 *
 * T8-1：审批弹窗只显示自然语言显示名，原始协议名只进 trace/日志。
 * T8-2：afterEach 统一 dispose overlay，避免上一条失败污染后续 DOM。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeConsentRequest, showConsent, toolDisplayName } from '../../src/ui/consent';

/** T8-2：全局统一清理 overlay + 重置 body，任何失败都不污染后续用例。 */
afterEach(() => {
  // 清理所有残留 overlay / consent card
  document.querySelectorAll('.ds-consent-overlay, .ds-consent-card').forEach((el) => el.remove());
  // 清 body 防止旧 card 残留
  document.body.textContent = '';
  // 确保没有残留的 consent 按钮
  expect(document.querySelector('.ds-consent-overlay')).toBeNull();
});

function mkHandle(...args: Parameters<typeof showConsent>) {
  return showConsent(...args);
}

describe('同意模态（基础交互）', () => {
  it('允许一次回调', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (d) => { decision = d; });
    (document.querySelector('.ds-consent-allow-once') as HTMLButtonElement).click();
    expect(decision).toBe('allow-once');
  });

  it('拒绝回调', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (d) => { decision = d; });
    (document.querySelector('.ds-consent-deny') as HTMLButtonElement).click();
    expect(decision).toBe('deny');
  });

  it('点遮罩外 → 拒绝', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (d) => { decision = d; });
    const overlay = document.querySelector('.ds-consent-overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(decision).toBe('deny');
  });

  it('超时默认拒绝（fail-closed）', async () => {
    let decision = '';
    mkHandle({ tool: 'chat-send', timeoutMs: 30 }, (d) => { decision = d; });
    await new Promise((r) => setTimeout(r, 80));
    expect(decision).toBe('deny');
  });
});

describe('T8-1：工具显示名映射（已知/未知/工作区）', () => {
  it('已知工具 policy.set → 自然语言，不泄漏原始协议名', () => {
    const handle = mkHandle({
      tool: 'policy.set',
      params: { mode: 'full' },
      meta: { riskLabel: '特权级', modeLabel: '风险审批' },
    }, () => {});

    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    expect(card.textContent).toContain('Studio 请求修改审批档位');
    expect(card.textContent).toContain('将审批档位改为「完全放开」');
    expect(card.textContent).toContain('普通操作可能不再逐次向你确认');
    // 原始协议名不出现
    expect(card.textContent).not.toContain('policy.set');
    expect(card.textContent).not.toContain('mode:');
    // 按钮文字是定制版
    expect(document.querySelector('.ds-consent-allow-once')?.textContent).toBe('允许本次修改');
    handle.dispose();
  });

  it('已知工具 workspace.set → 自然语言，不泄漏参数键名', () => {
    const handle = mkHandle({
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

  it('未知工具 → headline 显示"该操作"，不直接暴露原始协议名', () => {
    const handle = mkHandle({
      tool: 'totally.unknown.tool_v2',
      params: { x: 1 },
    }, () => {});

    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    // headline 区域显示"该操作"，不是原始协议名
    const toolEl = card.querySelector('.ds-consent-tool');
    expect(toolEl?.textContent).toBe('该操作');
    expect(card.textContent).not.toContain('totally.unknown.tool_v2');
    handle.dispose();
  });

  it('toolDisplayName 映射表覆盖真实触达工具，已知工具返回自然语言', () => {
    expect(toolDisplayName('policy.set')).toBe('修改审批档位');
    expect(toolDisplayName('workspace.set')).toBe('修改工作区');
    expect(toolDisplayName('shell.exec')).toBe('执行终端命令');
    expect(toolDisplayName('memory.save')).toBe('保存记忆');
    // 未知工具统一显示"该操作"
    expect(toolDisplayName('xyz')).toBe('该操作');
  });

  it('describeConsentRequest 对未知工具 headline 走自然语言映射', () => {
    const p = describeConsentRequest({ tool: 'totally.unknown' });
    expect(p.headline).toBe('该操作');
  });
});

describe('R-4：按钮数量（hideAllowSession）', () => {
  it('hideAllowSession=true 时不渲染第三按钮', () => {
    const handle = mkHandle({ tool: 'shell.exec', meta: { hideAllowSession: true } }, () => {});
    expect(document.querySelector('.ds-consent-allow-session')).toBeNull();
    expect(document.querySelector('.ds-consent-allow-once')).not.toBeNull();
    expect(document.querySelector('.ds-consent-deny')).not.toBeNull();
    handle.dispose();
  });

  it('默认（无 hideAllowSession）渲染三按钮', () => {
    const handle = mkHandle({ tool: 'shell.exec' }, () => {});
    expect(document.querySelector('.ds-consent-allow-once')).not.toBeNull();
    expect(document.querySelector('.ds-consent-deny')).not.toBeNull();
    expect(document.querySelector('.ds-consent-allow-session')).not.toBeNull();
    handle.dispose();
  });
});

describe('T8-2：overlay 清理反控', () => {
  it('上一条残留 overlay 时 afterEach 保证干净', () => {
    // 故意造一个不 dispose 的 overlay（模拟上一条失败/异常）
    mkHandle({ tool: 'policy.set', params: { mode: 'full' } }, () => {});
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);
    // afterEach 会清掉。此用例自身不 dispose，依赖全局清理。
  });

  it('新 consent 到来时旧请求 fail-closed 拒绝，DOM 只保留一个 overlay', () => {
    let firstDecision = '';
    mkHandle({ tool: 'shell.exec' }, (decision) => { firstDecision = decision; });
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);

    let secondDecision = '';
    const second = mkHandle({ tool: 'memory.save' }, (decision) => { secondDecision = decision; });

    // 旧请求必须已被拒绝，而不是在 DOM 里继续等待超时。
    expect(firstDecision).toBe('deny');
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);

    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    expect(card.textContent).toContain('保存记忆');
    expect(card.textContent).not.toContain('执行终端命令');

    // 当前模态必须仍可正常决策，且只回调第二条请求。
    (document.querySelector('.ds-consent-allow-once') as HTMLButtonElement).click();
    expect(firstDecision).toBe('deny');
    expect(secondDecision).toBe('allow-once');
    second.dispose();
  });
});

describe('T9-2：单一活动模态并发边界（PM T8-2 rework 覆盖）', () => {
  it('三条连续 showConsent → 前两条 fail-closed deny，第三条独占 DOM', () => {
    const decisions: string[] = [];
    const h1 = mkHandle({ tool: 'shell.exec' }, (d) => decisions.push('h1:' + d));
    const h2 = mkHandle({ tool: 'memory.save' }, (d) => decisions.push('h2:' + d));
    const h3 = mkHandle({ tool: 'chat-send' }, (d) => decisions.push('h3:' + d));
    void h1; void h2; // 变量声明即触发并发 side-effect，自身不直接引用

    // 前两条必须已被新请求 fail-closed 结算
    expect(decisions).toEqual(['h1:deny', 'h2:deny']);
    // DOM 严格只有 1 个 overlay
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);
    // 显示的卡片属于第三条（chat-send → 发送对话）
    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    expect(card.textContent).toContain('发送对话');
    expect(card.textContent).not.toContain('执行终端命令');
    expect(card.textContent).not.toContain('保存记忆');

    h3.dispose();
  });

  it('dispose() 幂等：连续两次 dispose 不抛错、不重复回调、overlay 归零', () => {
    let callbackCount = 0;
    const h = mkHandle({ tool: 'shell.exec' }, () => { callbackCount++; });

    // 第一次 dispose：清 DOM、回调数保持 0（dispose 不触发回调）
    expect(() => h.dispose()).not.toThrow();
    expect(callbackCount).toBe(0);
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);

    // 第二次 dispose：幂等——不应抛错、不应重复回调
    expect(() => h.dispose()).not.toThrow();
    expect(callbackCount).toBe(0);
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);
  });

  it('settle 后 dispose：先 decide("allow-once") 再 dispose，回调只发生一次', () => {
    let callbackCount = 0;
    let received: string | null = null;
    const h = mkHandle({ tool: 'shell.exec' }, (d) => {
      callbackCount++;
      received = d;
    });

    h.decide('allow-once');
    expect(callbackCount).toBe(1);
    expect(received).toBe('allow-once');

    // 再 dispose：不应再触发回调
    h.dispose();
    expect(callbackCount).toBe(1);
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);
  });

  it('超时路径：假定时器推进到 timeout，旧请求收到 deny，overlay 被移除，新请求能正常展示', () => {
    vi.useFakeTimers();
    try {
      let h1Decision = '';
      const h1 = mkHandle({ tool: 'shell.exec', timeoutMs: 1000 }, (d) => { h1Decision = d; });
      void h1; // side-effect 即触发 setTimeout
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);

      // 推进到超时
      vi.advanceTimersByTime(1100);
      expect(h1Decision).toBe('deny');
      // 超时后 timer 被清理，overlay 被移除
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);

      // 之后新请求能正常展示（证明旧 timer 没残留、不误杀新请求）
      let h2Decision = '';
      const h2 = mkHandle({ tool: 'memory.save', timeoutMs: 5000 }, (d) => { h2Decision = d; });
      void h2;
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);

      // 推进到新请求超时前一点——不应被旧 timer 残留误杀
      vi.advanceTimersByTime(3000);
      expect(h2Decision).toBe(''); // 还没到 5s
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);

      // 推进到新请求超时
      vi.advanceTimersByTime(2500);
      expect(h2Decision).toBe('deny');
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
