// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * M3 口径放行（PM 2026-11-05 派卡）：trace 落盘白名单从「turn.end + m15.*」扩到
 * 「+ continuation.decision + request.sent」——Gate 的 buildRetryReport 分母 A
 * （实际发出请求数）必须能离线从 logs/trace/*.jsonl 算出来。
 *
 * 本文件守三件事（拆白名单必须红）：
 *  ① 行为级：真实 XHR 链路触发的 `request.sent` 真的落进 traceLineSink，
 *     且事件体**只有 {t, turnId, bytes, ts} 键集**（无 body/正文 —— 脱敏硬要求的锁）；
 *  ② 防整体放行：`sse.frame`（每帧都 record）**绝不**进 sink（内存环整体不许放出来）；
 *  ③ 源码级：白名单条件含 `'continuation.decision'` 与 `'request.sent'` 字面量
 *     —— 把 :649 条件改回只放行 turn.end ⇒ ①③ 同时转红。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'trace-wl-stub' })),
}));

import {
  installMainWorldInterceptor,
  setInterceptorTraceSink,
} from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function makeFakeXhrClass() {
  return class FakeXHR {
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: Handler = null;
    method = '';
    url = '';
    headers: Record<string, unknown> = {};
    body: string | null = null;
    constructor() { /* noop */ }
    open(m: string, u: string | URL) { this.method = m; this.url = String(u); this.readyState = 1; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    send(body?: string | null) { this.body = typeof body === 'string' ? body : null; }
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.readyState = 3; this.onreadystatechange?.();
      this.readyState = 4; this.onreadystatechange?.();
    }
    abort() { this.status = 0; this.readyState = 4; this.onreadystatechange?.(); }
  };
}

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
    + 'event: close\ndata: {"click_behavior":"none"}\n\n';
}
function sseText(text: string): string {
  return `data: ${JSON.stringify({ v: text })}\n\n`;
}

function sinkEvents(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((m): m is Record<string, unknown> => !!m);
}

describe('trace 落盘白名单（M3：continuation.decision / request.sent 放行）', () => {
  afterEach(() => {
    setInterceptorTraceSink(null);
    vi.useRealTimers();
    (globalThis as Record<string, unknown>).XMLHttpRequest = undefined;
    (globalThis as Record<string, unknown>).location = undefined;
  });

  it('① request.sent 真进 sink，且事件体键集 = {t, turnId, bytes, ts}（无正文）', () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/', origin: 'https://chat.deepseek.com' });
    const lines: string[] = [];
    setInterceptorTraceSink((l) => lines.push(l));
    const handle = installMainWorldInterceptor({
      sender: vi.fn(async () => ({ ok: true, data: { stdout: 'x', exitCode: 0 } })),
      diag: () => {},
      chatUI: undefined,
    } as never);
    // 探针正文（PM 硬要求）：中文可辨识串走完整链路；落盘行 grep 不到它 = 零泄漏。
    const probe = '探针正文零泄漏-ZL7Q';
    try {
      const req = new FakeXHR();
      req.open('POST', CHAT_URL);
      req.send(JSON.stringify({ prompt: probe, chat_session_id: 'trace-wl-1' }));
      req.respond(200, sseText('你好') + sseDone());
      vi.advanceTimersByTime(5_000);

      const events = sinkEvents(lines);
      const sent = events.filter((e) => e.t === 'request.sent');
      expect(sent.length).toBeGreaterThanOrEqual(1);
      // 键集锁：只有 t/turnId/bytes + 落盘补的 ts —— 无 body/prompt/text 任何正文字段。
      for (const e of sent) {
        expect(Object.keys(e).sort()).toEqual(['bytes', 't', 'ts', 'turnId']);
      }
      // 探针零泄漏：整条落盘通道（含所有事件行）不得含用户正文/工具输出文本。
      const allLines = lines.join('\n');
      expect(allLines).not.toContain(probe);
      expect(allLines).not.toContain('你好');
      // 注：turn.end 只在续跑/错误收尾路径 record（首轮流正常完成不记），
      // 这里不以它为基线；白名单上界检查在用例 ② 统一做。
    } finally { handle.stop(); }
  });

  it('② 内存环整体没放出来：sse.frame（每帧必 record）绝不出现在 sink', () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/', origin: 'https://chat.deepseek.com' });
    const lines: string[] = [];
    setInterceptorTraceSink((l) => lines.push(l));
    const handle = installMainWorldInterceptor({
      sender: vi.fn(async () => ({ ok: true, data: { stdout: 'x', exitCode: 0 } })),
      diag: () => {},
      chatUI: undefined,
    } as never);
    try {
      const req = new FakeXHR();
      req.open('POST', CHAT_URL);
      req.send(JSON.stringify({ prompt: 'hi', chat_session_id: 'trace-wl-2' }));
      // 三段正文帧：sse.frame（kind=text）在内存环里必然 ≥3 条 record；
      // 若白名单被整体放行，sink 里就会出现 sse.frame —— 本用例守「只放行四类」。
      req.respond(200, sseText('一') + sseText('二') + sseText('三') + sseDone());
      vi.advanceTimersByTime(5_000);

      const events = sinkEvents(lines);
      expect(events.filter((e) => e.t === 'sse.frame').length).toBe(0);
      expect(events.filter((e) => e.t === 'tool.parsed').length).toBe(0);
      // sink 里的事件 t 值必须 ⊆ 白名单四类：
      const allowed = (t: unknown): boolean =>
        t === 'turn.end' || t === 'continuation.decision' || t === 'request.sent'
        || (typeof t === 'string' && t.startsWith('m15.'));
      for (const e of events) expect(allowed(e.t)).toBe(true);
    } finally { handle.stop(); }
  });

  it('③ 源码锁：白名单条件含 continuation.decision 与 request.sent（改回旧白名单 ⇒ 红）', () => {
    // 相对仓库根（vitest 从仓库根启动；先例 tests/desktop/desktop-entry.test.ts）。
    const src = readFileSync('src/inject/main-world-interceptor.ts', 'utf8');
    expect(src).toMatch(/event\.t === 'continuation\.decision'/);
    expect(src).toMatch(/event\.t === 'request\.sent'/);
    // 负控说明：把 :649 的条件改回「只放行 turn.end + m15.*」⇒ 用例 ①（request.sent 不再进 sink）
    // 与本用例（字面量消失）同时转红。
  });
});
