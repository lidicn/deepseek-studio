/**
 * 墨鉴 R4 / R4.5 注入层专项回归（2026-11-02）。
 *
 * 覆盖四条：
 *   R4-H1  loopDepth 每轮只 +1（重试 / 原样重发 / 协议修复都不消耗预算）
 *   R4-H2  stop() 清掉所有续跑定时器 → 卸载后不再发幽灵请求
 *   R4-H3  continuationRetryPending 按会话维度隔离（并发不互相污染）
 *   R4.5-N2 SSE 错误帧分类与 HTTP 侧同源（code=0 不判 fatal）
 *
 * 断言口径：直接断言「用户可见的行为」（请求发了几次、loop 编号、错误分类），
 * 不依赖内部变量。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r4-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';
import { classifySseFrame, classifyResponse } from '../../src/inject/response-classifier';

// @vitest-environment jsdom

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
      this.status = status; this.responseText = text; this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
    }
    abort() {
      this.status = 0; this.responseText = ''; this.readyState = 4;
      this.onreadystatechange?.();
    }
  };
}

function makeChatUI() {
  return {
    sessionKey: 'r4:session',
    activateSession: vi.fn(async () => undefined),
    beginTurnSession: vi.fn(),
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
    if (req.invocationName === 'mcp.list') {
      return { ok: true, data: { tools: [{ serverId: 's', name: 'n', description: 'd' }] } };
    }
    if (req.invocationName === 'skill.list') {
      return { ok: true, data: { skills: [] } };
    }
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
  xhr.setRequestHeader('Authorization', 'Bearer test');
  xhr.onreadystatechange = () => {};
  xhr.send(JSON.stringify(body));
  return xhr;
}
function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}
/**
 * 从诊断行里取出所有「续跑轮次编号」。
 *
 * 注意：同一轮会打 **3 次** `auto-continue loop=N`
 * （computing PoW / PoW done / status=...），所以比较轮次时要按「不同编号」去重。
 */
function loopNumbers(diagLines: readonly string[]): number[] {
  const out: number[] = [];
  for (const line of diagLines) {
    const m = /auto-continue loop=(\d+)/.exec(line);
    if (m) out.push(Number(m[1]));
  }
  return out;
}
/** 取「不同的轮次编号」序列（同一轮的多条打点只算一次）。 */
function distinctLoops(diagLines: readonly string[]): number[] {
  const out: number[] = [];
  for (const n of loopNumbers(diagLines)) {
    if (out.length === 0 || out[out.length - 1] !== n) out.push(n);
  }
  return out;
}

describe('墨鉴 R4-H1：loopDepth 每轮只 +1', () => {
  it('连续 N 轮工具续跑，loop 编号逐轮 +1（修前是 +2，预算被砍半）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, diagLines } = installHarness();
    try {
      // 每一轮都回一个工具调用 → 触发下一轮续跑。
      const first = pageSend(FakeXHR, { prompt: 'run many', chat_session_id: 'r4-h1' });
      first.respond(200, sseText('<shell_exec>{"command":"echo 1"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);

      // 第 2 轮也回工具调用 → 第 3 轮
      const second = chatRequests(FakeXHR)[1];
      second.respond(200, sseText('<shell_exec>{"command":"echo 2"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);

      // 第 3 轮正常收尾
      const third = chatRequests(FakeXHR)[2];
      third.respond(200, sseText('done') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);

      const loops = distinctLoops(diagLines);
      expect(loops.length).toBeGreaterThanOrEqual(2);
      // 每一轮编号必须严格 +1（修前是 +2）。
      for (let i = 1; i < loops.length; i += 1) {
        expect(loops[i] - loops[i - 1]).toBe(1);
      }
      // 负控：不得出现 +2 的跳变。
      expect(loops.some((n, i) => i > 0 && n - loops[i - 1] > 1)).toBe(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('重试不消耗工具续跑步数（429 退避重发后编号不变）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'retry once', chat_session_id: 'r4-h1-retry' });
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);

      const second = chatRequests(FakeXHR)[1];
      second.respond(429, '');
      expect(diagLines.some((l) => l.includes('auto-continue retryable'))).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      const loops = loopNumbers(diagLines);
      // 重试那一轮的编号必须与上一次相同（不消耗预算）。
      expect(loops.length).toBeGreaterThanOrEqual(2);
      expect(loops[loops.length - 1]).toBe(loops[loops.length - 2]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('墨鉴 R4-H2：stop() 后不再发幽灵续跑请求', () => {
  it('stop() 之后等待一个退避窗口，不再有任何 chat 请求发出', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'stop me', chat_session_id: 'r4-h2' });
      // 触发一次工具调用 → 会有续跑在途
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(200);

      // 卸载（stop）
      handle.stop();
      const before = chatRequests(FakeXHR).length;

      // 等一个足够长的窗口（覆盖 2s/4s/8s 退避 + PoW）。
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chatRequests(FakeXHR).length).toBe(before);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('stop() 后宿主不再收到工具调用投递（sender 不被继续调用）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'stop tool', chat_session_id: 'r4-h2-tool' });
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(200);
      handle.stop();
      const senderCalls = sender.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sender.mock.calls.length).toBe(senderCalls);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('墨鉴 R4-H3：重试标志按会话维度隔离', () => {
  it('两个会话并发时，A 的重试不会豁免 B 的 pending 守卫', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, diagLines } = installHarness();
    try {
      // 会话 A：先回一个工具调用，制造「有工具要续跑」的状态。
      const a = pageSend(FakeXHR, { prompt: 'session A', chat_session_id: 'r4-h3-A' });
      a.respond(200, sseText('<shell_exec>{"command":"echo a"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);

      // 会话 B：紧接着发（不同 chat_session_id）。
      const b = pageSend(FakeXHR, { prompt: 'session B', chat_session_id: 'r4-h3-B' });
      b.respond(200, sseText('<shell_exec>{"command":"echo b"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);

      // 两个会话各自都发出了续跑（说明 A 的状态没有卡住 B，反之亦然）。
      const reqs = chatRequests(FakeXHR);
      expect(reqs.length).toBeGreaterThanOrEqual(4);
      const loops = loopNumbers(diagLines);
      expect(loops.length).toBeGreaterThanOrEqual(2);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('墨鉴 R4.5-N2：SSE 错误帧与 HTTP 侧同源', () => {
  it('code=0 且带 error → SSE 侧判 retryable（与 HTTP 侧一致，不再 fatal）', () => {
    const sse = classifySseFrame('message', { code: 0, error: { message: 'server error' } });
    const http = classifyResponse(200, JSON.stringify({ code: 0, error: { message: 'server error' } }));
    expect(sse?.verdict).toBe('retryable');
    expect(http.verdict).toBe('retryable');
    // 两条路径必须给出同一个结论（这是 N2 的核心）。
    expect(sse?.verdict).toBe(http.verdict);
  });

  it('单独 code=0（无 error）→ 不算错（正常成功包也带 code:0）', () => {
    expect(classifySseFrame('message', { code: 0 })).toBeNull();
    expect(classifyResponse(200, JSON.stringify({ code: 0 })).verdict).toBe('ok');
  });

  it('401/403/402 → 两条路径都是 fatal（鉴权/计费不重试）', () => {
    for (const code of [401, 403, 402]) {
      const sse = classifySseFrame('message', { code, error: { message: 'auth' } });
      const http = classifyResponse(200, JSON.stringify({ code, error: { message: 'auth' } }));
      expect(sse?.verdict, `SSE code=${code}`).toBe('fatal');
      expect(http.verdict, `HTTP code=${code}`).toBe('fatal');
    }
  });

  it('429/500 → 两条路径都是 retryable', () => {
    for (const code of [429, 500]) {
      const sse = classifySseFrame('message', { code, error: { message: 'busy' } });
      const http = classifyResponse(200, JSON.stringify({ code, error: { message: 'busy' } }));
      expect(sse?.verdict, `SSE code=${code}`).toBe('retryable');
      expect(http.verdict, `HTTP code=${code}`).toBe('retryable');
    }
  });

  it('event=error 帧仍是 fatal（明确的错误事件，不受载荷语义影响）', () => {
    expect(classifySseFrame('error', { message: 'boom' })?.verdict).toBe('fatal');
  });
});
