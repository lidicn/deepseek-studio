// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * ㊿-b ⑦ UI 侧交接（Core 卡 ㊿-b ① 交卷后 @UI 三条，2026-11-20）·要点 1：
 * 同一响应出现多个工具标签时，页端按出现顺序**逐个**投递（串行链），不再并发。
 * 宿主侧 turn-serial-guard 按 conversationId|turnId 排队（只读）／拒绝（写类）；
 * 页端若并发投递，第二枚写类标签必然白吃一次 concurrent-mutation-blocked 拒绝。
 *
 * 判据（驱动方式照 duplicate-tool-signature：FakeXHR + RESPONSE 帧固件 + fake timers）：
 *   ① 同一响应两枚工具标签 ⇒ 第二枚只在第一枚 settle 后才开始（按出现顺序逐个）；
 *   ② 被拒投递（concurrent-mutation-blocked）不自动重发同一发（该 call 恰 1 次），
 *      且断链不连坐：后续标签在前一枚 settle 后照常投递；
 *   ③ 新用户 turn（新 chat_session_id ⇒ onNewUserMessage）重置串行链：
 *      上一 turn 未结算的在飞投递不阻塞新 turn 的首枚（与宿主 guard 键同口径）。
 *
 * 负控（logs/ui-b47-negctl/ 副本树，真实现零触碰）：把投递改回 fire-and-forget
 * （HEAD 版 `void sender(...)` 形态）⇒ ①必红（两枚并发开始）。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'turn-ser-stub' })),
}));

import { installMainWorldInterceptor, type ToolCallRequest } from '../../src/inject/main-world-interceptor';
import type { ExecuteResult } from '../../src/capabilities/types';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n' +
    'event: close\ndata: {"click_behavior":"none"}\n\n';
}
/** 同一 RESPONSE 帧内两枚工具标签（按出现顺序 echo a → echo b）。 */
function sseTwoTools(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo a\\"}</shell_exec><shell_exec>{\\"command\\":\\"echo b\\"}</shell_exec>"}]}\n\n';
}
function sseOneTool(command: string): string {
  return `data: ${JSON.stringify({ v: [{ type: 'RESPONSE', content: `<shell_exec>${JSON.stringify({ command })}</shell_exec>` }] })}\n\n`;
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

/** sender：探针（mcp.list/skill.list）即答；工具调用进门闸（手动放行），投递开始记 startLog。 */
function installHarness(overrides: { rejectCommand?: string } = {}) {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const startLog: string[] = [];
  const gates: Array<{ label: string; resolve: (r: unknown) => void }> = [];
  const sender = vi.fn((req: ToolCallRequest): Promise<ExecuteResult> => {
    if (req.invocationName === 'mcp.list') return Promise.resolve({ ok: true, data: { tools: [] } });
    if (req.invocationName === 'skill.list') return Promise.resolve({ ok: true, data: { skills: [] } });
    const command = String(req.params.command ?? '');
    const label = `${req.invocationName}:${command}`;
    startLog.push(label);
    // 被拒的那枚（concurrent-mutation-blocked 模拟）：立即结算、不进门闸。
    if (overrides.rejectCommand && command === overrides.rejectCommand) {
      return Promise.resolve({
        ok: false,
        error: `concurrent-mutation-blocked: 同轮并发写/执行类调用被串行护栏拒绝（未被执行），请等上一条结果返回后重发`,
        terminate: true,
      });
    }
    return new Promise<ExecuteResult>((resolve) => {
      gates.push({ label, resolve: (v: unknown) => resolve(v as never) });
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
  return { FakeXHR, handle, sender, startLog, gates };
}

function fireRound(FakeXHR: unknown, sessionId: string, payload: string): void {
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
  x.respond(200, payload);
}

describe('㊿-b ⑦ 要点 1①：同一响应多标签按出现顺序逐个投递（串行链）', () => {
  it('两枚标签：第二枚只在第一枚 settle 后才开始', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, startLog, gates } = installHarness();
    try {
      fireRound(FakeXHR, 'ts-1', sseTwoTools() + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 两枚都已被解析（同一帧），但第二枚尚未投递——串行链等第一枚 settle。
      expect(startLog).toEqual(['shell_exec:echo a']);
      expect(gates).toHaveLength(1);
      // 放行第一枚（terminate ⇒ 该轮自包含、不串 auto-continue）：第二枚此时才开始。
      gates[0].resolve({ ok: true, data: { stdout: 'a', exitCode: 0 }, terminate: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(startLog).toEqual(['shell_exec:echo a', 'shell_exec:echo b']);
      expect(gates).toHaveLength(2);
      gates[1].resolve({ ok: true, data: { stdout: 'b', exitCode: 0 }, terminate: true });
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('㊿-b ⑦ 要点 1②：被拒投递不重发同一发、不阻塞后续标签', () => {
  it('首枚回 concurrent-mutation-blocked（terminate）⇒ 恰投 1 次；次枚照常投递', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender, startLog, gates } = installHarness({ rejectCommand: 'echo a' });
    try {
      fireRound(FakeXHR, 'ts-2', sseTwoTools() + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 被拒那枚 settle（reject 分支立即结算）⇒ 串行链放第二枚。
      expect(startLog).toEqual(['shell_exec:echo a', 'shell_exec:echo b']);
      // 同一发不重发：echo a 的投递恰 1 次（拒绝不是「没跑」，不会自动重试）。
      const aCalls = (sender.mock.calls as unknown[][]).filter(
        (c) => (c[0] as { params: Record<string, unknown> }).params?.command === 'echo a',
      );
      expect(aCalls).toHaveLength(1);
      // 后续标签未被断链阻塞（门闸在等放行即证明已投递）。
      expect(gates.map((g) => g.label)).toEqual(['shell_exec:echo b']);
      gates[0].resolve({ ok: true, data: { stdout: 'b', exitCode: 0 }, terminate: true });
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('㊿-b ⑦ 要点 1③：新 turn 重置串行链（在飞残留不阻塞新首枚）', () => {
  it('上一 turn 有未结算在飞投递 ⇒ 新 turn 首枚照常立即投递', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, startLog, gates } = installHarness();
    try {
      // turn 1：一枚标签进门闸、故意不放行。
      fireRound(FakeXHR, 'ts-3a', sseOneTool('echo c') + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      expect(startLog).toEqual(['shell_exec:echo c']);
      expect(gates).toHaveLength(1);
      // turn 2（新 chat_session_id ⇒ 新用户消息 ⇒ onNewUserMessage ⇒ 链重置）。
      fireRound(FakeXHR, 'ts-3b', sseOneTool('echo d') + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 新 turn 首枚未被旧 turn 在飞尾巴阻塞。
      expect(startLog).toEqual(['shell_exec:echo c', 'shell_exec:echo d']);
      expect(gates).toHaveLength(2);
      gates[0].resolve({ ok: true, data: { stdout: 'c' }, terminate: true });
      gates[1].resolve({ ok: true, data: { stdout: 'd' }, terminate: true });
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
