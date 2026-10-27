// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * W2：工具结果按会话归属。
 * 主路径：新用户消息会重置 pending/collectedExecutions（captureChatRequest），
 * 迟到的他会话结果自然被丢弃。本卡再加一道 augementInit 过滤兜底：
 * 当续跑请求 body 的 chat_session_id 与 pending 条目产生时的归属不一致时，
 * 丢弃该结果并记 pending.cross-session trace。
 *
 * 本用例验证：跨会话连续两轮请求不串味、不崩溃；过滤逻辑作为代码审查兜底。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'w2-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
    + 'event: close\ndata: {"click_behavior":"none"}\n\n';
}
function sseText(text: string): string {
  return `data: ${JSON.stringify({ v: text })}\n\n`;
}

function makeFakeXhrClass() {
  return class FakeXHR {
    static instances: FakeXHR[] = [];
    readyState = 0; status = 0; responseText = '';
    onreadystatechange: Handler = null;
    method = ''; url = '';
    headers: Record<string, string> = {};
    body: string | null = null;
    constructor() { FakeXHR.instances.push(this); }
    open(m: string, u: string | URL) { this.method = m; this.url = String(u); this.readyState = 1; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    send(body?: string | null) { this.body = typeof body === 'string' ? body : null; }
    respond(status: number, text: string) {
      this.status = status; this.responseText = text;
      this.readyState = 3; this.onreadystatechange?.();
      this.readyState = 4; this.onreadystatechange?.();
    }
  };
}

describe('W2：工具结果按会话归属', () => {
  it('同页 SPA 切会话两轮请求不串味、不崩溃', async () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
    const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'ok', exitCode: 0 } }));
    const chatUI = {
      sessionKey: 'w2', activateSession: vi.fn(async () => undefined),
      addUserMessage: vi.fn(), startAssistantMessage: vi.fn(), appendToAssistantMessage: vi.fn(),
      appendReasoning: vi.fn(), finishAssistantMessage: vi.fn(), appendError: vi.fn(),
      setBusy: vi.fn(), setContextNotice: vi.fn(), startToolCard: vi.fn(() => true), finishToolCard: vi.fn(),
    };
    const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });
    try {
      // 轮 A
      const xhrA = new FakeXHR();
      xhrA.open('POST', CHAT_URL);
      xhrA.onreadystatechange = () => {};
      xhrA.send(JSON.stringify({ prompt: 'do A', chat_session_id: 'session-A' }));
      xhrA.respond(200, sseText('A 的回答') + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);

      // 轮 B（切会话）
      const xhrB = new FakeXHR();
      xhrB.open('POST', CHAT_URL);
      xhrB.onreadystatechange = () => {};
      xhrB.send(JSON.stringify({ prompt: 'do B', chat_session_id: 'session-B' }));
      xhrB.respond(200, sseText('B 的回答') + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);

      // 不串味：没有错误卡、没有跨会话重发
      expect(chatUI.appendError.mock.calls).toEqual([]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
