// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * ⑨ 熔断接线回归锁（2026-11-15 PM 卡：shared evaluateTerminalFuse 判定面 → 注入层守卫＋
 * 用户可见文案两副）。
 *
 * 判据（PM 裁定原文）：
 *   - 非终局轴（NON_TERMINAL_FUSE_THRESHOLD=5）**不得宣称「已停止／不再重试」**（它是循环
 *     保护，不是宿主拒绝，问题可能自愈）；
 *   - 终局轴（TERMINAL_FUSE_THRESHOLD=3）才用「这条不会再重试」；
 *   - 两副都必须满足「用户看得见一句交代」（chatUI.appendError 面）；
 *   - `every` 语义的 terminate 闸门不动（本锁只验 fuse 分支）。
 *
 * 驱动方式同 duplicate-tool-signature（FakeXHR＋RESPONSE 帧固件＋fake timers）：
 *   - 终局轴：3 枚同工具不同参调用，宿主各回 `ok:false` 且错误含终局码 consent-denied；
 *   - 通用轴：5 枚同工具不同参调用，宿主各回 `ok:false` 且错误首行相同（可重试形态
 *     ETIMEDOUT）；
 *   - 低于阈值（4 枚可重试）：不熔断、照旧自动续跑（防过熔）。
 *
 * 负控：把熔断判定入参换成空表（等价拆掉接线）⇒ 终局轴用例必须红（可见交代消失、
 * 自动续跑请求出现）。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'fuse-test-stub' })),
}));

import {
  installMainWorldInterceptor,
  interceptorTraceSnapshot,
} from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n' +
    'event: close\ndata: {"click_behavior":"none"}\n\n';
}
function sseText(text: string): string {
  return `data: ${JSON.stringify({ v: text })}\n\n`;
}
/** 同工具不同参的一枚 RESPONSE 帧（参数不同 ⇒ 签名不同 ⇒ 不会被 duplicate 折叠）。 */
function sseToolFrame(name: string, params: Record<string, unknown>): string {
  const content = `<${name}>${JSON.stringify(params)}</${name}>`;
  return `data: ${JSON.stringify({ v: [{ type: 'RESPONSE', content }] })}\n\n`;
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

type SenderImpl = (req: { invocationName: string; params: Record<string, unknown> }) => Promise<{ ok: boolean; error?: string; data?: unknown }>;

function installHarness(senderImpl: SenderImpl) {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async (req: { invocationName: string; params: Record<string, unknown> }) => {
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    return senderImpl(req);
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
  return { FakeXHR, handle, sender, chatUI };
}

type FakeXHRInstance = {
  url: string;
  readyState: number;
  respond: (s: number, t: string) => void;
  body: string | null;
};

function fireRound(FakeXHR: unknown, sessionId: string, payload: string): void {
  const XHR = FakeXHR as new () => {
    open: (m: string, u: string) => void;
    onreadystatechange: (() => void) | undefined;
    send: (b?: unknown) => void;
    respond: (s: number, t: string) => void;
  };
  const x = new XHR();
  x.open('POST', CHAT_URL);
  x.onreadystatechange = () => {};
  x.send(JSON.stringify({ prompt: 'run it', chat_session_id: sessionId }));
  x.respond(200, payload);
}

function chatRequests(FakeXHR: unknown): FakeXHRInstance[] {
  const XHR = FakeXHR as { instances: unknown[] };
  return (XHR.instances as unknown as FakeXHRInstance[]).filter(
    (x) => x.url.endsWith('/api/v0/chat/completion'),
  );
}

/** 取某 turn 的事件（按最近的 turn.start 归属）。 */
function lastTurnEvents(): Array<{ t: string; reason?: string; count?: number; stopReason?: string }> {
  const evs = interceptorTraceSnapshot() as unknown as Array<{ t: string; turnId?: string; reason?: string; count?: number; stopReason?: string }>;
  const starts = evs.filter((e) => e.t === 'turn.start');
  const turnId = starts.length ? starts[starts.length - 1].turnId : '';
  return evs.filter((e) => e.turnId === turnId) as ReturnType<typeof lastTurnEvents>;
}

function appendErrorCalls(chatUI: { appendError: ReturnType<typeof vi.fn> }): Array<[string, string]> {
  return (chatUI.appendError.mock.calls as unknown[]).map((c) => {
    const call = c as unknown[];
    return [String(call[0]), String(call[1] ?? '')];
  });
}

describe('⑨ 熔断接线：终局轴 ⇒ 可见交代含「这条不会再重试」', () => {
  it('3 枚同工具不同参、宿主回 consent-denied ⇒ fuse-terminal 可见交代＋停止续跑', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness(async (req) => ({
      ok: false,
      error: `调用被策略拒绝（consent-denied）：${req.params.command}`,
    }));
    try {
      const frames = [
        sseToolFrame('shell_exec', { command: 'echo a' }),
        sseToolFrame('shell_exec', { command: 'echo b' }),
        sseToolFrame('shell_exec', { command: 'echo c' }),
      ].join('');
      fireRound(FakeXHR, 'fuse-term', frames + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);

      // 用户可见交代挂出（appendError 面），终局轴才许写「这条不会再重试」。
      const calls = appendErrorCalls(chatUI);
      const fuseTerm = calls.find((c) => c[0] === 'fuse-terminal');
      expect(fuseTerm).toBeDefined();
      expect(fuseTerm![1]).toContain('这条不会再重试');
      expect(fuseTerm![1]).toContain('shell_exec');
      expect(fuseTerm![1]).toContain('3');

      // trace：continuation.decision{reason:'fuse-terminal', count:3}＋turn.end。
      const evs = lastTurnEvents();
      const dec = evs.filter((e) => e.t === 'continuation.decision' && e.reason === 'fuse-terminal');
      expect(dec).toHaveLength(1);
      expect(dec[0].count).toBe(3);
      expect(evs.some((e) => e.t === 'turn.end' && e.stopReason === 'fuse-terminal')).toBe(true);

      // 熔断＝停：不得有自动续跑请求（只有用户那一枚）。
      expect(chatRequests(FakeXHR)).toHaveLength(1);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑨ 熔断接线：非终局轴 ⇒ 可见交代不得宣称「已停止／不再重试」', () => {
  it('5 枚同工具不同参、宿主回可重试错误（首行相同）⇒ fuse-non-terminal，措辞含自愈出口', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness(async (req) => ({
      ok: false,
      error: `ETIMEDOUT: connect timeout\nattempt for ${req.params.command}`,
    }));
    try {
      const frames = [
        sseToolFrame('shell_exec', { command: 'echo a' }),
        sseToolFrame('shell_exec', { command: 'echo b' }),
        sseToolFrame('shell_exec', { command: 'echo c' }),
        sseToolFrame('shell_exec', { command: 'echo d' }),
        sseToolFrame('shell_exec', { command: 'echo e' }),
      ].join('');
      fireRound(FakeXHR, 'fuse-nonterm', frames + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);

      const calls = appendErrorCalls(chatUI);
      const fuseNon = calls.find((c) => c[0] === 'fuse-non-terminal');
      expect(fuseNon).toBeDefined();
      const msg = fuseNon![1];
      // 非终局轴硬判据（PM）：不许宣称已停止／不再重试；要给出「可能自愈＋稍后重试」出口。
      expect(msg).not.toContain('不再重试');
      expect(msg).not.toContain('这条不会再');
      expect(msg).toContain('可能自行恢复');
      expect(msg).toContain('shell_exec');
      expect(msg).toContain('5');

      const evs = lastTurnEvents();
      const dec = evs.filter((e) => e.t === 'continuation.decision' && e.reason === 'fuse-non-terminal');
      expect(dec).toHaveLength(1);
      expect(dec[0].count).toBe(5);
      expect(chatRequests(FakeXHR)).toHaveLength(1); // 同样停续跑
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑨ 熔断接线：低于阈值不得过熔', () => {
  it('4 枚可重试失败（<5）⇒ 不挂 fuse 交代、照旧自动续跑', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness(async (req) => ({
      ok: false,
      error: `ETIMEDOUT: connect timeout\nattempt for ${req.params.command}`,
    }));
    try {
      const frames = [
        sseToolFrame('shell_exec', { command: 'echo a' }),
        sseToolFrame('shell_exec', { command: 'echo b' }),
        sseToolFrame('shell_exec', { command: 'echo c' }),
        sseToolFrame('shell_exec', { command: 'echo d' }),
      ].join('');
      fireRound(FakeXHR, 'fuse-below', frames + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);

      expect(appendErrorCalls(chatUI).some((c) => c[0].startsWith('fuse-'))).toBe(false);
      // 未熔断 ⇒ 自动续跑请求应已发出（第 2 枚 chat 请求）；续到无工具收尾。
      let reqs = chatRequests(FakeXHR);
      expect(reqs.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < 6; i++) {
        const open = reqs[reqs.length - 1];
        if (!open || open.readyState === 4) break;
        open.respond(200, sseText('任务完成。') + sseDone());
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(lastTurnEvents().some((e) => e.t === 'turn.end')).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
