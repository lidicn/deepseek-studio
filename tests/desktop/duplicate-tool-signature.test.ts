// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-14 登录卡死修复（出资人报「studio 工具调用还是有问题」，trace-2026-11-14.jsonl
 * turnId tmwfslyyg：一条流内同一工具标记被反复重解析 → ~714 枚 duplicate-tool-signature 刷屏、
 * 页面卡住 2 分钟）的回归锁。
 *
 * 判据（PM 卡）：
 *   ① 同流同签名重复投递 ⇒ 第一枚真执行、后续每枚拿到 duplicate-tool-signature 回执、
 *      且重复次数被封顶（MAX_SIG_REDELIVERIES=3）；
 *   ② 跨流同签名 ⇒ 照旧**放行**（N2-03：跨流重跑合法，反向锁防「顺手修成全局去重」）；
 *   ③ 封顶后该 turn 仍正常出 turn.end（不许变成另一种静默死锁）；
 *   负控：① 封顶阈值改极大 ⇒ ①红；② 反向锁改跨流共享（去掉按流重置）⇒ ②红。
 * PM 裁补强（2026-11-14）：
 *   - n=3（封顶前最后一枚）回执终局语义「停止重发本调用」（n=1,2 保持「见前一次」）；
 *   - ③ 根因取证：pending 段闭合判定补 pending-closure trace（closed/unclosed＋围栏计数），
 *     复验读数口径：重复投递 ≤3 但报 unclosed（奇数围栏）⇒ 根因在闭合判定、不在封顶。
 *
 * 驱动方式照 t2a-finish-reason（FakeXHR + RESPONSE 帧固件 + fake timers，已证可命中工具执行）：
 *   - 同流重复＝一条 respond 里给 N 枚同签名标记（模型反复重解析同一标记的等价触发）；
 *   - 观测面＝`interceptorTraceSnapshot()`：`tool.exec{ok:false}` 计数＝封顶内重复回执数、
 *     `continuation.decision{reason:'duplicate-tool-signature'}` 计数＝合并后 ≤2（首枚 count=1
 *     ＋封顶穿越 count=4）、`turn.end` 存在＝该轮仍收尾。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'dup-test-stub' })),
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
/** 同签名工具标记（shell_exec echo hi）——RESPONSE 帧形态（t2a 已证可被解析执行）。 */
function sseTool(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo hi\\"}</shell_exec>"}]}\n\n';
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
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  };
}

function installHarness() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  // terminate:true ⇒ 工具结果返回后跳过 auto-continue（shouldSkipAutoContinue 闸门），
  // 让每一轮自包含、不串轮；shell_exec 真执行 1 次即收口。
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    if (req.invocationName === 'shell_exec') return { ok: true, data: { stdout: 'hi', exitCode: 0 }, terminate: true };
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
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
  open: (m: string, u: string) => void;
  onreadystatechange: (() => void) | undefined;
  send: (body?: unknown) => void;
  respond: (status: number, text: string) => void;
};
function fireRound(FakeXHR: unknown, sessionId: string, payload: string): void {
  const XHR = FakeXHR as new () => FakeXHRInstance;
  const x = new XHR();
  x.open('POST', CHAT_URL);
  x.onreadystatechange = () => {};
  x.send(JSON.stringify({ prompt: 'run it', chat_session_id: sessionId }));
  x.respond(200, payload);
}

function chatRequests(FakeXHR: unknown) {
  const XHR = FakeXHR as { instances: unknown[] };
  return (XHR.instances as Array<{ url: string; readyState: number; respond: (s: number, t: string) => void; body: string | null }>).filter(
    (x) => x.url.endsWith('/api/v0/chat/completion'),
  );
}

/** 只统计某工具的真执行（排除 mcp.list / skill.list 探测）。 */
function toolExecs(sender: ReturnType<typeof vi.fn>, name = 'shell_exec') {
  return (sender.mock.calls as unknown[][]).filter(
    (c) => (c[0] as { invocationName: string }).invocationName === name,
  );
}

/** 取某 turn 的事件（按最近的 turn.start 归属）。 */
function lastTurnEvents(): Array<{ t: string; reason?: string; ok?: boolean; name?: string; count?: number; stopReason?: string }> {
  const evs = interceptorTraceSnapshot();
  const starts = evs.filter((e) => e.t === 'turn.start') as Array<{ turnId: string }>;
  const turnId = starts.length ? starts[starts.length - 1].turnId : '';
  return evs.filter((e) => e.turnId === turnId) as ReturnType<typeof lastTurnEvents>;
}

describe('判据 4①：同流同签名重复投递 ⇒ 首枚真执行、后续拿回执、次数被封顶', () => {
  it('一条流 10 枚同签名：真执行 1 次；重复回执封顶 3 枚（非 9 枚）；trace 合并 ≤2 枚（非刷屏）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender } = installHarness();
    try {
      // 一条流内同一标记重投递 10 次（等价于模型反复重解析同一标记）。
      fireRound(FakeXHR, 'dup-cap', sseTool().repeat(10) + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);

      // 首枚真执行：shell_exec 真投递宿主恰 1 次。
      expect(toolExecs(sender)).toHaveLength(1);

      const evs = lastTurnEvents();
      // 重复回执封顶：tool.exec{ok:false, shell_exec} 恰为 MAX(3) 枚（n=1,2,3），不是 9 枚。
      const dupReceipts = evs.filter((e) => e.t === 'tool.exec' && e.name === 'shell_exec' && e.ok === false);
      expect(dupReceipts).toHaveLength(3);

      // trace 合并：duplicate-tool-signature 的 continuation.decision 只记首枚(count=1)＋封顶穿越(count=4)，共 2 枚。
      const dupDec = evs.filter(
        (e) => e.t === 'continuation.decision' && e.reason === 'duplicate-tool-signature',
      );
      expect(dupDec).toHaveLength(2);
      expect(dupDec.map((e) => e.count)).toEqual([1, 4]);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('判据 4②：跨流同签名照旧放行（N2-03 反向锁）', () => {
  it('两条独立流各发同一工具：两次都真执行（封顶/去重按流清空，不跨流共享）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender } = installHarness();
    try {
      // 流 1（用户消息 1）：1 枚 → 真执行。
      fireRound(FakeXHR, 'cs-1', sseTool() + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 流 2（用户消息 2＝新用户消息 → 新 turn → beginStream → onStreamBegin → resetSignatures/清封顶）：
      // N2-03 口径：跨流重跑是合法再次执行，必须仍放行。
      fireRound(FakeXHR, 'cs-2', sseTool() + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      expect(toolExecs(sender)).toHaveLength(2);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('判据 4③：封顶后该 turn 仍正常出 turn.end（不变成另一种静默死锁）', () => {
  it('10 枚同签名封顶后，把自动续跑续到无工具收尾：本 turn 有 turn.end（不悬空）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      fireRound(FakeXHR, 'dup-end', sseTool().repeat(10) + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 封顶后自动续跑会发一条续跑请求（pending 有回执积压）；给它一个「无工具」回复，
      // 该 turn 就应正常收尾出 turn.end（completed/no-tools）——证明封顶没有造出另一种死锁。
      for (let i = 0; i < 6; i++) {
        const reqs = chatRequests(FakeXHR);
        const open = reqs[reqs.length - 1];
        if (!open || open.readyState === 4) break;
        open.respond(200, sseText('任务完成。') + sseDone());
        await vi.advanceTimersByTimeAsync(2_000);
      }
      const ends = lastTurnEvents().filter((e) => e.t === 'turn.end');
      expect(ends.length).toBeGreaterThanOrEqual(1);
      const last = ends[ends.length - 1] as { stopReason?: string };
      expect(typeof last.stopReason).toBe('string');
      expect(last.stopReason).not.toBe('');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('PM 裁补强（2026-11-14）：封顶前最后一枚回执（n=3）终局语义', () => {
  it('n=1,2 保持「见前一次」；n=3 说「停止重发本调用」（自动续跑重注入面可观测）', async () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
    // 不 terminate：让自动续跑真发生，回执才会被重注入 prompt（观测面）——
    // 共享 installHarness 的 terminate 桩会跳过续跑、回执永远到不了模型。
    const sender = vi.fn(async (req: { invocationName: string }) => {
      if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
      if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
      return { ok: true, data: { stdout: 'hi', exitCode: 0 } };
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
    try {
      fireRound(FakeXHR, 'term-3', sseTool().repeat(10) + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      // 把自动续跑请求续到无工具收尾（驱动模式同判据 4③）。
      for (let i = 0; i < 6; i++) {
        const reqs = chatRequests(FakeXHR);
        const open = reqs[reqs.length - 1];
        if (!open || open.readyState === 4) break;
        open.respond(200, sseText('任务完成。') + sseDone());
        await vi.advanceTimersByTimeAsync(2_000);
      }
      // 自动续跑请求的 body＝重注入 prompt（含 3 枚折叠回执）：
      const bodies = chatRequests(FakeXHR).map((r) => r.body).filter((b): b is string => !!b);
      const cont = bodies.slice(1).join('\n');
      expect(cont).toContain('停止重发本调用'); // n=3 终局语义（与 Core 终局文案同向）
      expect(cont).toContain('结果见前一次'); // n=1,2 保留原措辞
      expect(cont).toContain('duplicate-tool-signature:'); // 前缀接头（Core 抽码锚点）不可丢
    } finally {
      handle.stop();
      vi.useRealTimers();
      (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    }
  });
});

describe('判据 ③ 根因取证：pending 段闭合判定 trace（closed/unclosed ＋ 围栏计数）', () => {
  it('标记 pending 未闭合＋围栏奇数 ⇒ trace 有 pending-closure:unclosed(fences=1)', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      // 可见文本里 1 枚未闭合 ```（奇数）＋未闭合 shell_exec 标记（pending tail），流正常终止。
      fireRound(FakeXHR, 'pc-unclosed', sseText('pre```<shell_exec>{"a":```') + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      const closure = lastTurnEvents().filter(
        (e) => e.t === 'continuation.decision' && typeof e.reason === 'string' && e.reason.startsWith('pending-closure'),
      );
      expect(closure.map((e) => e.reason)).toContain('pending-closure:unclosed(fences=1)');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('标记闭合 ⇒ 闭合判定报 closed(fences=0)（复验时用来排除根因在闭合判定）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle } = installHarness();
    try {
      fireRound(FakeXHR, 'pc-closed', sseTool() + sseDone());
      await vi.advanceTimersByTimeAsync(3_000);
      const closure = lastTurnEvents().filter(
        (e) => e.t === 'continuation.decision' && typeof e.reason === 'string' && e.reason.startsWith('pending-closure'),
      );
      expect(closure.map((e) => e.reason)).toContain('pending-closure:closed(fences=0)');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
