// @vitest-environment jsdom
/**
 * F1：chat-read 重做后的 DOM 行为（20261031）
 *
 * 覆盖三条真机结论：
 *   1. 现网是**虚拟列表**（`.ds-virtual-list > .ds-virtual-list-items >
 *      .ds-virtual-list-visible-items > <消息项>`），旧选择器 0 命中；
 *   2. 返回必须带 **session / 消息标识**（协议层要能对账「这段文本属于哪一轮」）；
 *   3. **fail-closed**：读不到非空文本必须 ok:false，绝不「ok:true + 空」，
 *      否则宿主把空串当基线 → 空转到 120s → 对外 500 timeout（C1 实测 128.8s / 208.1s）。
 */

import { createChatReadCapability } from '../../src/capabilities/chat-read';

describe('chat-read F1：虚拟列表 + 标识 + fail-closed', () => {
  it('1. 虚拟列表结构能读到消息并返回 sessionId / 消息 id', async () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="ds-virtual-list">
          <div class="ds-virtual-list-items">
            <div class="ds-virtual-list-visible-items">
              <div class="_81e7b5e"><div class="_72b6158">上一轮答案</div></div>
              <div class="_81e7b5e"><div class="_72b6158">本轮答案</div></div>
            </div>
          </div>
        </div>
      </div>`;
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(true);
    const data = r.data as {
      sessionId: string;
      count: number;
      messages: { role: string; text: string; id: string; index: number }[];
    };
    expect(data.count).toBe(2);
    expect(data.messages.map((m) => m.text)).toEqual(['上一轮答案', '本轮答案']);
    // 标识：每条消息都要有 id，id 里带会话标识
    expect(data.messages.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
    expect(data.messages[0].index).toBe(0);
    expect(data.messages[1].index).toBe(1);
  });

  it('2. 旧结构仍兼容（回归）', async () => {
    document.body.innerHTML =
      '<div id="chat-container"><div class="message-item user">你好</div><div class="message-item assistant">我是助手</div></div>';
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(true);
    const data = r.data as { count: number; messages: { role: string; text: string }[] };
    expect(data.messages.length).toBe(2);
    expect(data.messages[0].role).toBe('user');
    expect(data.messages[1].role).toBe('assistant');
  });

  it('3. fail-closed：命中节点但没有非空文本 → no-messages-found（不是 ok:true + 空）', async () => {
    document.body.innerHTML =
      '<div class="ds-virtual-list"><div class="ds-virtual-list-items"><div class="ds-virtual-list-visible-items"><div class="_81e7b5e"></div></div></div></div>';
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-messages-found');
  });

  it('4. fail-closed：完全命中不到 → no-messages-found', async () => {
    document.body.innerHTML = '<div id="chat-container"></div>';
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-messages-found');
  });

  it('5. ensureLatest：把可滚容器滚到底部（虚拟列表只挂载视口内项）', async () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="ds-virtual-list" style="overflow:auto">
          <div class="ds-virtual-list-items"><div class="ds-virtual-list-visible-items">
            <div class="_81e7b5e"><div class="_72b6158">答案</div></div>
          </div></div>
        </div>
      </div>`;
    const list = document.querySelector('.ds-virtual-list') as HTMLElement;
    // jsdom 没有真实布局，手动伪造可滚状态
    Object.defineProperty(list, 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 800, configurable: true });

    const r = await createChatReadCapability().execute({ ensureLatest: true });
    expect(r.ok).toBe(true);
    expect(list.scrollTop).toBe(5000);
  });

  it('6. 消息项里取「文本量最大的后代」作为正文（气泡是独立子节点）', async () => {
    document.body.innerHTML = `
      <div class="ds-virtual-list"><div class="ds-virtual-list-items"><div class="ds-virtual-list-visible-items">
        <div class="_81e7b5e">
          <div class="_72b6158">用户气泡（含记忆注入块，很长）</div>
          <div class="ef46fbc6"></div>
        </div>
      </div></div></div>`;
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(true);
    const data = r.data as { messages: { text: string }[] };
    expect(data.messages[0].text).toBe('用户气泡（含记忆注入块，很长）');
  });

  it('7. 真机场景：虚拟列表只挂老用户消息时，答案从 Studio 镜像取到', async () => {
    // 真机复验现场：挂载的 3 条全是 user（含能力前导注入），答案不在 DOM
    document.body.innerHTML = `
      <div id="root">
        <div class="ds-virtual-list"><div class="ds-virtual-list-items"><div class="ds-virtual-list-visible-items">
          <div class="_81e7b5e"><div class="_72b6158">[studio-tool-capability] ## 角色 说明很长</div></div>
          <div class="_81e7b5e"><div class="_72b6158">[studio-tool-capability] ## 角色 说明很长</div></div>
        </div></div></div>
        <div class="ds-sc-message-list">
          <div class="ds-sc-msg-assistant ds-sc-msg-main-bot"><div class="ds-sc-markdown">F1V3-MVWH</div></div>
        </div>
      </div>`;
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(true);
    const data = r.data as {
      messages: { text: string; injected: boolean }[];
      mirror: { count: number; lastAssistantText: string };
    };
    // 用户气泡被标成 injected（不是对话内容）
    expect(data.messages.every((m) => m.injected === true)).toBe(true);
    // 答案从镜像来
    expect(data.mirror.count).toBe(1);
    expect(data.mirror.lastAssistantText).toBe('F1V3-MVWH');
  });
});
