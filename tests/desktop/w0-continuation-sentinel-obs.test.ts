// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * W0+W1：续跑轮哨兵观测 + 截断判定。
 *
 * W0：续跑 XHR readyState===4 落 continuation.stream trace。
 * W1：续跑 2xx 无完成哨兵 = 截断 → 走退避重发（不记 completed、不下发半截工具文本）。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'w1-stub' })),
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
  const onAssistantReply = vi.fn();
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
  const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {}, onAssistantReply });
  return { FakeXHR, handle, sender, chatUI, onAssistantReply };
}

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

function fireFirstRound(FakeXHR: ReturnType<typeof makeFakeXhrClass>, sessionId: string) {
  const first = new FakeXHR();
  first.open('POST', CHAT_URL);
  first.onreadystatechange = () => {};
  first.send(JSON.stringify({ prompt: 'hi', chat_session_id: sessionId }));
  first.respond(200, sseTool() + sseDone());
  return first;
}

describe('W0：续跑轮哨兵观测', () => {
  it('续跑响应带完成哨兵 → continuation.stream sawSentinel=true', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      fireFirstRound(FakeXHR, 'w0-ok');
      await vi.advanceTimersByTimeAsync(2_000);
      const requests = chatRequests(FakeXHR);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      requests[1].respond(200, sseText('继续回答') + sseDone());
      await vi.advanceTimersByTimeAsync(5_000);
      const events = interceptorTraceSnapshot().filter((e) => e.t === 'continuation.stream');
      expect(events.at(-1)).toMatchObject({ sawSentinel: true, status: 200 });
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('续跑响应被截断 → continuation.stream sawSentinel=false', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      fireFirstRound(FakeXHR, 'w0-trunc');
      await vi.advanceTimersByTimeAsync(2_000);
      const requests = chatRequests(FakeXHR);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      requests[1].respond(200, sseText('只说了半句'));
      await vi.advanceTimersByTimeAsync(5_000);
      const events = interceptorTraceSnapshot().filter((e) => e.t === 'continuation.stream');
      expect(events.at(-1)).toMatchObject({ sawSentinel: false, status: 200 });
    } finally { handle.stop(); vi.useRealTimers(); }
  });
});

describe('W1：续跑截断走退避重发，不记 completed', () => {
  it('续跑 2xx 无哨兵 → 发生重发、trace 无 completed、不下发半截工具文本', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, onAssistantReply } = installHarness();
    try {
      fireFirstRound(FakeXHR, 'w1-trunc');
      await vi.advanceTimersByTimeAsync(2_000);
      // 此时已有 2 条请求（首轮 + 第 1 次续跑）
      expect(chatRequests(FakeXHR).length).toBe(2);
      // 记录基线 turn.end 数（trace 是模块级单例，跨用例累积）
      const baselineEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end').length;
      // 第 2 条续跑响应截半
      chatRequests(FakeXHR)[1].respond(200, sseText('<shell_exec>半截'));
      await vi.advanceTimersByTimeAsync(10_000);

      // 断言①：发生重发（≥3 条对话请求）
      expect(chatRequests(FakeXHR).length).toBeGreaterThanOrEqual(3);
      // 断言②：本轮新增 trace 无 turn.finished:true completed
      const newEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end').slice(baselineEnds);
      expect(newEnds.some((e) => e.finished === true && e.stopReason === 'completed')).toBe(false);
      // 断言③：onAssistantReply 没收到含 <shell_exec> 前缀的半截文本
      const leaked = onAssistantReply.mock.calls.some((c) => String(c[0]).includes('<shell_exec>'));
      expect(leaked).toBe(false);
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('R-W1：持续截断直到预算耗尽，请求数有界（与 MAX_ERROR_RETRIES=3 同阶）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, onAssistantReply } = installHarness();
    try {
      fireFirstRound(FakeXHR, 'rw1-budget');
      await vi.advanceTimersByTimeAsync(2_000);
      const baselineEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end').length;
      const baselineTruncated = interceptorTraceSnapshot().filter((e) => e.t === 'continuation.decision' && e.reason === 'continuation-truncated').length;

      // 每出现一条新的续跑请求，都回成 2xx 半截（无哨兵）。
      // 一直喂到预算耗尽，观察请求总数是否有界。
      for (let i = 0; i < 20; i++) {
        const reqs = chatRequests(FakeXHR);
        const last = reqs[reqs.length - 1];
        if (!last || last.readyState === 4) break;
        last.respond(200, sseText('半句未完'));
        await vi.advanceTimersByTimeAsync(30_000);
      }

      const total = chatRequests(FakeXHR).length;
      // 上界：首轮 1 + 续跑 1 + MAX_ERROR_RETRIES(3) + 少量余量。绝不能 15+。
      expect(total).toBeLessThanOrEqual(6);
      expect(total).toBeGreaterThanOrEqual(4);

      // 必须出现一次 finished:false 的收尾（continuation-truncated-budget-out / 同类）
      const newEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end').slice(baselineEnds);
      expect(newEnds.some((e) => e.finished === false)).toBe(true);
      expect(newEnds.some((e) => e.finished === true && e.stopReason === 'completed')).toBe(false);

      // continuation-truncated 决策次数 ≤ MAX_ERROR_RETRIES+1（含首次续跑截断）
      const newTruncated = interceptorTraceSnapshot().filter((e) => e.t === 'continuation.decision' && e.reason === 'continuation-truncated').length - baselineTruncated;
      expect(newTruncated).toBeLessThanOrEqual(4);

      // 不下发半截文本
      const leaked = onAssistantReply.mock.calls.some((c) => String(c[0]).includes('半句未完') || String(c[0]).includes('<shell_exec>'));
      expect(leaked).toBe(false);
    } finally { handle.stop(); vi.useRealTimers(); }
  });
});
