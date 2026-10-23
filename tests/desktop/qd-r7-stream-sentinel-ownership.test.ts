// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * QD-R7-01 回归用例（对话与工具调用断流 · 定案报告 P0 集）。
 *
 * 来源：`docs/审计报告/deepseek-studio-stream-incomplete-root-cause-20261023.md`
 *
 * 定案的根因是一层结构缺陷加两个放大器，本文件逐条钉住：
 *   F1  EOF 必须 flush 帧缓冲并重跑哨兵判定（finish() 此前全项目零调用）
 *   F2  结束状态三态化：0 字节 = no-stream，不算截断、不吃首轮重试预算
 *   F4  哨兵归属到「某一条流」——并发时旧流不得读/写当前轮的状态
 *   F6  结算命中时不得吞掉收尾（页面侧消息必须收尾，否则污染下一轮父节点）
 *   F8  重试幂等：重放体逐字节等于原请求，不再改写 parent_message_id
 *   F10 预算只按「真实发出的重试次数」结算，不再按结算次数烧穿
 *
 * 每条断言的都是用户可见行为：错误卡有没有出现、请求有没有发出去、重发内容是否被改写。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r7-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

/** DeepSeek 的真实完成哨兵（`data: [DONE]` 实测从不出现）。 */
function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
    + 'event: close\ndata: {"click_behavior":"none"}\n\n';
}

/** 不合法但真实的哨兵写法：流尾没有空行 —— 解码器只在空行上切帧。 */
function sseDoneNoTrailingBlank(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}';
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

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

describe('QD-R7-01 / F1：EOF 必须 flush 帧缓冲', () => {
  it('流尾不带空行时，完成哨兵仍被识别（不再误报截断）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'hello', chat_session_id: 's-eof' });
      // 关键：最后一段没有结尾空行。修复前 finish() 从不被调用，
      // 这一帧永远吐不出来 → streamSawDone 停在 false → 报 stream-incomplete。
      first.respond(200, sseText('你好') + sseDoneNoTrailingBlank());
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chatUI.appendError.mock.calls).toEqual([]);
      expect(chatRequests(FakeXHR)).toHaveLength(1);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('对照：真的没有哨兵时仍判截断（负控，确保上一条不是空绿）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'hello', chat_session_id: 's-eof-neg' });
      first.respond(200, sseText('只说了半句'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chatUI.appendError.mock.calls[0]?.[0]).toBe('stream-incomplete');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R7-02 / F2：0 字节 = no-stream，不算截断也不吃预算', () => {
  it('空响应体的对话请求静默收尾，不产生错误卡、不排重发', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'hello', chat_session_id: 's-empty' });
      first.respond(200, '');
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chatUI.appendError.mock.calls).toEqual([]);
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      expect(diagLines.some((l) => l.includes('no bytes received (no-stream)'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R7-03 / F4：哨兵与结算归属到单条流', () => {
  it('并发两条流时，晚到的旧流结算不污染当前轮（不报错、不排重发）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      // 同一轮里的两条流：A 是页面自己那条，B 是晚发的（模拟 Studio 重发 / auto_resume）。
      const streamA = pageSend(FakeXHR, { prompt: 'do it', chat_session_id: 's-conc' });
      const streamB = pageSend(FakeXHR, {
        prompt: '<original_task>do it</original_task>',
        chat_session_id: 's-conc',
      });
      expect(chatRequests(FakeXHR)).toHaveLength(2);

      // A 先结束：有字节、无哨兵 —— 修复前它会把「本轮断流」记到自己账上，
      // 于是报一张 stream-incomplete 卡并排一次重发，而 B 其实还在正常输出。
      streamA.respond(200, sseText('半句'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chatUI.appendError.mock.calls).toEqual([]);
      expect(chatRequests(FakeXHR)).toHaveLength(2);
      expect(diagLines.some((l) => /stale stream #\d+/.test(l))).toBe(true);

      // B 正常收尾：整轮不该有任何错误卡。
      streamB.respond(200, sseText('完整的回答') + sseDone());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(chatUI.appendError.mock.calls).toEqual([]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R7-04 / F8：重试幂等（重放体逐字节相等）', () => {
  it('首轮断流后的重发与原请求逐字节相同，且不改写 parent_message_id', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      const first = pageSend(FakeXHR, {
        prompt: 'hello',
        chat_session_id: 's-verbatim',
        temperature: 1,
      });
      // 带上 response_message_id：修复前它会被写成重放体的 parent_message_id，
      // 于是「重发同一个问题」变成「接在残句后面继续生成」。
      const ready = 'event: ready\ndata: {"request_message_id":1,"response_message_id":123}\n\n';
      first.respond(200, ready + sseText('半句'));
      await vi.advanceTimersByTimeAsync(60_000);

      const requests = chatRequests(FakeXHR);
      expect(requests).toHaveLength(2);
      const resent = requests[1].body ?? '';
      expect(resent).not.toContain('parent_message_id');
      expect(resent).toBe(requests[0].body);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R7-05 / F10：预算按真实发出的重试计数', () => {
  it('连续 429 只发 2 次重试，文案报「已自动重试 2 次」而不是虚报', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      pageSend(FakeXHR, { prompt: 'hello', chat_session_id: 's-budget' });
      chatRequests(FakeXHR)[0].respond(429, '');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(chatRequests(FakeXHR)).toHaveLength(2);

      chatRequests(FakeXHR)[1].respond(429, '');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(chatRequests(FakeXHR)).toHaveLength(3);

      chatRequests(FakeXHR)[2].respond(429, '');
      await vi.advanceTimersByTimeAsync(30_000);
      // 预算（2 次）已真实用尽 → 不再排第 4 次请求。
      expect(chatRequests(FakeXHR)).toHaveLength(3);

      const notes = chatUI.appendError.mock.calls.map((c) => String(c[1]));
      expect(notes.some((n) => n.includes('正在自动重试（1/2）'))).toBe(true);
      expect(notes.some((n) => n.includes('正在自动重试（2/2）'))).toBe(true);
      expect(notes.at(-1)).toContain('已自动重试 2 次仍失败');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
