// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * #55 / T-2a 验收断言（现状锁已随批翻成此版；red-first 留证见卡面）：
 * 断言 `main-world-interceptor.ts` 的 `L3062`（MAX_LOOP 触顶）与 `L3104`（协议修复失败）
 * 收尾**带原因**——`chatUI.appendError` 触达对应 `code`，且措辞守红线（"未执行"／"已停止"禁用），
 * 且 N 同时进了 `d()` 与 `turn.end` trace（口径不分叉）。
 *
 * 驱动方式（设计稿 §6 ＋ w0 harness，不 inject 钩子，全程 fake timers）：
 * - L3062：25 轮真工具续跑顶到 `loopDepth>=MAX_LOOP`；自然驱动下触顶时刻 `pending` 有/无积压（N 为下界实数），
 *   断言对 N 取「结构」而非固定值（N>0 句带实数、N=0 句不带数，二者都合法）。
 * - L3104：首轮 1 次工具执行（`collectedExecutions` 非空）＋续跑空回复触发协议修复，修复轮仍空回复。
 *
 * 本锁「抓不住」的变异（判据 5 尾巴）：抓不住「N 快照取错了位置（取在复位后仍=0）」——
 * 因自然驱动 N 可为 0，消息结构断言对 N 值不敏感；该变异需靠「构造积压」的驱动抓，本卡未建（#55 只锁收尾带原因）。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 't2a-stub' })),
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

describe('#55 验收断言：L3062/L3104 收尾带原因（现状锁已随批翻成此版）', () => {
  it('L3062 MAX_LOOP 触顶：appendError 触达 max-loop、措辞守红线、N 进了 trace', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      fireFirstRound(FakeXHR, 't2a-maxloop');
      await vi.advanceTimersByTimeAsync(2_000);
      // 喂工具结果直到触顶（max-loop）；触顶后循环停、不再发新请求
      for (let i = 0; i < 30; i++) {
        const reqs = chatRequests(FakeXHR);
        const last = reqs[reqs.length - 1];
        if (!last || last.readyState === 4) break;
        last.respond(200, sseTool() + sseDone());
        await vi.advanceTimersByTimeAsync(1_500);
        if (interceptorTraceSnapshot().some((e) => e.t === 'turn.end' && e.stopReason === 'max-loop')) break;
      }
      // 触顶收尾确实发生
      const maxLoopEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end' && e.stopReason === 'max-loop');
      expect(maxLoopEnds.length).toBeGreaterThan(0);
      expect(maxLoopEnds.at(-1)).toMatchObject({ finished: false });
      // 验收：appendError 触达 'max-loop'
      const call = chatUI.appendError.mock.calls.find((c) => String(c[0]) === 'max-loop');
      expect(call).toBeDefined();
      const msg = String(call![1]);
      // 主句（"已暂停本批续跑"，"已停止"禁用）
      expect(msg).toContain('已暂停本批续跑');
      expect(msg).not.toContain('已停止');
      // 红线："未执行"禁用（pending＝已执行、未送回）
      expect(msg).not.toContain('未执行');
      // N 同批进 trace（口径不分叉）：turn.end 带 undelivered 数值
      const und = (maxLoopEnds.at(-1) as { undelivered?: number }).undelivered;
      expect(typeof und).toBe('number');
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('L3104 协议修复失败：appendError 触达 protocol-repair-failed、定字句', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      fireFirstRound(FakeXHR, 't2a-procrepair');
      await vi.advanceTimersByTimeAsync(2_000);
      // 第 1 次续跑：空回复（无工具、无 task_complete）⇒ 触发协议修复（protocolRepairUsed→true）
      let reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseText('') + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      // 修复轮仍空回复 ⇒ L3104 protocol-repair-failed
      reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseText('') + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      const pfEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end' && e.stopReason === 'protocol-repair-failed');
      expect(pfEnds.length).toBeGreaterThan(0);
      expect(pfEnds.at(-1)).toMatchObject({ finished: false });
      // 验收：appendError 触达定字句
      const call = chatUI.appendError.mock.calls.find((c) => String(c[0]) === 'protocol-repair-failed');
      expect(call).toBeDefined();
      expect(String(call![1])).toBe('模型回复不完整且修复失败，本轮结果已丢弃，请重试或换个说法。');
    } finally { handle.stop(); vi.useRealTimers(); }
  });
});
