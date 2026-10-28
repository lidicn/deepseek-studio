import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r4-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

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
    constructor() {
      FakeXHR.instances.push(this);
    }
    open(m: string, u: string | URL) {
      this.method = m;
      this.url = String(u);
      this.readyState = 1;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(body?: string | null) {
      this.body = typeof body === 'string' ? body : null;
    }
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
    }
    partial(text: string) {
      this.status = 200;
      this.responseText = text;
      this.readyState = 3;
      this.onreadystatechange?.();
    }
    abort() {
      this.status = 0;
      this.responseText = '';
      this.readyState = 4;
      this.onreadystatechange?.();
    }
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
  // The interceptor resolves the auto-continue's relative URL against location.href and
  // only treats it as a chat request when the hostname is deepseek.com. jsdom defaults to
  // localhost, which would silently bypass the hook for continuation requests.
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
  // Page requests use the absolute URL; auto-continue uses the relative path.
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

describe('QD-R4 auto-continue retry path', () => {
  it('CONTROL: a tool call inside the continuation reply repopulates pending and sends the next continuation', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run twice', chat_session_id: 's-control' });
      console.log('R4 diag after page send:', diagLines.join(' | '));
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>'));
      await vi.advanceTimersByTimeAsync(1500);
      console.log('R4 diag after timer:', diagLines.slice(-12).join(' | '));
      expect(chatRequests(FakeXHR)).toHaveLength(2); // page request + auto-continue #1

      const auto1 = chatRequests(FakeXHR)[1];
      auto1.respond(200, sseText('<shell_exec>{"command":"echo two"}</shell_exec>'));
      await vi.advanceTimersByTimeAsync(1500);

      // Control proves the harness observes genuine continuation requests (not a stub artifact).
      expect(chatRequests(FakeXHR)).toHaveLength(3);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('REPRO: 429 on an auto-continue must schedule a retry, but the retry callback re-enters a guard whose pending[] was cleared', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run once', chat_session_id: 's-repro' });
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>'));
      await vi.advanceTimersByTimeAsync(1500);
      expect(chatRequests(FakeXHR)).toHaveLength(2);

      chatRequests(FakeXHR)[1].respond(429, '');
      // The retry branch must have been entered (otherwise this test proves nothing).
      expect(diagLines.some((l) => l.includes('auto-continue retryable') && l.includes('retry 1/3'))).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);

      const after = chatRequests(FakeXHR);
      console.log('R4 request count after retry window:', after.length);
      console.log('R4 auto-continue request bodies:', after.slice(1).map((x) => String(x.body).slice(0, 60)));
      console.log('R4 diag tail:', diagLines.slice(-8).join(' | '));
      console.log('R4 retry after-window UI:', JSON.stringify({
        setBusy: chatUI.setBusy.mock.calls,
        finishAssistantMessage: chatUI.finishAssistantMessage.mock.calls,
        appendError: chatUI.appendError.mock.calls,
      }));

      // Expected correct behavior: page + continuation #1 + one retry = 3.
      // Actual at HEAD: 2 (the backoff timer fires, autoContinueWithPow returns at its first guard).
      expect(after.length).toBe(3);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('REPRO: a tool tag truncated by stream end vanishes without tool execution, error, or recovery', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'write a file', chat_session_id: 's-truncated' });
      // The stream ends mid-tag: no closing </shell_exec>, no tool call is ever parsed.
      first.respond(200, sseText('我先执行。') + sseText('<shell_exec>{"command":"echo one"'));
      await vi.advanceTimersByTimeAsync(5000);

      const toolCalls = sender.mock.calls.filter((c) => c[0].invocationName === 'shell_exec');
      console.log('R4 truncated: tool calls =', toolCalls.length,
        'chat requests =', chatRequests(FakeXHR).length,
        'appendError calls =', chatUI.appendError.mock.calls.length,
        'finishAssistantMessage calls =', chatUI.finishAssistantMessage.mock.calls.length);
      console.log('R4 truncated diag tail:', diagLines.slice(-6).join(' | '));

      expect(toolCalls).toHaveLength(0); // confirmed: the truncated call never executes
      // Expected: the dangling tag is detected and either retried or reported.
      const recovered = chatRequests(FakeXHR).length > 1 || chatUI.appendError.mock.calls.length > 0;
      expect(recovered).toBe(true); // actual: false — silent loss
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('REPRO: aborting the page request after a tool call still starts an auto-continue', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run and stop', chat_session_id: 's-abort' });
      // Tool call parsed at readyState 3; its host result lands before the user presses stop.
      first.partial(sseText('<shell_exec>{"command":"echo one"}</shell_exec>'));
      await vi.advanceTimersByTimeAsync(0);
      first.abort(); // user pressed stop: XHR abort => readyState 4, status 0

      console.log('R4 abort: appendError =', JSON.stringify(chatUI.appendError.mock.calls));
      await vi.advanceTimersByTimeAsync(5000);

      console.log('R4 abort: chat requests after stop =', chatRequests(FakeXHR).length,
        'diag tail =', diagLines.slice(-6).join(' | '));
      // Expected: a user stop aborts the loop. Actual: status 0 is classified as a
      // retryable network error and pending[] triggers a fresh continuation request.
      expect(chatRequests(FakeXHR)).toHaveLength(1);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('REPRO: a new user message inherits the previous turn pending tool result', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'task A', chat_session_id: 's-a' });
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>'));
      await vi.advanceTimersByTimeAsync(0); // sender resolves; pending[] holds the result

      const second = pageSend(FakeXHR, { prompt: 'task B', chat_session_id: 's-b' });
      const sent = JSON.parse(String(second.body)) as { prompt?: string };
      console.log('R4 cross-turn: second prompt tail =', JSON.stringify((sent.prompt ?? '').slice(-160)));
      console.log('R4 cross-turn: tool calls before B =',
        sender.mock.calls.filter((c) => c[0].invocationName === 'shell_exec').length);

      // Expected: task B must not carry task A's tool result.
      expect(sent.prompt ?? '').not.toContain('[tool-result:shell_exec]');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
