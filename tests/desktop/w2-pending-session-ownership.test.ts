// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * R-W2：工具结果按会话归属（续跑注入路径真复现）。
 *
 * 时序：
 *  1. A 会话发起请求，SSE 带工具调用，sender 挂起不 resolve。
 *  2. B 会话新用户消息到达（captureChatRequest 重置 newChatSessionId=B）。
 *  3. A 的 sender 才 resolve → pending.push 一条 sessionId=A 的结果。
 *  4. B 会话再发一条请求 → prepareOutgoingBody 应识别 currentSession=B，丢弃 A 的结果，
 *     并记 pending.cross-session trace。
 *  5. 负控：同会话 A 的结果必须被正常注入。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'w2-stub' })),
}));

import { installMainWorldInterceptor, interceptorTraceSnapshot } from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
    + 'event: close\ndata: {"click_behavior":"none"}\n\n';
}
function sseTool(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo A\\",\\"invocationId\\":\\"inv-A\\"}</shell_exec>"}]}\n\n';
}
function sseText(t: string): string {
  return `data: ${JSON.stringify({ v: t })}\n\n`;
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

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

describe('R-W2：跨会话迟到结果在续跑注入路径被丢弃', () => {
  it('A 的工具结果迟到 → 落在 B 的请求之后 → B 的 outgoing body 不含 A 的结果，trace 落 cross-session', async () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

    let resolveSender: ((r: { ok: boolean; data: { stdout: string; exitCode: number } }) => void) | null = null;
    const sender = vi.fn(async () => new Promise<{ ok: boolean; data: { stdout: string; exitCode: number }}>((res) => { resolveSender = res; }));

    const chatUI = {
      sessionKey: 'w2', activateSession: vi.fn(async () => undefined),
      addUserMessage: vi.fn(), startAssistantMessage: vi.fn(), appendToAssistantMessage: vi.fn(),
      appendReasoning: vi.fn(), finishAssistantMessage: vi.fn(), appendError: vi.fn(),
      setBusy: vi.fn(), setContextNotice: vi.fn(), startToolCard: vi.fn(() => true), finishToolCard: vi.fn(),
    };
    const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });

    try {
      // 1) A 会话发请求，SSE 带工具调用
      const xhrA = new FakeXHR();
      xhrA.open('POST', CHAT_URL);
      xhrA.onreadystatechange = () => {};
      xhrA.send(JSON.stringify({ prompt: 'do A', chat_session_id: 'session-A' }));
      xhrA.respond(200, sseTool() + sseDone());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sender).toHaveBeenCalled();

      // 2) B 会话新用户消息（不等 A 的 sender resolve）
      const xhrB = new FakeXHR();
      xhrB.open('POST', CHAT_URL);
      xhrB.onreadystatechange = () => {};
      xhrB.send(JSON.stringify({ prompt: 'do B', chat_session_id: 'session-B' }));
      xhrB.respond(200, sseText('B 的回答') + sseDone());
      await vi.advanceTimersByTimeAsync(1_000);

      // 3) A 的 sender 迟到 resolve → autoContinue 会用 lastChatBody(B) 发起续跑
      (resolveSender as unknown as (r: { ok: boolean; data: { stdout: string; exitCode: number } }) => void)({ ok: true, data: { stdout: 'A-result', exitCode: 0 } });
      await vi.advanceTimersByTimeAsync(5_000);

      // autoContinue 发出的续跑请求体里，pending 中的 A 结果应被过滤（currentSession=B）
      const allReqs = chatRequests(FakeXHR);
      const lastBody = String(allReqs[allReqs.length - 1]?.body ?? '');
      expect(lastBody).not.toContain('A-result');

      // 必须落一条 pending.cross-session trace（droppedNames 至少含 shell_exec）
      const crossEvents = interceptorTraceSnapshot().filter((e) => e.t === 'pending.cross-session');
      expect(crossEvents.length).toBeGreaterThanOrEqual(1);
      const droppedNames = crossEvents.flatMap((e) => (e as unknown as { droppedNames: readonly string[] }).droppedNames ?? []);
      expect(droppedNames).toContain('shell_exec');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('负控：同会话 A 的结果不会被跨会话过滤丢弃（无 pending.cross-session trace）', async () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

    let resolveSender: ((r: { ok: boolean; data: { stdout: string; exitCode: number } }) => void) | null = null;
    const sender = vi.fn(async () => new Promise<{ ok: boolean; data: { stdout: string; exitCode: number }}>((res) => { resolveSender = res; }));

    const chatUI = {
      sessionKey: 'w2', activateSession: vi.fn(async () => undefined),
      addUserMessage: vi.fn(), startAssistantMessage: vi.fn(), appendToAssistantMessage: vi.fn(),
      appendReasoning: vi.fn(), finishAssistantMessage: vi.fn(), appendError: vi.fn(),
      setBusy: vi.fn(), setContextNotice: vi.fn(), startToolCard: vi.fn(() => true), finishToolCard: vi.fn(),
    };
    const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });

    try {
      const baselineCross = interceptorTraceSnapshot().filter((e) => e.t === 'pending.cross-session').length;
      // A 会话发请求，SSE 带工具调用
      const xhrA = new FakeXHR();
      xhrA.open('POST', CHAT_URL);
      xhrA.onreadystatechange = () => {};
      xhrA.send(JSON.stringify({ prompt: 'do A', chat_session_id: 'session-A' }));
      xhrA.respond(200, sseTool() + sseDone());
      await vi.advanceTimersByTimeAsync(1_000);

      // sender 同会话 resolve
      (resolveSender as unknown as (r: { ok: boolean; data: { stdout: string; exitCode: number } }) => void)({ ok: true, data: { stdout: 'A-same-session', exitCode: 0 } });
      await vi.advanceTimersByTimeAsync(5_000);

      // 同会话：不应触发跨会话过滤
      const newCross = interceptorTraceSnapshot().filter((e) => e.t === 'pending.cross-session').length - baselineCross;
      expect(newCross).toBe(0);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
