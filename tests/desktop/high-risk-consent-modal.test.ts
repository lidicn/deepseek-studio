// @vitest-environment jsdom
/**
 * 卡 I（2026-11-09）· 高风险确认页内模态（观感层）
 *
 * 锁定四件事：
 * ① 高风险请求（meta 事实字段 outside/hardRule/riskFlags 命中）在**页内 Studio 风格模态**中
 *    呈现：危险外观（data-risk="high"）＋「高风险」徽标＋「风险：…」原因行＋档位与规范目标
 *    显形＋三按钮集（允许一次 / 拒绝 / 本次对话始终允许；always 类不渲染「本次会话允许」）；
 * ② 呈现层「高风险」判定只认事实字段——展示字段（riskLabel/riskFlagLabels）不劫持判定
 *    （#35 判据的呈现层镜像）；
 * ③ 风险原因行拼装：四字段组装·去重保序·高风险空 parts 兜底「高风险操作」；
 * ④ 「本次对话始终允许」与全部 allow 动作：合成事件（isTrusted=false）不产生回执，
 *    真实手势回执带回原 nonce（卡 I 高风险三按钮的回归锁）。
 *
 * 红态证明（交卷附 RED 原文，81 枚 PRE=POST）：把 `isHighRiskPresentation` 改回恒 false ⇒
 * ①②③ 转红。负控不改生产源后还原，还原后源文件锚逐字节同。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetConsentQueueForTests,
  describeRiskReason,
  isHighRiskPresentation,
  showConsent,
  type ConsentCallback,
  type ConsentHandle,
  type ConsentRequest,
} from '../../src/ui/consent';

afterEach(() => {
  __resetConsentQueueForTests();
  document.querySelectorAll('.ds-consent-overlay, .ds-consent-card').forEach((el) => el.remove());
  document.body.textContent = '';
  // 样式节点随用例清理：③ 的渲染失败负控依赖「style 不存在 ⇒ ensureStyles 走 appendChild」
  document.getElementById('ds-consent-style')?.remove();
});

function mkHandle(
  request: Omit<ConsentRequest, 'nonce'> & { nonce?: string },
  onDecision: ConsentCallback,
): ConsentHandle {
  return showConsent({ nonce: 'n-test', ...request }, onDecision);
}

/**
 * 与 consent.test.ts 同款（该文件本地 helper，不导出，这里同法复制）：
 * jsdom 造不出 isTrusted=true 事件 ⇒ 在 HTMLButtonElement.prototype.addEventListener 上挂
 * spy，捕获实现侧挂在按钮上的**真实 click 监听器**，再用 isTrusted=true 的最小事件对象
 * 直接调用（守卫只读 e.isTrusted）。
 */
interface ClickCaptures {
  handlers: Map<string, (e: Event) => void>;
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
    trustedEvent: () => ({ isTrusted: true } as unknown as Event),
    stop: () => spy.mockRestore(),
  };
}

describe('卡 I · 高风险页内模态（观感层）', () => {
  it('① 高风险请求在页内模态呈现：危险外观＋高风险徽标＋风险原因行＋档位/目标显形＋三按钮集', () => {
    const handle = mkHandle(
      {
        tool: 'shell.exec',
        params: { command: 'rm -rf E:/NAS/x' },
        meta: {
          riskFlags: ['recursive-delete'],
          riskFlagLabels: ['递归删除'],
          outside: true,
          riskLabel: '特权级',
          modeLabel: '完全放开',
          canonicalTarget: 'E:\\NAS\\x',
          approvalClass: 'always',
          hideAllowSession: true,
          allowConversation: true,
        },
      },
      () => {},
    );
    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    expect(card.dataset.risk).toBe('high');
    const text = card.textContent ?? '';
    // 高风险徽标（chip）
    expect(document.querySelector('.ds-consent-badge[data-level="high-risk"]')?.textContent).toBe('高风险');
    // 风险原因行：越界＋命中风险模式（riskLabel 同去重）
    expect(text).toContain('风险：越出工作区');
    expect(text).toContain('递归删除');
    expect(text).toContain('特权级');
    // 档位与规范目标显形（原生框做不到的两栏）
    expect(text).toContain('完全放开');
    expect(text).toContain('E:\\NAS\\x');
    // 工具自然语言显示名（不裸奔协议名）
    expect(text).toContain('执行终端命令');
    expect(text).not.toContain('shell.exec');
    // 三按钮集：允许一次＋拒绝＋本次对话始终允许；always 类（hideAllowSession）不渲染会话按钮
    expect(document.querySelector('.ds-consent-allow-once')).not.toBeNull();
    expect(document.querySelector('.ds-consent-deny')).not.toBeNull();
    expect(document.querySelector('.ds-consent-allow-conversation')).not.toBeNull();
    expect(document.querySelector('.ds-consent-allow-session')).toBeNull();
    handle.dispose();
  });

  it('② 「高风险」判定只认事实字段：展示字段（riskLabel/riskFlagLabels）不劫持判定', () => {
    expect(isHighRiskPresentation(undefined)).toBe(false);
    expect(isHighRiskPresentation({})).toBe(false);
    expect(isHighRiskPresentation({ riskLabel: '特权级', riskFlagLabels: ['递归删除'] })).toBe(false);
    expect(isHighRiskPresentation({ allowedGrantScopes: ['session'] })).toBe(false); // 形态字段不是判据
    expect(isHighRiskPresentation({ outside: true })).toBe(true);
    expect(isHighRiskPresentation({ hardRule: 'deny-rm-rf' })).toBe(true);
    expect(isHighRiskPresentation({ riskFlags: ['recursive-delete'] })).toBe(true);
    expect(isHighRiskPresentation({ riskFlags: [] })).toBe(false);

    // 渲染层对照：只有展示字段的请求 → 无危险外观、无「高风险」chip，但原因行仍展示内容
    const handle = mkHandle({ tool: 'shell.exec', meta: { riskLabel: '特权级' } }, () => {});
    const card = document.querySelector('.ds-consent-card') as HTMLElement;
    expect(card.dataset.risk).toBeUndefined();
    const text = card.textContent ?? '';
    expect(text).toContain('风险：特权级');
    expect(text).not.toContain('高风险');
    handle.dispose();
  });

  it('③ 风险原因行拼装：四字段组装·去重保序·高风险空 parts 兜底「高风险操作」', () => {
    expect(
      describeRiskReason({ outside: true, hardRule: 'deny-rm-rf', riskLabel: '特权级', riskFlagLabels: ['递归删除', '特权级'] }),
    ).toBe('越出工作区 · 命中硬拒规则(deny-rm-rf) · 特权级 · 递归删除');
    expect(describeRiskReason({ riskFlags: ['recursive-delete'] })).toBe('高风险操作');
    expect(describeRiskReason({ riskFlags: ['x'], riskFlagLabels: [] })).toBe('高风险操作');
    expect(describeRiskReason({ riskLabel: '特权级', riskFlagLabels: ['递归删除'] })).toBe('特权级 · 递归删除');
    expect(describeRiskReason({ hardRule: '' })).toBe('');
    expect(describeRiskReason(undefined)).toBe('');
    expect(describeRiskReason({})).toBe('');
  });

  it('④ 「本次对话始终允许」真实手势 → allow-conversation 回执带原 nonce；合成点击不回执', () => {
    let receipt: { decision: string; nonce?: string } | undefined;
    const cap = captureButtonClicks();
    try {
      mkHandle(
        {
          tool: 'memory.purge',
          params: { id: 'm-1' },
          meta: {
            riskFlags: ['memory-purge'],
            riskFlagLabels: ['不可恢复'],
            modeLabel: '完全放开',
            approvalClass: 'always',
            hideAllowSession: true,
            allowConversation: true,
          },
        },
        (r) => {
          receipt = r;
        },
      );
      // 负控：jsdom 原生 .click() 的 isTrusted 恒 false ⇒ 不产生回执
      (document.querySelector('.ds-consent-allow-conversation') as HTMLButtonElement).click();
      expect(receipt).toBeUndefined();
      // 真实手势 ⇒ 回执（nonce 原样带回）
      cap.handlers.get('ds-consent-allow-conversation')!(cap.trustedEvent());
    } finally {
      cap.stop();
    }
    expect(receipt?.decision).toBe('allow-conversation');
    expect(receipt?.nonce).toBe('n-test');
  });

  it('⑤ 页内模态渲染失败 → 立即 deny（fail-closed：不留 pending、不静默放行）', () => {
    document.getElementById('ds-consent-style')?.remove();
    const spy = vi.spyOn(document.head, 'appendChild').mockImplementation(() => {
      throw new Error('page broken');
    });
    let decision = '';
    try {
      mkHandle({ tool: 'chat-send', nonce: 'n-fail' }, (r) => {
        decision = r.decision;
      });
      // 同步 fail-closed（不等 60s 超时）；页面上没有任何残留浮层
      expect(decision).toBe('deny');
      expect(document.querySelector('.ds-consent-overlay')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
