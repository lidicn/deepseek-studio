// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * R3-03：页端 finish-sentinel 发送端。
 *
 * 宿主侧（page-runtime/web-engine）接收与判停早已就绪，但页端此前缺发送端，
 * 导致 `interrupted` 终态不可达（死代码）。本卡补发送端，并锁住 A 发 B 收的契约：
 *   - 打**真实入口** installMainWorldInterceptor（非私有函数）；
 *   - 走**真实发送链路**：onFinishSentinel → host.finishSentinel → ws.send（createHostClient + 可注入 wsFactory）；
 *   - payload 逐字对齐 `src/host/protocol.ts`：`{ type:'finish-sentinel', round, sawFinishSentinel }`；
 *   - 有哨兵 → sawFinishSentinel=true；无哨兵（有内容但断流）→ false；空流（0 字节）→ 不发；
 *   - 每轮只发一次（round = 页端本轮单调序号，非时间戳）。
 *   - 负控：把发送那一行注释掉 → 用例转红（见文件底部 NEGATIVE-CONTROL 注释）。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r3-03-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';
import { createHostClient } from '../../src/desktop/host-client';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  // DeepSeek 的完成哨兵是 `response/status=FINISHED` 或 `event: close`，**不是** `data:[DONE]`。
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

/** 可注入的 fake ws：捕获 host-client 真正发到线上的每一帧。 */
function makeFakeWs() {
  const sent: string[] = [];
  const sockets: Array<{ onopen: ((ev?: unknown) => void) | null; readyState: number }> = [];
  const factory = (url: string) => {
    const ws = {
      url,
      readyState: 0,
      onopen: null as ((ev?: unknown) => void) | null,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onclose: null as ((ev?: unknown) => void) | null,
      onerror: null as ((ev?: unknown) => void) | null,
      send(data: string) { sent.push(data); },
      close() { this.readyState = 3; },
    };
    sockets.push(ws);
    return ws;
  };
  return { sent, sockets, factory };
}

/** 从线上帧里挑出 finish-sentinel 消息（走真实 JSON 序列化，非私有函数）。 */
interface FinishSentinelMsg { type: string; round: number; sawFinishSentinel: boolean }
function finishSentinelsOnWire(sent: string[]): FinishSentinelMsg[] {
  return sent
    .map((f) => { try { return JSON.parse(f) as Record<string, unknown>; } catch { return null; } })
    .filter((m): m is Record<string, unknown> => !!m && m.type === 'finish-sentinel')
    .map((m) => ({ type: m.type as string, round: m.round as number, sawFinishSentinel: m.sawFinishSentinel as boolean }));
}

/**
 * 装配真实链路：createHostClient（fake ws）+ installMainWorldInterceptor，
 * entry.ts 的装配方式把两者接起来（onFinishSentinel → host.finishSentinel）。
 */
function installRealChain() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/', origin: 'https://chat.deepseek.com' });
  const ws = makeFakeWs();
  const host = createHostClient({
    url: 'ws://127.0.0.1:8760/studio',
    capabilities: [],
    wsFactory: ws.factory,
  });
  // 真实入口：与 entry.ts:334 同构的装配。
  const handle = installMainWorldInterceptor({
    sender: vi.fn(async () => ({ ok: true, data: { stdout: 'hi', exitCode: 0 } })),
    chatUI: {
      sessionKey: 'r3-03:session',
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
    } as never,
    diag: () => {},
    onAssistantReply: vi.fn(),
    // 关键接线：页端发射器 → host-client → ws.send。
    onFinishSentinel: (info) => host.finishSentinel(info.round, info.sawFinishSentinel),
  });
  // 建立连接并翻到 OPEN，后续 host.finishSentinel 才会真正 send（未连接时 send 是 no-op）。
  host.connect();
  const sock = ws.sockets[0];
  sock.readyState = 1;
  sock.onopen?.();
  return { FakeXHR, handle, sent: ws.sent };
}

/** 发一条新用户消息（captureChatRequest 识别 `prompt` → round+1），再回响应。 */
function sendUserTurn(FakeXHR: ReturnType<typeof makeFakeXhrClass>, sessionId: string, body: string) {
  const req = new FakeXHR();
  req.open('POST', CHAT_URL);
  req.onreadystatechange = () => {};
  req.send(JSON.stringify({ prompt: 'hi', chat_session_id: sessionId }));
  req.respond(200, body);
  return req;
}

describe('R3-03：页端 finish-sentinel 发送端（真实入口 + 真实发送链路）', () => {
  it('有完成哨兵的流 → 发 {type,round,sawFinishSentinel:true}，round=本轮序号', () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sent } = installRealChain();
    try {
      // 首条新用户消息 → round 1；流带 FINISHED+close 哨兵。
      sendUserTurn(FakeXHR, 'r3-03-sentinel', sseText('你好') + sseDone());
      // 让 auto-continue 等定时器跑完，本轮收尾。
      vi.advanceTimersByTime(5_000);
      const fs = finishSentinelsOnWire(sent);
      // 每轮只发一次。
      expect(fs.length).toBe(1);
      // payload 逐字对齐 protocol.ts 的 finish-sentinel 形状（round 是本轮单调序号，
      // 跨用例累积，故断言「正整数」而非绝对值；绝对递增在下面「第二轮」用例锁）。
      expect(fs[0]).toEqual({ type: 'finish-sentinel', round: fs[0].round, sawFinishSentinel: true });
      expect(typeof fs[0].round).toBe('number');
      expect(fs[0].round).toBeGreaterThan(0);
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('有内容但无哨兵（断流）→ 发 sawFinishSentinel:false', () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sent } = installRealChain();
    try {
      sendUserTurn(FakeXHR, 'r3-03-nosentinel', sseText('回答到一半断了'));
      vi.advanceTimersByTime(5_000);
      const fs = finishSentinelsOnWire(sent);
      expect(fs.length).toBe(1);
      expect(fs[0]).toEqual({ type: 'finish-sentinel', round: fs[0].round, sawFinishSentinel: false });
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('空流（0 字节，no-stream）→ 不发', () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sent } = installRealChain();
    try {
      // 200 空响应体 = no-stream，不是截断；按契约不发，避免宿主侧噪音。
      sendUserTurn(FakeXHR, 'r3-03-empty', '');
      vi.advanceTimersByTime(5_000);
      expect(finishSentinelsOnWire(sent).length).toBe(0);
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('第二轮 → round 严格 +1，且每轮只发一次（不是上一轮的 round）', () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sent } = installRealChain();
    try {
      sendUserTurn(FakeXHR, 'r3-03-r1', sseText('第一轮') + sseDone());
      vi.advanceTimersByTime(5_000);
      sendUserTurn(FakeXHR, 'r3-03-r2', sseText('第二轮') + sseDone());
      vi.advanceTimersByTime(5_000);
      const fs = finishSentinelsOnWire(sent);
      expect(fs.length).toBe(2);
      expect(fs[0]).toMatchObject({ sawFinishSentinel: true });
      expect(fs[1]).toMatchObject({ sawFinishSentinel: true });
      // round 是页端本轮单调序号：第二条必须比第一条严格 +1，且不是时间戳。
      expect(fs[1].round).toBe(fs[0].round + 1);
    } finally { handle.stop(); vi.useRealTimers(); }
  });
});

/*
 * NEGATIVE-CONTROL（负控，证明测试真的咬住发送端，不是在测夹具）：
 * 把 `src/inject/main-world-interceptor.ts` 里 turn.end 公共汇聚点的那一行注释掉：
 *
 *     if (event.t === 'turn.end') emitFinishSentinelOnTurnEnd();
 *
 * → 「有完成哨兵的流」「无哨兵」「第二轮」三条用例的 `expect(fs.length).toBe(...)` 会转红
 *   （线上 finish-sentinel 帧数变成 0，而非期望的 1/1/2）。
 * 「空流不发」用例本来就期望 0，注释后仍绿，符合预期（它守的是“不发”）。
 * 改完必须还原该行，否则页端缺发送端、`interrupted` 回到死代码。
 */
