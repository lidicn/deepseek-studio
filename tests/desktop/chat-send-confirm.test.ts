// @vitest-environment jsdom
/**
 * R2-C2 回归：chat-send 的 Enter 回退不得「未经验证即报成功」。
 *
 * 缺陷机理（修复前）：
 *   策略 4 对输入框合成 Enter 后**无条件** return { ok:true, sent:true, via:'enter-key' }，
 *   不检查输入框是否被清空、是否产生新消息。React 受控输入常忽略合成 Enter，
 *   此时消息根本没发出，工具却报成功 → AgentLoop 据此继续续跑，实为静默退化。
 *
 * 本用例：页面只有输入框、无任何发送按钮 → 走 Enter 回退。
 *   修复前：合成 Enter 后输入框内容未变，却返回 ok:true。
 *   修复后：输入框未清空 → ok:false, error:'send-unconfirmed'。
 */

import { describe, it, expect } from 'vitest';
import { createChatSendCapability } from '../../src/capabilities/chat-send';

/** jsdom 下 offsetWidth 恒为 0，findInput 会跳过；stub 之以便触达 Enter 回退。 */
function makeVisible(el: HTMLElement): void {
  Object.defineProperty(el, 'offsetWidth', { value: 100, configurable: true });
}

describe('chat-send 发送确认（R2-C2 回归）', () => {
  it('无按钮 + 合成 Enter 未清空输入框 → 必须 ok:false，不得假成功', async () => {
    document.body.innerHTML = '<textarea id="chat-input">hello world</textarea>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    makeVisible(ta);

    const r = await createChatSendCapability().execute({});

    expect(r.ok).toBe(false);
    expect(r.error).toBe('send-unconfirmed');
  });

  it('合成 Enter 后输入框确被清空 → 视为发送成功（不误伤真实成功路径）', async () => {
    document.body.innerHTML = '<textarea id="chat-input">hi</textarea>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    makeVisible(ta);
    // 模拟站点自身发送处理器：收到 Enter 后清空输入框
    ta.addEventListener('keydown', () => {
      ta.value = '';
    });

    const r = await createChatSendCapability().execute({});

    expect(r.ok).toBe(true);
    expect((r.data as { via?: string }).via).toBe('enter-key');
  });
});
