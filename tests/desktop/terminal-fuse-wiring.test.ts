// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

// ㊿-c-补⑫ 件④：jsdom 的 window.confirm 未实现，注入层同文护栏会调它落 stderr。
// 全局 stub 为返回 true（确认放行）：不弹真框、不拦截。
beforeAll(() => {
  (window as unknown as Record<string, unknown>).confirm = () => true;
});

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
  const handle = installMainWorldInterceptor({ riskSafeMode: false, 
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

/**
 * ㊿-c-补⑥（2026-11-24 出资人实测卡）：terminate 透传断链＋熔断判定面用错桶。
 *
 * 现场（装版 storage.json 会话 739dd0c0491d39c2）：memory_save ×10 每枚
 * `ok=false err="memory-save-needs-explicit-instruction"` 且宿主已带 `terminate:true`，
 * 但续跑闸门（shouldSkipAutoContinue，every 语义）拿到的全是 undefined ⇒ 恒 false ⇒
 * 空转 10 轮，出资人要的 mcp_list 一次没调。两处接线缺陷：
 *   1. `pr` 构造（success 支）没把 `r.terminate` 落进 `PendingResult`；
 *   2. 熔断判定面吃 `pending`（每轮 L1957 清零），文档口径是跨轮累积的
 *      `collectedExecutions`（一个 user turn 的熔断寿命）。
 *
 * 三格判据（卡面）：
 *   ① terminate 透传后单轮全 terminate ⇒ 闸门（shouldSkipAutoContinue）收掉续跑；
 *   ② 跨轮累积到 3 枚终局拒绝 ⇒ 熔断（判定面吃 collectedExecutions 才能看到跨轮）；
 *   ③ 跨轮未达 3 且无 terminate ⇒ 不熔断、照常续跑（防误杀）。
 */
describe('㊿-c-补⑥ terminate 透传与熔断判定面', () => {
  it('① 单轮一枚终局拒绝带 terminate ⇒ 闸门收掉续跑（缺陷一直接验证）', async () => {
    vi.useFakeTimers();
    // 宿主回 memory_save 终局拒绝且带 terminate:true（withTerminalSignal 已加）——
    // 注入层必须把它透传到 PendingResult.terminate，闸门（every 语义）才收得掉。
    const { FakeXHR, handle, chatUI } = installHarness(async () => ({
      ok: false,
      error: 'memory-save-needs-explicit-instruction',
      terminate: true,
    }));
    try {
      // 单轮一枚 memory_save（带 terminate）。
      fireRound(FakeXHR, 'term-one', sseToolFrame('memory_save', { key: 'k', value: 'v' }) + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);

      // 闸门（shouldSkipAutoContinue，every）看到整批 terminate ⇒ 跳过续跑：
      // 没有自动续跑请求（chatRequests 只有用户那一枚），且 trace 记 terminate 决策。
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      const evs = lastTurnEvents();
      expect(evs.some((e) => e.t === 'continuation.decision' && e.reason === 'terminate')).toBe(true);
      // 可见交代不是 fuse（没到 3 枚终局），而是正常 terminate 收场。
      expect(appendErrorCalls(chatUI).some((c) => c[0].startsWith('fuse-'))).toBe(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('② 跨续跑轮累积 3 枚同工具终局拒绝 ⇒ 熔断（判定面吃 collectedExecutions）', async () => {
    vi.useFakeTimers();
    // 每轮一枚 memory_save 终局拒绝（不带 terminate——靠熔断轴累计，不靠 terminate 闸门），
    // 跨 3 个续跑轮累积到 TERMINAL_FUSE_THRESHOLD=3。
    // 关键：`pending` 每轮 L1957 清零，若判定面仍吃 pending，桶计数恒 1、永不熔断；
    // 切到 collectedExecutions 后跨轮可见 ⇒ 第 3 枚触发 fuse-terminal。
    const { FakeXHR, handle, chatUI } = installHarness(async () => ({
      ok: false,
      error: 'memory-save-needs-explicit-instruction',
    }));
    try {
      // 轮 1：一枚 memory_save。
      fireRound(FakeXHR, 'fuse-xturn', sseToolFrame('memory_save', { key: 'a', value: '1' }) + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 续跑轮 2、轮 3 各再一枚（同工具同终局码，不同参 ⇒ 不被 duplicate 折叠）。
      for (let round = 2; round <= 4; round++) {
        const open = chatRequests(FakeXHR);
        const last = open[open.length - 1];
        if (!last || last.readyState === 4) break;
        // 续跑请求已被自动发出（未熔断、无 terminate ⇒ 闸门放行）；
        // 回一帧含 memory_save 终局拒绝的响应，累积到第 3 枚。
        last.respond(200, sseToolFrame('memory_save', { key: `k${round}`, value: 'x' }) + sseDone());
        await vi.advanceTimersByTimeAsync(3_000);
      }
      // 第 3 枚终局拒绝后：fuse-terminal 可见交代挂出（跨轮累积 3 枚达成阈值）。
      const calls = appendErrorCalls(chatUI);
      const fuseTerm = calls.find((c) => c[0] === 'fuse-terminal');
      expect(fuseTerm).toBeDefined();
      expect(fuseTerm![1]).toContain('memory_save');
      expect(fuseTerm![1]).toContain('这条不会再重试');
      // 熔断后不再发续跑：chat 请求数封顶（用户 1 + 续跑 2 = 3，第 3 枚拒绝后熔断停）。
      expect(chatRequests(FakeXHR).length).toBeLessThanOrEqual(4);
      const evs = lastTurnEvents();
      expect(evs.some((e) => e.t === 'turn.end' && e.stopReason === 'fuse-terminal')).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('③ 跨轮累积未达 3 且无 terminate ⇒ 不熔断、照常续跑（防误杀）', async () => {
    vi.useFakeTimers();
    // 2 枚同工具终局拒绝（< 3）且不带 terminate ⇒ 既不到熔断阈值、也不走 terminate 闸门。
    const { FakeXHR, handle, chatUI } = installHarness(async () => ({
      ok: false,
      error: 'memory-save-needs-explicit-instruction',
    }));
    try {
      fireRound(FakeXHR, 'fuse-below-x', sseToolFrame('memory_save', { key: 'a', value: '1' }) + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 续跑轮 2：再一枚（累计 2 < 3）。
      const open = chatRequests(FakeXHR);
      const last = open[open.length - 1];
      if (last && last.readyState !== 4) {
        last.respond(200, sseToolFrame('memory_save', { key: 'b', value: '2' }) + sseDone());
        await vi.advanceTimersByTimeAsync(3_000);
      }
      // 未达阈值 ⇒ 不挂 fuse 交代；且无 terminate ⇒ 闸门放行，续跑照常。
      expect(appendErrorCalls(chatUI).some((c) => c[0].startsWith('fuse-'))).toBe(false);
      // 续跑请求已发出（第 2 枚）⇒ 没被误杀。
      expect(chatRequests(FakeXHR).length).toBeGreaterThanOrEqual(2);
      expect(lastTurnEvents().some((e) => e.t === 'turn.end' && e.stopReason === 'fuse-terminal')).toBe(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
