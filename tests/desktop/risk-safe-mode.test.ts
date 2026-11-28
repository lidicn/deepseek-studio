import { describe, expect, it, vi, beforeAll } from 'vitest';

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'safe-mode-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';
import { RISK_SAFE_MODE } from '../../src/shared/continuation-prompt';

/**
 * ㊿-c-补⑬（v0.14.38 主线）：风控安全模式——零自动外发。
 *
 * 出资人拿另一个号做「纯净 Studio」存活验证：全部自动 chat/completion 出口
 * （工具续跑／错误重试／协议修复／首轮原样重发）关干净，只有用户手动发送才外发。
 * 判据（卡面）：
 *   ① RISK_SAFE_MODE=true 时，一轮带工具调用结束 → 零 chat/completion 续跑请求；
 *   ② 错误/截断 → 不触发重试；
 *   ③ 首轮失败 → 不原样重发；
 *   ④ UI 不卡「进行中」（finishStepFlow 已 setBusy(false)）。
 * 负控两条必红：
 *   A. 摘掉入口早退闸（RISK_SAFE_MODE 改 false）⇒ 自动续跑请求出现（⑫ 节流行为在位）；
 *   B. 摘掉 safe-mode 收尾（finishStepFlow 调用）⇒ UI 卡「进行中」。
 *
 * 本件在 jsdom 跑：RISK_SAFE_MODE 是 shared 常量（true），所有「自动外发」路径被闸。
 */

// 本文件需要 DOM（XMLHttpRequest.prototype hook）。
// @vitest-environment jsdom

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

/** 工具调用 SSE（无闭合，会触发工具执行→pending→scheduleAutoContinue 链）。 */
function sseToolCall(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo safe\\"}</shell_exec>"}]}\n\n'
    + 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\ndata: {"click_behavior":"none"}\n\n';
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
    aborted = false;
    private listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor() {
      FakeXHR.instances.push(this);
    }
    open(_m: string, u: string | URL) {
      this.url = String(u);
      this.readyState = 1;
    }
    setRequestHeader() {
      /* noop */
    }
    send(body?: string | null) {
      this.body = typeof body === 'string' ? body : null;
    }
    addEventListener(type: string, fn: (...a: unknown[]) => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    private fire(type: string): void {
      for (const fn of this.listeners[type] ?? []) fn();
    }
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
      this.fire('loadend');
    }
    abort() {
      this.aborted = true;
      this.status = 0;
      this.responseText = '';
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  };
}

function makeChatUI() {
  const calls: string[] = [];
  return {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    appendToAssistantMessage: vi.fn(),
    appendReasoning: vi.fn(),
    finishAssistantMessage: vi.fn(),
    discardOpenAssistantBubble: vi.fn(),
    appendError: vi.fn((code: string) => { calls.push(code); }),
    setBusy: vi.fn(),
    setContextNotice: vi.fn(),
    startToolCard: vi.fn(() => true),
    finishToolCard: vi.fn(),
    __calls: calls,
  };
}

function installHarness() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    // shell_exec 执行成功 → 产生 pending 工具结果 → 触发 scheduleAutoContinue
    return { ok: true, data: { stdout: 'safe', exitCode: 0 } };
  });
  const chatUI = makeChatUI();
  const diagLines: string[] = [];
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: (l) => diagLines.push(l),
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
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion') && x.body !== null);
}

beforeAll(() => {
  // jsdom 的 window.confirm 未实现，注入层 ⑫④ 同文护栏会调它；stub 为 true（确认放行）
  // 避免护栏干扰本件「安全模式零自动外发」的判据。
  (window as unknown as Record<string, unknown>).confirm = () => true;
});

describe('㊿-c-补⑬ 风控安全模式：零自动外发', () => {
  it('常量在位：RISK_SAFE_MODE=true（本版强制开）', () => {
    expect(RISK_SAFE_MODE).toBe(true);
  });

  it('① 一轮带工具调用结束 → 零续跑请求（工具结果已执行、pending 被清、不发下一轮）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender, chatUI, diagLines } = installHarness();
    try {
      // 用户手动发首轮（允许——安全模式只关自动、不关手动）
      const first = pageSend(FakeXHR, { prompt: 'run safe tool', chat_session_id: 's-safe-1' });
      first.respond(200, sseToolCall());
      // 等工具执行回流＋scheduleAutoContinue 被调（安全模式排点闸不排定时器）
      await vi.advanceTimersByTimeAsync(3_000);
      // 工具已被执行（sender 收到 shell_exec 调用）
      expect(sender.mock.calls.some((c) => String(c[0]).includes('shell_exec') || c[0]?.invocationName === 'shell_exec')).toBe(true);
      // 但续跑请求**零**枚：chat 请求只有首轮 1 枚（body 非空），无第 2 枚
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      // 安全模式收尾：diag 有 safe-mode 行
      expect(diagLines.some((l) => l.includes('safe-mode'))).toBe(true);
      // UI 不卡「进行中」：finishStepFlow 已 setBusy(false)
      expect(chatUI.setBusy).toHaveBeenCalledWith(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('② 错误（429）→ 不触发自动重试（无第 2 枚请求）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run safe 429', chat_session_id: 's-safe-2' });
      first.respond(429, '');
      // 等首轮失败结算＋退避窗口（安全模式下 escalate/schedule 全被闸、不排定时器）
      await vi.advanceTimersByTimeAsync(30_000);
      // 只有首轮 1 枚请求，无自动重发
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      // 安全模式收尾（safe-mode 行在 diag）
      expect(diagLines.some((l) => l.includes('safe-mode'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('③ 截断（200 无哨兵）→ 不自动重发', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run safe trunc', chat_session_id: 's-safe-3' });
      // 200 但无完成哨兵（截断）
      first.respond(200, 'data: {"v":"半句未完"}\n\n');
      await vi.advanceTimersByTimeAsync(30_000);
      // 只有首轮 1 枚，无截断重发
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      expect(diagLines.some((l) => l.includes('safe-mode'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('④ UI 不卡「进行中」：首轮失败后 setBusy(false) 必达', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'busy check', chat_session_id: 's-safe-4' });
      first.respond(0, ''); // network-error
      await vi.advanceTimersByTimeAsync(30_000);
      // 安全模式收尾走 finishStepFlow ⇒ setBusy(false) 必达（不卡在「进行中…」）
      expect(chatUI.setBusy).toHaveBeenCalledWith(false);
      // diag 留 safe-mode 行（证明走的是安全模式收尾，不是 generic retry-out）
      expect(diagLines.some((l) => l.includes('safe-mode'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('⑤（负控对照）riskSafeMode:false 覆盖 ⇒ ⑫ 节流行为在位（首轮失败自动重发出现）', async () => {
    // 卡面负控 B：常量改 false ⇒ ⑫ 节流行为在位（两条都要测）。
    // 这里用 options.riskSafeMode=false 覆盖 shared 常量（不动 shared、不动源），
    // 断言首轮失败后**有**第 2 枚自动重发请求——证明节流版（自动外发开）行为仍在。
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
    const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'ok', exitCode: 0 } }));
    const chatUI = makeChatUI();
    const handle = installMainWorldInterceptor({
      sender,
      chatUI: chatUI as never,
      diag: () => {},
      riskSafeMode: false, // 覆盖：验节流版行为在位
    });
    try {
      const xhr = new FakeXHR();
      xhr.open('POST', CHAT_URL);
      xhr.onreadystatechange = () => {};
      xhr.send(JSON.stringify({ prompt: 'neg false probe', chat_session_id: 's-neg-false' }));
      xhr.respond(0, ''); // network-error
      // ⑫ 节流版：退避 4s+抖动 1500，等过最坏 5500ms 后应看到自动重发
      await vi.advanceTimersByTimeAsync(6_000);
      const requests = chatRequests(FakeXHR);
      expect(requests.length).toBeGreaterThanOrEqual(2); // 节流版有自动重发
      const appendErrorMsgs = chatUI.appendError.mock.calls.map((c) => String((c as unknown[])[1] ?? ''));
      expect(appendErrorMsgs.some((m) => m.includes('正在自动重试'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
