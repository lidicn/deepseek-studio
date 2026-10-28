import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r5-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

/**
 * QD-R5-01：首轮断流自动重试回归。
 *
 * 背景：续跑路径（autoContinueWithPow）早有 errorRetryCount + 指数退避，但首轮请求
 * 失败只 appendError 就结束。用户网络偶发抖动时每一轮都要手动重发——这正是
 * 「满屏 stream-incomplete / 服务器暂时无法访问」的成因。
 *
 * 复现件来源：2026-10-23 用户实机报告「刚启动 studio 所有对话都刷这个报错」。
 *
 * 本文件证明三件事：
 *   1. 首轮 network-error 会在 FIRST_ATTEMPT_MAX_RETRIES(2) 次内自动重发；
 *   2. 无完成哨兵的截断流同样自动重试，而不是直接报 stream-incomplete；
 *   3. 致命错误（401）一次都不重试，保持 fail-closed。
 */

// 本文件需要 DOM（XMLHttpRequest.prototype hook + window.fetch）。
// @vitest-environment jsdom

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

/** DeepSeek 真实完成哨兵（实测抓包无 data: [DONE]）。 */
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
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: ((...a: unknown[]) => void) | null = null;
    url = '';
    body: string | null = null;
    constructor() { FakeXHR.instances.push(this); }
    open(_m: string, u: string | URL) { this.url = String(u); this.readyState = 1; }
    setRequestHeader() { /* noop */ }
    send(body?: string | null) { this.body = typeof body === 'string' ? body : null; }
    respond(status: number, text: string) {
      this.status = status; this.responseText = text; this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
    }
    abort() { this.status = 0; this.responseText = ''; this.readyState = 4; this.onreadystatechange?.(); }
  };
}

function makeChatUI() {
  return {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    appendToAssistantMessage: vi.fn(),
    appendReasoning: vi.fn(),
    finishAssistantMessage: vi.fn(),
    appendError: vi.fn(),
    setBusy: vi.fn(),
    setContextNotice: vi.fn(),
    startToolCard: vi.fn(() => true),
    finishToolCard: vi.fn(),
  };
}

function installHarness() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
  });
  const chatUI = makeChatUI();
  const diagLines: string[] = [];
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: (line) => diagLines.push(line),
  });
  return { FakeXHR, handle, sender, chatUI, diagLines };
}

function pageSend(FakeXHR: ReturnType<typeof makeFakeXhrClass>, body: Record<string, unknown>) {
  const xhr = new FakeXHR();
  xhr.open('POST', CHAT_URL);
  xhr.onreadystatechange = () => {};
  xhr.send(JSON.stringify(body));
  return xhr;
}

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

describe('QD-R5-01 首轮断流自动重试', () => {
  it('首轮 network-error 自动重发，最多 2 次后停下并告知已重试', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'hello', chat_session_id: 's-net' });
      first.respond(0, '');
      // 触发 XHR 的 readyState=4 结算路径。
      // 退避是 errorBackoffMs(0)=2s+抖动，0ms 只够跑完结算、不够触发重发。
      await vi.advanceTimersByTimeAsync(5_000);

      // 修复前：这里只有 1 个请求，用户看到「本轮不会自动重发」。
      expect(chatRequests(FakeXHR)).toHaveLength(2);
      expect(diagLines.some((l) => l.includes('first-attempt retryable'))).toBe(true);
      expect(diagLines.some((l) => l.includes('first-attempt retry: resend'))).toBe(true);

      // 第 2 次（重试#1）也失败 → 重试#2
      chatRequests(FakeXHR)[1].respond(0, '');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(chatRequests(FakeXHR)).toHaveLength(3);

      // 第 3 次（重试#2）也失败 → 预算耗尽，停止
      chatRequests(FakeXHR)[2].respond(0, '');
      await vi.advanceTimersByTimeAsync(30_000);
      // 不再有第 4 个请求。
      expect(chatRequests(FakeXHR)).toHaveLength(3);

      const messages = chatUI.appendError.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes('正在自动重试'))).toBe(true);
      expect(messages.some((m) => m.includes('已自动重试 2 次仍失败'))).toBe(true);
      expect(chatUI.setBusy).toHaveBeenCalledWith(false);

    // 重发必须原样重发用户这一轮：不能套 <original_task>/<tool_results>
    // （那是「工具续跑」的 prompt，首轮失败时还没有任何工具结果）。
    const resendBody = JSON.parse(String(chatRequests(FakeXHR)[1].body)) as { prompt?: string };
    expect(resendBody.prompt ?? '').not.toContain('<original_task>');
    expect(resendBody.prompt ?? '').toContain('hello');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('无完成哨兵的截断流也走自动重试', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'tell me a story', chat_session_id: 's-cut' });
      first.respond(200, sseText('很久很久以前'));
      // 同上：要等过 2s 退避才看得到重发请求。
      await vi.advanceTimersByTimeAsync(5_000);

      // 修复前：直接 appendError('stream-incomplete') 且只有 1 个请求。
      expect(chatRequests(FakeXHR)).toHaveLength(2);
      const messages = chatUI.appendError.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes('正在自动重试'))).toBe(true);

      // 重试后带哨兵 → 正常完成，不应再报错。
      chatRequests(FakeXHR)[1].respond(200, sseText('完整故事') + sseDone());
      await vi.advanceTimersByTimeAsync(10_000);
      const after = chatUI.appendError.mock.calls.map((c) => c[1] as string);
      expect(after.some((m) => m.includes('本轮不会自动重试'))).toBe(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('致命错误（401）不重试，保持 fail-closed', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'hi', chat_session_id: 's-401' });
      first.respond(401, 'unauthorized');
      await vi.advanceTimersByTimeAsync(30_000);

      expect(chatRequests(FakeXHR)).toHaveLength(1);
      const messages = chatUI.appendError.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes('正在自动重试'))).toBe(false);
      expect(messages.some((m) => m.includes('本轮消息不会自动重发'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('用户点停止后不重试（abort 优先于重试预算）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run and stop', chat_session_id: 's-abort' });
      first.abort();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(chatRequests(FakeXHR)).toHaveLength(1);
      const messages = chatUI.appendError.mock.calls.map((c) => c[1] as string);
      expect(messages.some((m) => m.includes('正在自动重试'))).toBe(false);
      expect(chatUI.appendError.mock.calls).toEqual([]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
