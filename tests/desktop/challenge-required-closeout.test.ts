import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'chal-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

/**
 * ㊿-c-补⑩：40303 CHALLENGE_REQUIRED 误判成「服务器暂时无法访问」——流收口接终局出口。
 *
 * 现场（出资人实测，装版 0.14.34）：q1 会话请求发 /api/v0/chat/completion 收到 HTTP 200 外壳
 * `{"code":40303,"msg":"CHALLENGE_REQUIRED","data":{...}}`，Studio 把它兜底判成可重试，烧掉首轮
 * 重试预算 2 次后误报「服务器暂时无法访问，已自动重试 2 次仍失败」——把「需要过人机验证」伪装
 * 成「服务器故障」。网页版会渲染数美挑战框让用户过验证；Studio 该明示「需完成人机验证」。
 *
 * 本件锁流收口（settleStreamEnd）那枚现场路径：200 ＋ 40303 体 ⇒ verdict=challenge-required，
 * **不进入首轮重试**（只发 1 枚请求），界面 appendError 文案含「人机验证」且**不含**
 * 「服务器暂时无法访问」，setBusy(false)。
 */

// 本文件需要 DOM（XMLHttpRequest.prototype hook）。
// @vitest-environment jsdom

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

/** 现场 40303 挑战体（装版 sidecar 原文形态，challenge_id 换成中性占位）。 */
const CHALLENGE_BODY = JSON.stringify({
  code: 40303,
  msg: 'CHALLENGE_REQUIRED',
  data: {
    provider: 'shumei',
    challenge_id: 'bd11a494-0000-4000-8000-000000000000',
    extras: { expected_mode: 'spatial_select' },
  },
});

function makeFakeXhrClass() {
  return class FakeXHR {
    static instances: FakeXHR[] = [];
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: ((...a: unknown[]) => void) | null = null;
    url = '';
    body: string | null = null;
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
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
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

function installHarness() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
  });
  const chatUI = {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    appendToAssistantMessage: vi.fn(),
    appendReasoning: vi.fn(),
    finishAssistantMessage: vi.fn(),
    discardOpenAssistantBubble: vi.fn(),
    appendError: vi.fn(),
    setBusy: vi.fn(),
    setContextNotice: vi.fn(),
    startToolCard: vi.fn(() => true),
    finishToolCard: vi.fn(),
  };
  const diagLines: string[] = [];
  const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: (l) => diagLines.push(l) });
  return { FakeXHR, handle, chatUI, diagLines };
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

function appendErrorCalls(chatUI: { appendError: ReturnType<typeof vi.fn> }): Array<[string, string]> {
  return (chatUI.appendError.mock.calls as unknown[]).map((c) => {
    const pair = c as unknown[];
    return [String(pair[0]), String(pair[1])];
  }) as Array<[string, string]>;
}

describe('㊿-c-补⑩ 40303 挑战·流收口终局出口', () => {
  it('④ 200 ＋ 40303 ⇒ challenge-required 终端：不烧首轮重试、文案含「人机验证」不含「服务器暂时无法访问」、setBusy(false)', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'hi', chat_session_id: 's-chal' });
      first.respond(200, CHALLENGE_BODY);
      // 挑战是确定性终局：应就地停下，不排首轮重发。
      await vi.advanceTimersByTimeAsync(30_000);

      // 一个请求就停（对照旧路径：可重试会重发到 2 枚以上）。
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      // appendError 触达 challenge-required 终端。
      const calls = appendErrorCalls(chatUI);
      const chal = calls.find((c) => c[0] === 'challenge-required');
      expect(chal, '应挂 challenge-required 终端').toBeTruthy();
      const msg = chal![1];
      expect(msg).toContain('人机验证');
      expect(msg).toContain('spatial_select'); // expectedMode 进文案
      expect(msg).not.toContain('服务器暂时无法访问'); // 不再冒充服务器故障
      // 任一 appendError 文案都不含「服务器暂时无法访问」。
      expect(calls.every(([, m]) => !m.includes('服务器暂时无法访问'))).toBe(true);
      expect(chatUI.setBusy).toHaveBeenCalledWith(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('对照：200 ＋ 正常 SSE 成功流 ⇒ 不挂 challenge-required（不误伤正常包）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'ok', chat_session_id: 's-ok' });
      first.respond(200, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\ndata: {"click_behavior":"none"}\n\n');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(appendErrorCalls(chatUI).some((c) => c[0] === 'challenge-required')).toBe(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
