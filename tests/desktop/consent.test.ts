// @vitest-environment jsdom
/**
 * 同意模态测试（v0.3.2 + T8-1/T8-2 修订）
 *
 * T8-1：审批弹窗只显示自然语言显示名，原始协议名只进 trace/日志。
 * T8-2：afterEach 统一 dispose overlay，避免上一条失败污染后续 DOM。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConsentQueueForTests,
  describeConsentRequest,
  showConsent,
  toolDisplayName,
  type ConsentCallback,
  type ConsentHandle,
  type ConsentRequest,
} from '../../src/ui/consent';

/** T8-2：全局统一清理 overlay + 重置 body，任何失败都不污染后续用例。 */
afterEach(() => {
  __resetConsentQueueForTests();
  // 清理所有残留 overlay / consent card
  document.querySelectorAll('.ds-consent-overlay, .ds-consent-card').forEach((el) => el.remove());
  // 清 body 防止旧 card 残留
  document.body.textContent = '';
  // 确保没有残留的 consent 按钮
  expect(document.querySelector('.ds-consent-overlay')).toBeNull();
});

/**
 * R2-01：页端 consent 模态必须带 nonce（无 nonce = 高风险走宿主原生框，页端不渲染）。
 * 旧用例的调用点统一由本包装注入测试 nonce，断言口径不变（只换触发事件的手势可信度）。
 */
function mkHandle(
  request: Omit<ConsentRequest, 'nonce'> & { nonce?: string },
  onDecision: ConsentCallback,
): ConsentHandle {
  return showConsent({ nonce: 'n-test', ...request }, onDecision);
}

/**
 * R2-01 测试辅助：jsdom 造不出 isTrusted=true 的事件（真实用户手势才 trusted），
 * 且 jsdom 的 isTrusted 是 WebIDL 只读非可配置属性，无法 shadow。
 * 模拟「真点击」的做法：渲染前在 HTMLButtonElement.prototype.addEventListener 上挂 spy，
 * 捕获 R2-01 守卫挂在按钮上的**真实 click 监听器**，再用一个 isTrusted=true 的最小
 * 事件对象直接调用它（守卫只读 e.isTrusted）。实现侧守卫读错字段/漏挂 → 阳性用例转红。
 * 「负控」侧则用 jsdom 原生 `.click()`（isTrusted 恒 false）证明合成事件不产生回执。
 */
interface ClickCaptures {
  /** className → 当前模态该按钮挂着的真实 click 监听器（后渲染的模态会覆盖同名键）。 */
  handlers: Map<string, (e: Event) => void>;
  /** 造一个「真实手势」事件对象（isTrusted=true）。 */
  trustedEvent(): Event;
  stop(): void;
}

function captureButtonClicks(): ClickCaptures {
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
    // jsdom 无法构造 trusted 事件；守卫只读 isTrusted，用最小事件对象顶替（走真实监听器代码）。
    trustedEvent: () => ({ isTrusted: true } as unknown as Event),
    stop: () => spy.mockRestore(),
  };
}

describe('同意模态（基础交互）', () => {
  it('允许一次回调（R2-01：回执必须来自真实手势，jsdom 用捕获监听器 + trusted 事件模拟）', () => {
    let decision = '';
    const cap = captureButtonClicks();
    try {
      mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
      cap.handlers.get('ds-consent-allow-once')!(cap.trustedEvent());
    } finally {
      cap.stop();
    }
    expect(decision).toBe('allow-once');
  });

  it('拒绝回调（真实手势）', () => {
    let decision = '';
    const cap = captureButtonClicks();
    try {
      mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
      cap.handlers.get('ds-consent-deny')!(cap.trustedEvent());
    } finally {
      cap.stop();
    }
    expect(decision).toBe('deny');
  });

  it('点遮罩外 → 拒绝', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
    const overlay = document.querySelector('.ds-consent-overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(decision).toBe('deny');
  });

  it('超时默认拒绝（fail-closed）', async () => {
    let decision = '';
    mkHandle({ tool: 'chat-send', timeoutMs: 30 }, (r) => { decision = r.decision; });
    await new Promise((r) => setTimeout(r, 80));
    expect(decision).toBe('deny');
  });
});

/**
 * R2-01：consent 决议必须绑定真实用户手势 + 一次性 nonce（页端半张）。
 *
 * 负控（主）：合成事件（jsdom `.click()`，isTrusted=false）**不产生回执**——
 * 页内脚本伪造「允许」被拒绝，宿主保持 pending → 超时 deny。
 * 无 nonce 的 consent-required = 高风险走宿主原生框，页端**不渲染、不回执**。
 */
describe('R2-01：真实手势校验 + nonce 回执（页端）', () => {
  it('主负控：合成点击（isTrusted=false）不产生任何回执（不批准不拒绝）', () => {
    let decision = '';
    const receipts: unknown[] = [];
    const h = mkHandle({ tool: 'shell.exec' }, (r) => { decision = r.decision; receipts.push(r); });
    // jsdom 的 .click() 生成的事件 isTrusted 恒为 false → 被手势守卫拦下。
    (document.querySelector('.ds-consent-allow-once') as HTMLButtonElement).click();
    (document.querySelector('.ds-consent-deny') as HTMLButtonElement).click();
    expect(decision).toBe('');
    expect(receipts.length).toBe(0);
    // 模态仍在（未被合成事件结算）
    expect(document.querySelector('.ds-consent-overlay')).not.toBeNull();
    h.dispose();
  });

  it('真实手势（isTrusted=true）→ 产生回执且回执携带 nonce', () => {
    let receipt: { decision: string; nonce?: string } | null = null;
    const cap = captureButtonClicks();
    try {
      const h = mkHandle({ tool: 'shell.exec' }, (r) => { receipt = r; });
      cap.handlers.get('ds-consent-allow-once')!(cap.trustedEvent());
      expect(receipt).not.toBeNull();
      expect(receipt!.decision).toBe('allow-once');
      // nonce 从 consent-required（ConsentRequest）原样带回
      expect(receipt!.nonce).toBe('n-test');
      h.dispose();
    } finally {
      cap.stop();
    }
  });

  it('无 nonce 的 consent-required（= 高风险走宿主原生框）→ 页端不渲染、不回调', () => {
    let called = 0;
    const h = showConsent({ tool: 'file.write', params: { path: 'x' } }, () => { called++; });
    // 不渲染：没有任何 overlay 进 DOM
    expect(document.querySelector('.ds-consent-overlay')).toBeNull();
    // 不回调、不产生决议
    expect(called).toBe(0);
    // 句柄是 no-op：decide/dispose 都不抛错、不触发副作用
    expect(() => h.decide('allow-once')).not.toThrow();
    expect(() => h.dispose()).not.toThrow();
    expect(called).toBe(0);
  });
});

/**
 * 键盘处理的安全修复（2026-11-02）。
 *
 * ① 输入法守卫：中文输入法按回车是「确认候选词」，不是「批准」。
 *    没有守卫时，用户在 IME 里选词按回车 → 直接批准工具执行。
 * ② Enter 改绑 deny：原先 Enter = allow-once，误触即放行。
 *    现在拒绝是键盘默认；「允许一次」只走显式点击。
 */
describe('同意模态（键盘处理：IME 守卫 + Enter 绑 deny）', () => {
  function pressKey(init: KeyboardEventInit): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  }

  it('isComposing=true 的 Enter → 不产生任何决策（不批准也不拒绝）', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
    pressKey({ key: 'Enter', isComposing: true });
    // 关键：绝不能是 allow-once
    expect(decision).not.toBe('allow-once');
    // 保守策略：输入法组字期间弹窗不响应（既不批准也不拒绝）
    expect(decision).toBe('');
  });

  it('keyCode=229 的 Enter（旧 IME 兼容路径）→ 同样不产生任何决策', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
    pressKey({ key: 'Enter', keyCode: 229 });
    expect(decision).not.toBe('allow-once');
    expect(decision).toBe('');
  });

  it('isComposing=false 的 Enter → 拒绝（不是允许一次）', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
    pressKey({ key: 'Enter', isComposing: false });
    expect(decision).toBe('deny');
    expect(decision).not.toBe('allow-once');
  });

  it('Escape → 拒绝（行为不变）', () => {
    let decision = '';
    mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
    pressKey({ key: 'Escape' });
    expect(decision).toBe('deny');
  });

  it('「允许一次」仍可显式真实手势获得（键盘改绑不影响鼠标路径）', () => {
    let decision = '';
    const cap = captureButtonClicks();
    try {
      mkHandle({ tool: 'chat-send' }, (r) => { decision = r.decision; });
      cap.handlers.get('ds-consent-allow-once')!(cap.trustedEvent());
    } finally {
      cap.stop();
    }
    expect(decision).toBe('allow-once');
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

  it('新 consent 到来时排队而非拒绝，当前模态结束后再展示', () => {
    let firstDecision = '';
    const cap = captureButtonClicks(); // spy 跨两个模态保持：第二条渲染时会覆盖 handlers 同名键
    try {
      const first = mkHandle({ tool: 'shell.exec' }, (r) => { firstDecision = r.decision; });
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);
      expect(document.querySelector('.ds-consent-card')?.textContent).toContain('执行终端命令');

      let secondDecision = '';
      const second = mkHandle({ tool: 'memory.save' }, (r) => { secondDecision = r.decision; });

      // 新请求排队，不取消正在等待的旧请求。
      expect(firstDecision).toBe('');
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);
      expect(document.querySelector('.ds-consent-card')?.textContent).toContain('执行终端命令');

      // 第一条结算后，第二条自动展示（R2-01：真实手势 trustedClick）。
      cap.handlers.get('ds-consent-allow-once')!(cap.trustedEvent());
      expect(firstDecision).toBe('allow-once');
      expect(document.querySelector('.ds-consent-card')?.textContent).toContain('保存记忆');

      cap.handlers.get('ds-consent-allow-once')!(cap.trustedEvent());
      expect(secondDecision).toBe('allow-once');
      second.dispose();
      first.dispose();
    } finally {
      cap.stop();
    }
  });
});

describe('T9-2：单一活动模态并发边界（PM T8-2 rework 覆盖）', () => {
  it('三条连续 showConsent → 逐条展示、逐条决策，不互相取消', () => {
    const decisions: string[] = [];
    const h1 = mkHandle({ tool: 'shell.exec' }, (d) => decisions.push('h1:' + d.decision));
    const h2 = mkHandle({ tool: 'memory.save' }, (d) => decisions.push('h2:' + d.decision));
    const h3 = mkHandle({ tool: 'chat-send' }, (d) => decisions.push('h3:' + d.decision));

    // 只有第一条展示，后两条排队。
    expect(decisions).toEqual([]);
    // DOM 严格只有 1 个 overlay
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);
    expect(document.querySelector('.ds-consent-card')?.textContent).toContain('执行终端命令');

    h1.decide('allow-once');
    expect(decisions).toEqual(['h1:allow-once']);
    expect(document.querySelector('.ds-consent-card')?.textContent).toContain('保存记忆');

    h2.decide('deny');
    expect(decisions).toEqual(['h1:allow-once', 'h2:deny']);
    expect(document.querySelector('.ds-consent-card')?.textContent).toContain('发送对话');

    h3.decide('allow-once');
    expect(decisions).toEqual(['h1:allow-once', 'h2:deny', 'h3:allow-once']);
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);
  });

  it('排队请求 dispose() 不回调，也不影响当前模态', () => {
    const decisions: string[] = [];
    const h1 = mkHandle({ tool: 'shell.exec' }, (d) => decisions.push('h1:' + d.decision));
    const h2 = mkHandle({ tool: 'memory.save' }, (d) => decisions.push('h2:' + d.decision));

    h2.dispose();
    expect(decisions).toEqual([]);
    expect(document.querySelector('.ds-consent-card')?.textContent).toContain('执行终端命令');

    h1.decide('allow-once');
    expect(decisions).toEqual(['h1:allow-once']);
    expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);
  });

  it('排队期间不计时，超时从真正展示时开始', () => {
    vi.useFakeTimers();
    try {
      const decisions: string[] = [];
      const h1 = mkHandle({ tool: 'shell.exec', timeoutMs: 1000 }, (d) => decisions.push('h1:' + d.decision));
      mkHandle({ tool: 'memory.save', timeoutMs: 1000 }, (d) => decisions.push('h2:' + d.decision));

      vi.advanceTimersByTime(800);
      expect(decisions).toEqual([]);

      h1.decide('allow-once');
      expect(decisions).toEqual(['h1:allow-once']);

      vi.advanceTimersByTime(800);
      expect(decisions).toEqual(['h1:allow-once']);

      vi.advanceTimersByTime(300);
      expect(decisions).toEqual(['h1:allow-once', 'h2:deny']);
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('决策回调抛错不卡死队列', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const decisions: string[] = [];
      const h1 = mkHandle({ tool: 'shell.exec' }, () => { throw new Error('boom'); });
      const h2 = mkHandle({ tool: 'memory.save' }, (d) => decisions.push('h2:' + d.decision));

      expect(() => h1.decide('allow-once')).not.toThrow();
      expect(document.querySelector('.ds-consent-card')?.textContent).toContain('保存记忆');

      h2.decide('allow-once');
      expect(decisions).toEqual(['h2:allow-once']);
    } finally {
      errorSpy.mockRestore();
    }
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
      received = d.decision;
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
      const h1 = mkHandle({ tool: 'shell.exec', timeoutMs: 1000 }, (r) => { h1Decision = r.decision; });
      void h1; // side-effect 即触发 setTimeout
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(1);

      // 推进到超时
      vi.advanceTimersByTime(1100);
      expect(h1Decision).toBe('deny');
      // 超时后 timer 被清理，overlay 被移除
      expect(document.querySelectorAll('.ds-consent-overlay').length).toBe(0);

      // 之后新请求能正常展示（证明旧 timer 没残留、不误杀新请求）
      let h2Decision = '';
      const h2 = mkHandle({ tool: 'memory.save', timeoutMs: 5000 }, (r) => { h2Decision = r.decision; });
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
