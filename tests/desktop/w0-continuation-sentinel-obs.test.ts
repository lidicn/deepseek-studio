// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * W0：续跑轮哨兵观测。
 *
 * 断言续跑 XHR readyState===4 时落一条 continuation.stream trace，
 * sawSentinel 反映本轮续跑响应是否真正带完成哨兵。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'w0-stub' })),
}));

import { installMainWorldInterceptor, interceptorTraceSnapshot } from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
    + 'event: close\ndata: {"click_behavior":"none"}\n\n';
}
function sseText(text: string): string {
  return `data: ${JSON.stringify({ v: text })}\n\n`;
}
function sseTool(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo hi\\"}</shell_exec>"}]}\n\n';
}

function makeFakeXhrClass() {
  return class FakeXHR {
    static instances: FakeXHR[] = [];
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: Handler = null;
    method = '';
    url = '';
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
    abort() { this.status = 0; this.readyState = 4; this.onreadystatechange?.(); }
  };
}

function installHarness() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'hi', exitCode: 0 } }));
  const chatUI = {
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
  const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });
  return { FakeXHR, handle, sender, chatUI };
}

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

describe('W0：续跑轮哨兵观测', () => {
  it('续跑响应带完成哨兵 → continuation.stream sawSentinel=true', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      const first = new FakeXHR();
      first.open('POST', CHAT_URL);
      first.onreadystatechange = () => {};
      first.send(JSON.stringify({ prompt: 'hi', chat_session_id: 'w0-ok' }));
      // 首轮带工具调用 → 触发续跑
      first.respond(200, sseTool() + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);

      const requests = chatRequests(FakeXHR);
      // 第 2 条 = 续跑
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const continuation = requests[1];
      continuation.respond(200, sseText('继续回答') + sseDone());
      await vi.advanceTimersByTimeAsync(5_000);

      const events = interceptorTraceSnapshot().filter((e) => e.t === 'continuation.stream');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.at(-1)).toMatchObject({ sawSentinel: true, status: 200 });
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('续跑响应被截断 → continuation.stream sawSentinel=false', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      const first = new FakeXHR();
      first.open('POST', CHAT_URL);
      first.onreadystatechange = () => {};
      first.send(JSON.stringify({ prompt: 'hi', chat_session_id: 'w0-trunc' }));
      first.respond(200, sseTool() + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);

      const requests = chatRequests(FakeXHR);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      requests[1].respond(200, sseText('只说了半句')); // 无完成哨兵
      await vi.advanceTimersByTimeAsync(5_000);

      const events = interceptorTraceSnapshot().filter((e) => e.t === 'continuation.stream');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.at(-1)).toMatchObject({ sawSentinel: false, status: 200 });
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
