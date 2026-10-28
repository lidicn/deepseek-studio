import { describe, expect, it, vi } from 'vitest';

/**
 * QD-R4 回归用例（对话 / 工具调用断流专项审计，2026-10-23）。
 *
 * 来源：`docs/审计报告/QD/20261023-QD-R4-对话与工具调用断流专项审计.md`
 * 复现件：`docs/审计报告/QD/复现用例/qd-r4-repro.test.ts`
 *
 * 当时 4 条复现腿在本盘面全部实测为红（正控为绿），修复后转正为回归用例。
 * 每一例都直接断言「用户可见的行为」：请求是否发出、错误是否可见、prompt 是否被污染。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r4-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

// 本文件需要 DOM（XMLHttpRequest.prototype hook + window.fetch）。
// 根 vitest.config.ts 是 node 环境，故按文件覆盖。
// @vitest-environment jsdom

type Handler = ((...args: unknown[]) => void) | null;

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

/**
 * DeepSeek 的真实完成哨兵。
 * 实测 `logs/cdp-chat-capture/` 20 份抓包里 `data: [DONE]` 出现 0 次，
 * 流以 response/status=FINISHED + event: close 收尾。
 */
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
  // auto-continue 用相对 URL 发起，宿主名必须是 deepseek.com 才会命中 hook。
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

describe('QD-R4-01 自动续跑的重试不再被自己的 pending 守卫挡死', () => {
  it('CONTROL：续跑回复里再出现工具调用时会继续发出下一轮续跑', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run twice', chat_session_id: 's-control' });
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);
      expect(chatRequests(FakeXHR)).toHaveLength(2);

      chatRequests(FakeXHR)[1].respond(
        200,
        sseText('<shell_exec>{"command":"echo two"}</shell_exec>') + sseDone(),
      );
      await vi.advanceTimersByTimeAsync(1500);
      expect(chatRequests(FakeXHR)).toHaveLength(3);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('429 后按退避重发，且重试不消耗工具续跑步数', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run once', chat_session_id: 's-repro' });
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(1500);
      expect(chatRequests(FakeXHR)).toHaveLength(2);

      chatRequests(FakeXHR)[1].respond(429, '');
      // 必须真的进入重试分支，否则本用例证明不了任何事。
      expect(diagLines.some((l) => l.includes('auto-continue retryable') && l.includes('retry 1/3'))).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      // 页面 + 续跑#1 + 重试#1。修复前这里是 2（定时器回调被 pending 守卫 return）。
      expect(chatRequests(FakeXHR)).toHaveLength(3);
      // 重试不应把 loopDepth 顶到上限：第 3 次请求的 loop 编号必须仍是 2 而不是 3。
      expect(diagLines.some((l) => l.includes('auto-continue loop=2 computing PoW'))).toBe(true);
      expect(chatUI.setBusy.mock.calls).toEqual([[true]]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R4-02 被截断的工具标签不再静默消失', () => {
  it('流在工具标签中间结束时报错，且不当成正常完成', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'write a file', chat_session_id: 's-truncated' });
      // 无闭合 </shell_exec>，也没有完成哨兵。
      first.respond(200, sseText('我先执行。') + sseText('<shell_exec>{"command":"echo one"'));
      await vi.advanceTimersByTimeAsync(5000);

      expect(sender.mock.calls.filter((c) => c[0].invocationName === 'shell_exec')).toHaveLength(0);
      // 修复前：appendError 0 次、finishAssistantMessage 把它当最终答案收尾。
      expect(chatUI.appendError.mock.calls.length).toBeGreaterThan(0);
      expect(chatUI.appendError.mock.calls[0]?.[0]).toBe('tool-call-truncated');
      expect(chatUI.setBusy).toHaveBeenCalledWith(false);
      // 截断轮不得触发任何续跑请求。
      expect(chatRequests(FakeXHR)).toHaveLength(1);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R4-03 无完成哨兵的流不再被当成正常完成', () => {
  it('无工具的回复被截断时给出可见错误', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'tell me a story', chat_session_id: 's-cut' });
      // 有可见文本、没有工具、没有完成哨兵。
      first.respond(200, sseText('很久很久以前'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chatUI.appendError.mock.calls[0]?.[0]).toBe('stream-incomplete');
      // QD-R5-01：首轮无哨兵不再直接判死刑，先按 FIRST_ATTEMPT_MAX_RETRIES
      // 原样重发，重发同样没有哨兵才把预算耗尽。busy 在重试期间保持 true。
      expect(chatRequests(FakeXHR)).toHaveLength(2);
      expect(chatUI.setBusy).not.toHaveBeenCalledWith(false);
      expect(
        chatUI.appendError.mock.calls.some((c) => String(c[1]).includes('正在自动重试（1/2）')),
      ).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('带完成哨兵的正常流不报错', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'hello', chat_session_id: 's-ok' });
      first.respond(200, sseText('你好') + sseDone());
      await vi.advanceTimersByTimeAsync(5000);

      expect(chatUI.appendError.mock.calls).toEqual([]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R4-04 用户点停止后循环真的停', () => {
  it('abort 后不再发出续跑，也不弹网络错误', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'run and stop', chat_session_id: 's-abort' });
      first.partial(sseText('<shell_exec>{"command":"echo one"}</shell_exec>'));
      await vi.advanceTimersByTimeAsync(0);
      first.abort();
      await vi.advanceTimersByTimeAsync(5000);

      // 修复前：status 0 被判 retryable，pending 触发新一轮续跑 → 2 个请求。
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      // 「已停止」不是网络错误。
      expect(chatUI.appendError.mock.calls).toEqual([]);
      expect(diagLines.some((l) => l.includes('aborted by user'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('QD-R4-05 新用户消息不继承上一回合的 pending', () => {
  it('任务 B 的 prompt 尾部没有任务 A 的工具结果', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'task A', chat_session_id: 's-a' });
      first.respond(200, sseText('<shell_exec>{"command":"echo one"}</shell_exec>') + sseDone());
      await vi.advanceTimersByTimeAsync(0);

      const second = pageSend(FakeXHR, { prompt: 'task B', chat_session_id: 's-b' });
      const sent = JSON.parse(String(second.body)) as { prompt?: string };
      // 修复前：B 的 prompt 尾部被追加 A 的 [tool-result:shell_exec]。
      expect(sent.prompt ?? '').not.toContain('[tool-result:shell_exec]');
      expect(sent.prompt ?? '').toContain('task B');
      expect(sender.mock.calls.filter((c) => c[0].invocationName === 'shell_exec')).toHaveLength(1);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

/**
 * QD-R6-01：断流结算漏了对话端点门禁。
 *
 * 修复前 `isDone` / streamActive 重置对**所有** XHR 生效，页面启动期那批非对话
 * 请求（/api/v0/client/settings、/api/v0/chat/history_messages、埋点…）逐个掉进
 * settleStreamEnd：本轮 streamSawDone 仍是 false → 判「无完成哨兵」→ 计首轮重试
 * 预算 → 每个非对话 XHR 都 append 一张 stream-incomplete 错误卡，并把重发定时器
 * 排上（发出一个用户没要求的 completion 请求）。
 */
describe('QD-R6-01 非对话 XHR 不参与断流判定', () => {
  function nonChatGet(FakeXHR: ReturnType<typeof makeFakeXhrClass>, path: string, payload: string) {
    const xhr = new FakeXHR();
    xhr.open('GET', path);
    xhr.onreadystatechange = () => {};
    xhr.send(null);
    xhr.respond(200, payload);
    return xhr;
  }

  it('CONTROL：settings / history 这类非对话请求结束时不报断流、不排重发', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, diagLines } = installHarness();
    try {
      // 首屏那批请求。它们都不是 /api/v0/chat/completion，不该进断流结算。
      nonChatGet(FakeXHR, '/api/v0/client/settings?scope=main', '{"data":{"scope":"main"}}');
      nonChatGet(FakeXHR, '/api/v0/client/settings?scope=banner', '{"data":{"scope":"banner"}}');
      nonChatGet(FakeXHR, '/api/v0/chat/history_messages?chat_session_id=abc', '{"data":[]}');
      await vi.advanceTimersByTimeAsync(10000);

      // 修复前：三次非对话 XHR 各触发一次 escalate → 至少两张错误卡。
      expect(chatUI.appendError.mock.calls).toEqual([]);
      // 也不得伪造「正在自动重试」的提示或排出一个 completion 重发。
      expect(diagLines.some((l) => l.includes('no completion sentinel'))).toBe(false);
      expect(chatRequests(FakeXHR)).toHaveLength(0);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('对照：真正的 completion 断流仍会被判定并报错', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      // 连发四次无哨兵的 completion：预算 2 次用尽后必须留下可见错误。
      for (let i = 0; i < 4; i += 1) {
        const xhr = pageSend(FakeXHR, { prompt: `p${i}`, chat_session_id: `s-${i}` });
        xhr.respond(200, sseText('半句'));
        await vi.advanceTimersByTimeAsync(6000);
      }
      expect(chatUI.appendError).toHaveBeenCalled();
      const [, msg] = chatUI.appendError.mock.calls.at(-1) as [string, string];
      expect(msg).toContain('模型回复未完整接收（连接中断）');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
