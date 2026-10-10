// @vitest-environment jsdom
/**
 * 真实能力 chat-read/insert/send 的 DOM 行为测试（v0.3.3）
 *
 * 防御式：元素缺失返回结构化错误码，不崩溃、不抛异常。选择器多候选回退。
 */

import { createChatReadCapability } from '../../src/capabilities/chat-read';
import { createChatInsertCapability } from '../../src/capabilities/chat-insert';
import { createChatSendCapability } from '../../src/capabilities/chat-send';

describe('chat 能力（DOM）', () => {
  it('chat-read 读取消息', async () => {
    document.body.innerHTML =
      '<div id="chat-container"><div class="message-item user">你好</div><div class="message-item assistant">我是助手</div></div>';
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(true);
    expect((r.data as { messages: { length: number }[] }).messages.length).toBe(2);
  });

  it('chat-read 无消息 → no-messages-found', async () => {
    document.body.innerHTML = '<div id="chat-container"></div>';
    const r = await createChatReadCapability().execute({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-messages-found');
  });

  it('chat-insert 写入输入框', async () => {
    document.body.innerHTML = '<textarea id="chat-input"></textarea>';
    const r = await createChatInsertCapability().execute({ text: 'hello' });
    expect(r.ok).toBe(true);
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('chat-insert 缺 text → missing-text', async () => {
    document.body.innerHTML = '<textarea id="chat-input"></textarea>';
    const r = await createChatInsertCapability().execute({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing-text');
  });

  it('chat-insert 无输入框 → input-not-found', async () => {
    document.body.innerHTML = '';
    const r = await createChatInsertCapability().execute({ text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('input-not-found');
  });

  it('chat-send 点击发送', async () => {
    let clicked = false;
    const btn = document.createElement('button');
    btn.className = 'send-button';
    btn.addEventListener('click', () => {
      clicked = true;
    });
    document.body.append(btn);
    const r = await createChatSendCapability().execute({});
    expect(r.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it('chat-send 无按钮 → send-button-not-found', async () => {
    document.body.innerHTML = '';
    const r = await createChatSendCapability().execute({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('send-button-not-found');
  });
});
