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

  // N3-02 B：**React 的异步清空不得误判成 send-unconfirmed**。
  //
  // 站点真实路径是 onKeyDown 里 setState → 下一次渲染才把 value 写回 ''，
  // 所以「按下 Enter 之后同步读」必然读到旧值。改前那条同步读 + web-engine 的重试
  // ＝ 同一条消息发两遍（用户看得见的重复）。
  //
  // 判别力：把 chat-send 里的 `await sleep(50)` 删掉（退回同步读）→ 本条红。
  it('N3-02 B：站点在下一个宏任务才清空输入框 → 仍判发送成功', async () => {
    document.body.innerHTML = '<textarea id="chat-input">hi</textarea>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    makeVisible(ta);
    // 异步清空（模拟 React 受控输入在下一帧写回）
    ta.addEventListener('keydown', () => {
      setTimeout(() => { ta.value = ''; }, 0);
    });

    const r = await createChatSendCapability().execute({});

    expect(r.ok).toBe(true);
    expect((r.data as { via?: string }).via).toBe('enter-key');
  });

  // N3-02 B：**禁用态的发送按钮不能算发送成功**。
  // `clickElement` 不查 disabled（点了就 return true），改前点一个灰按钮照样 ok:true
  // ＝ 什么都没发却报成功，AgentLoop 接着等一条永远不来的回复。
  it('N3-02 B：圆形按钮 aria-disabled=true → 不得假成功（落到 Enter 回退）', async () => {
    document.body.innerHTML = `
      <div>
        <textarea id="chat-input">hi</textarea>
        <div class="ds-button--circle" role="button" aria-disabled="true"></div>
      </div>`;
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    makeVisible(ta);
    const btn = document.querySelector('.ds-button--circle') as HTMLElement;
    makeVisible(btn);
    let clicked = 0;
    btn.addEventListener('click', () => { clicked++; });

    const r = await createChatSendCapability().execute({});

    // 灰色按钮不许点：点了也不算发送成功。
    expect(clicked).toBe(0);
    // 且因为输入框没被清空，Enter 回退同样判 send-unconfirmed（不假成功）。
    expect(r.ok).toBe(false);
  });

  // N3-02 后续卡：**空输入框按 Enter 什么都没发，不得报 sent**。
  //
  // 改前：`before.length === 0` 与「已清空」同走 `ok:true` 分支 —— 空框报成功，
  // 宿主据此去等一条永远不来的回复（静默挂死）。这是「假成功」的另一副面孔：
  // 不是「发失败报成功」，而是「根本没东西可发也报成功」。
  //
  // 判别力：把 `if (before.length === 0) return { ok:false, error:'input-empty' }`
  // 删掉（退回原来的 `before.length === 0 || ...` 分支）→ 本条红（ok 变 true）。
  it('N3-02 后续：输入框为空 → ok:false/input-empty，且不许按 Enter', async () => {
    document.body.innerHTML = '<textarea id="chat-input"></textarea>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    makeVisible(ta);
    let enterPressed = 0;
    ta.addEventListener('keydown', () => { enterPressed++; });

    const r = await createChatSendCapability().execute({});

    expect(r.ok).toBe(false);
    expect(r.error).toBe('input-empty');
    // 空框连 Enter 都不该按：按了也不会发出去，只是给站点塞一个空提交。
    expect(enterPressed).toBe(0);
  });
});
