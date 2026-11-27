// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

// ㊿-c-补⑫ 件④：jsdom 的 window.confirm 未实现，注入层同文护栏会调它落 stderr。
// 全局 stub 为返回 true（确认放行）：不弹真框、不拦截。
beforeAll(() => {
  (window as unknown as Record<string, unknown>).confirm = () => true;
});

/**
 * ㊿-b ③ inject 侧交接（Core ㊿-b ③ 交卷第六节，2026-11-20）：`forward` 结算时把
 * `paramsSummary`（shared 单源摘要器）＋`durationMs` 两字段填进 `PendingResult`，
 * 本文件钉真链消费面——auto-continue 请求体的 `<turn_tool_summary>` 行带上「关键参数＋耗时」：
 *   ① 成功回执：`#01 shell_exec{command:echo a} → ok (Nms)`；
 *   ② 被拒回执：`#01 shell_exec{command:echo a} → failed: <error 首段> (Nms)`。
 * 不填也能跑（摘要退化「工具名＋状态」）——本文件即「填了」的回归锁：摘掉任一填充行，
 * 两枚的行形态断言必红（负控走 logs/ 副本树，真实现零触碰）。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'fill-stub' })),
}));

import { installMainWorldInterceptor, type ToolCallRequest } from '../../src/inject/main-world-interceptor';
import type { ExecuteResult } from '../../src/capabilities/types';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n' +
    'event: close\ndata: {"click_behavior":"none"}\n\n';
}
function sseOneTool(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo a\\"}</shell_exec>"}]}\n\n';
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
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  };
}

function chatRequests(FakeXHR: unknown) {
  const XHR = FakeXHR as { instances: unknown[] };
  return (XHR.instances as Array<{ url: string; readyState: number; body: string | null }>).filter(
    (x) => x.url.endsWith('/api/v0/chat/completion'),
  );
}

function fireRound(FakeXHR: unknown, sessionId: string): void {
  const XHR = FakeXHR as new () => {
    open: (m: string, u: string) => void;
    onreadystatechange: (() => void) | undefined;
    send: (body?: unknown) => void;
    respond: (s: number, t: string) => void;
  };
  const x = new XHR();
  x.open('POST', CHAT_URL);
  x.onreadystatechange = () => {};
  x.send(JSON.stringify({ prompt: 'run it', chat_session_id: sessionId }));
  x.respond(200, sseOneTool() + sseDone());
}

interface FillHarnessOpts {
  /** 工具调用立即拒（reject 支），不进门闸。 */
  rejectWith?: string;
}

function installFillHarness(opts: FillHarnessOpts = {}) {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const gates: Array<{ resolve: (r: unknown) => void }> = [];
  const sender = vi.fn((req: ToolCallRequest): Promise<ExecuteResult> => {
    if (req.invocationName === 'mcp.list') return Promise.resolve({ ok: true, data: { tools: [] } });
    if (req.invocationName === 'skill.list') return Promise.resolve({ ok: true, data: { skills: [] } });
    if (opts.rejectWith) return Promise.reject(new Error(opts.rejectWith));
    return new Promise<ExecuteResult>((resolve) => {
      gates.push({ resolve: (v: unknown) => resolve(v as never) });
    });
  });
  const chatUI = {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    hasOpenAssistantBubble: vi.fn(() => false),
    appendToAssistantMessage: vi.fn(),
    appendReasoning: vi.fn(),
    finishAssistantMessage: vi.fn(),
    appendError: vi.fn(),
    setBusy: vi.fn(),
    setContextNotice: vi.fn(),
    startToolCard: vi.fn(() => true),
    finishToolCard: vi.fn(),
  };
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: () => {},
  });
  return { FakeXHR, handle, gates };
}

/** 取 auto-continue 发出的续跑请求体（open 态那枚）。 */
function continuationBody(FakeXHR: unknown): string {
  const open = chatRequests(FakeXHR).find((r) => r.readyState !== 4);
  expect(open?.body, 'auto-continue 续跑请求应已发出').toBeTruthy();
  return open!.body!;
}

describe('㊿-b ③ inject 侧：forward 结算两字段（paramsSummary＋durationMs）真链消费', () => {
  it('成功回执：续跑 prompt 的 <turn_tool_summary> 行带关键参数＋耗时', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, gates } = installFillHarness();
    try {
      fireRound(FakeXHR, 'fill-1');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(gates).toHaveLength(1);
      // 不放 terminate ⇒ auto-continue 真发生（1s 定时器）。
      gates[0].resolve({ ok: true, data: { stdout: 'a', exitCode: 0 } });
      await vi.advanceTimersByTimeAsync(3_000);
      const body = continuationBody(FakeXHR);
      expect(body).toContain('<turn_tool_summary>');
      // 行形态：#NN 工具名{参数摘要} → ok (Nms)——参数与耗时两列都在。
      expect(body).toMatch(/shell_exec\{command:echo a\} → ok \(\d+ms\)/);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('被拒回执：failed 行同样带关键参数＋耗时', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installFillHarness({ rejectWith: 'host-down' });
    try {
      fireRound(FakeXHR, 'fill-2');
      // reject 立即结算（err 支）＋ auto-continue（1s 定时器）。
      await vi.advanceTimersByTimeAsync(3_000);
      const body = continuationBody(FakeXHR);
      expect(body).toContain('<turn_tool_summary>');
      expect(body).toMatch(/shell_exec\{command:echo a\} → failed: host-down \(\d+ms\)/);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
