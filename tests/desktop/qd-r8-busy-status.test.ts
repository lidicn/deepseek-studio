// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * QD-R8-01：状态栏「执行中…」永不复位。
 *
 * 现场：2026-10-23 19:06:50 那一轮，模型只输出思考内容（无正文、无工具），
 * 流正常收到完成哨兵后结束，但
 *   ① `onStreamEnd` 的成功分支只调 `finishAssistantMessage()`，从不调 `setBusy(false)`；
 *   ② 正文为空时 `finishAssistantMessage` 既不替换 `.ds-sc-streaming`（光标残留），
 *      也不写 final-answer（storage.json 里这一轮没有 final-answer 事件）。
 * 结果：气泡一直闪光标、状态栏一直「执行中…」，用户以为任务还在跑。
 *
 * 本文件只钉「用户可见行为」：流结束后 setBusy(false) 必须被调用一次。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r8-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

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
    onreadystatechange: ((...args: unknown[]) => void) | null = null;
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
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'ok', exitCode: 0 } }));
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

describe('QD-R8-01：普通回合结束后状态栏必须复位', () => {
  it('有正文、无工具的回合：流结束后 setBusy(false) 被调用', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const xhr = pageSend(FakeXHR, { prompt: 'hi', chat_session_id: 's-busy-text' });
      xhr.respond(200, sseText('你好') + sseDone());
      await vi.advanceTimersByTimeAsync(5_000);

      expect(chatUI.appendError.mock.calls).toEqual([]);
      expect(chatUI.setBusy.mock.calls).toContainEqual([false]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('只有思考、正文为空的回合：也必须复位，并明确告知本轮没有可见回复', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const xhr = pageSend(FakeXHR, { prompt: 'hi', chat_session_id: 's-busy-empty' });
      // 只有完成哨兵，没有任何可见正文 —— 复现 19:06:50 那一轮。
      xhr.respond(200, sseDone());
      await vi.advanceTimersByTimeAsync(5_000);

      expect(chatUI.setBusy.mock.calls).toContainEqual([false]);
      expect(chatUI.appendError.mock.calls.map((c) => c[0])).toContain('empty-reply');
      expect(diagLines.some((l) => l.includes('empty reply'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
