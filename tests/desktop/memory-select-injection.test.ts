// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installMainWorldInterceptor,
  configureMemorySelect,
  __resetMemorySelectForTests,
  type MainWorldInterceptorHandle,
} from '../../src/inject/main-world-interceptor';

/**
 * P1：记忆从来没被注入过（真机 14 轮记忆段恒 0 B）。
 *
 * 真机读数（Verify 2026-11-02）：页面通道 memory.select 往返 149/166/170ms，
 * **稳定超过**发送点 120ms 预算 → 每轮都在预算内拿不到；超时后 pending 被摘掉，
 * 迟到结果被 `if (pending === pendingSel)` 守卫丢掉 → 一次都没注入成功。
 *
 * 本文件用**真实时序**（真 timer 170ms + fake timer 驱动）打真实入口
 * （XHR / fetch 包装），覆盖：
 *   ① select 在 170ms 结算 → 后续轮能看到记忆；
 *   ② select 永不结算 → 不阻塞发送、不抛、注入保持上一帧；
 *   ③ abort 路径仍能补发、readyState=4 链不悬；
 *   ④ 打字预热 → 发送前已 settle → 当轮就带得上；
 *   ⑤ 可观测点 memory.bytes；
 *   ⑥ 120ms 预算没被调大（发送仍在 120ms 准点发出）。
 */

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

const MEMORY_ROW = {
  id: 'm-1',
  type: 'user',
  name: '记忆：项目路径',
  content: '用户的 deepseek-studio 项目在 E:/NAS/deepseek-studio',
  tags: ['project'],
};

function makeFakeXhrClass() {
  return class FakeXHR {
    static instances: FakeXHR[] = [];
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: ((...a: unknown[]) => void) | null = null;
    url = '';
    method = 'GET';
    body: string | null = null;
    /** origSend 是否被实际调用过（有界等待期间为 false）。 */
    sent = false;
    /** readyState=4 是否发生过（abort 链不悬的证据）。 */
    reachedDone = false;
    constructor() { FakeXHR.instances.push(this); }
    open(m: string, u: string | URL) { this.method = m; this.url = String(u); this.readyState = 1; }
    setRequestHeader() { /* noop */ }
    send(body?: string | null) {
      this.body = typeof body === 'string' ? body : null;
      this.sent = true;
    }
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.reachedDone = true;
      this.onreadystatechange?.();
    }
    abort() {
      this.status = 0;
      this.responseText = '';
      this.readyState = 4;
      this.reachedDone = true;
      this.onreadystatechange?.();
    }
  };
}

function makeChatUI() {
  return {
    sessionKey: 'memory-inject:session',
    activateSession: vi.fn(async () => undefined),
    beginTurnSession: vi.fn(),
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

interface SelectCall {
  taskText: string;
  resolve(result: { ok: boolean; data?: { memories?: unknown } }): void;
}

interface Harness {
  FakeXHR: ReturnType<typeof makeFakeXhrClass>;
  handle: MainWorldInterceptorHandle;
  diagLines: string[];
  selectCalls: SelectCall[];
  /** 让下一次 select 立即返回指定记忆。 */
  resolveNext(result: { ok: boolean; data?: { memories?: unknown } }): void;
}

function installHarness(opts: {
  /** 每个 select 调用的行为：默认返回一条记忆。 */
  select?: (call: SelectCall) => void;
} = {}): Harness {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

  const selectCalls: SelectCall[] = [];
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
  });
  const diagLines: string[] = [];
  const chatUI = makeChatUI();
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: (line) => diagLines.push(line),
  });
  configureMemorySelect({
    enabled: () => true,
    invoke: (taskText) => new Promise((resolve) => {
      const call: SelectCall = {
        taskText,
        resolve: (result) => resolve(result),
      };
      selectCalls.push(call);
      if (opts.select) opts.select(call);
      else call.resolve({ ok: true, data: { memories: [MEMORY_ROW] } });
    }),
  });
  return {
    FakeXHR,
    handle,
    diagLines,
    selectCalls,
    resolveNext(result) {
      const last = selectCalls[selectCalls.length - 1];
      if (last) last.resolve(result);
    },
  };
}

function pageSend(
  FakeXHR: ReturnType<typeof makeFakeXhrClass>,
  text: string,
  sessionId = 's-1',
): InstanceType<ReturnType<typeof makeFakeXhrClass>> {
  const xhr = new FakeXHR();
  xhr.open('POST', CHAT_URL);
  xhr.onreadystatechange = () => {};
  xhr.send(JSON.stringify({ prompt: text, chat_session_id: sessionId }));
  return xhr;
}

function bodyOf(xhr: { body: string | null }): string {
  return String(xhr.body ?? '');
}

/** 记忆段字节读数（来自 diag 行 `memory.bytes=N rows=M`）。 */
function memoryBytesOf(diagLines: string[]): number {
  const hits = diagLines.filter((l) => l.includes('memory.bytes='));
  const last = hits[hits.length - 1];
  if (!last) return -1;
  const m = /memory\.bytes=(\d+)/.exec(last);
  return m ? Number(m[1]) : -1;
}

beforeEach(() => {
  __resetMemorySelectForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetMemorySelectForTests();
});

describe('P1 记忆注入：select 迟到也要落地', () => {
  it('① select 在 170ms 结算 → 后续轮能看到记忆（迟到结果不再被守卫丢掉）', async () => {
    vi.useFakeTimers();
    const h = installHarness({ select: () => { /* 手动在 170ms 结算 */ } });
    try {
      // 第 1 轮：发送点 120ms 预算内拿不到 → 本轮没有记忆（预期）
      const first = pageSend(h.FakeXHR, '帮我看看项目');
      expect(first.sent).toBe(false);
      await vi.advanceTimersByTimeAsync(120);
      expect(first.sent).toBe(true); // 预算耗尽即发，不阻塞
      expect(bodyOf(first)).not.toContain(MEMORY_ROW.content);

      // 170ms：select 迟到结算
      expect(h.selectCalls).toHaveLength(1);
      h.resolveNext({ ok: true, data: { memories: [MEMORY_ROW] } });
      await vi.advanceTimersByTimeAsync(60);

      // 第 2 轮：迟到结果已落地 → 记忆进请求体
      const second = pageSend(h.FakeXHR, '帮我看看项目', 's-2');
      expect(second.sent).toBe(true); // 已 settle → 不再等
      expect(bodyOf(second)).toContain(MEMORY_ROW.content);
      expect(memoryBytesOf(h.diagLines)).toBeGreaterThan(0);
    } finally {
      h.handle.stop();
    }
  });

  it('①b 第 2 轮换了文本：迟到结果仍作为「上一帧」进入请求体', async () => {
    vi.useFakeTimers();
    const h = installHarness({ select: () => { /* 手动结算 */ } });
    try {
      const first = pageSend(h.FakeXHR, '第一个任务');
      await vi.advanceTimersByTimeAsync(120);
      expect(first.sent).toBe(true);

      h.resolveNext({ ok: true, data: { memories: [MEMORY_ROW] } });
      await vi.advanceTimersByTimeAsync(60);

      // 换文本 → 重新 kick（新的 select 还在飞）→ 但上一帧记忆仍在
      const second = pageSend(h.FakeXHR, '完全不同的另一个任务', 's-2');
      await vi.advanceTimersByTimeAsync(130);
      expect(second.sent).toBe(true);
      expect(bodyOf(second)).toContain(MEMORY_ROW.content);
    } finally {
      h.handle.stop();
    }
  });

  it('② select 永不结算 → 不阻塞发送、不抛错、注入保持上一帧', async () => {
    vi.useFakeTimers();
    const h = installHarness({ select: () => { /* 永不 resolve */ } });
    try {
      const first = pageSend(h.FakeXHR, '永不结算的任务');
      expect(first.sent).toBe(false);
      await vi.advanceTimersByTimeAsync(120);
      // 预算到点即发：不阻塞、不抛
      expect(first.sent).toBe(true);
      expect(bodyOf(first)).not.toContain(MEMORY_ROW.content);
      expect(memoryBytesOf(h.diagLines)).toBe(0);

      // 同一文本再发：不再重复等那 120ms（超时标记生效）
      const second = pageSend(h.FakeXHR, '永不结算的任务', 's-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(second.sent).toBe(true);
    } finally {
      h.handle.stop();
    }
  });

  it('③ abort 路径：延迟期间 abort 仍补发，readyState=4 链不悬', async () => {
    vi.useFakeTimers();
    const h = installHarness({ select: () => { /* 永不 resolve → 走延迟发送路径 */ } });
    try {
      const xhr = new h.FakeXHR();
      xhr.open('POST', CHAT_URL);
      xhr.onreadystatechange = () => {};
      xhr.send(JSON.stringify({ prompt: '我要停止', chat_session_id: 's-abort' }));
      expect(xhr.sent).toBe(false); // 延迟中

      xhr.abort();
      // 同步补发 + origAbort：请求发出、请求体已构造、readyState=4 链走完
      expect(xhr.sent).toBe(true);
      expect(xhr.body).not.toBeNull();
      expect(xhr.reachedDone).toBe(true);
    } finally {
      h.handle.stop();
    }
  });

  it('④ 打字预热：发送前已 settle → 当轮就带得上记忆（不等 120ms）', async () => {
    vi.useFakeTimers();
    const h = installHarness({ select: () => { /* 手动结算 */ } });
    try {
      const draft = '帮我看看 deepseek-studio 的记忆注入有没有生效';
      const ta = document.createElement('textarea');
      document.body.appendChild(ta);
      ta.value = draft;
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      // 打字停顿 600ms → 预热发出 select（用草稿文本）
      await vi.advanceTimersByTimeAsync(600);
      expect(h.selectCalls.length).toBeGreaterThanOrEqual(1);
      expect(h.selectCalls[0].taskText).toContain('deepseek-studio');

      h.resolveNext({ ok: true, data: { memories: [MEMORY_ROW] } });
      await vi.advanceTimersByTimeAsync(10);

      // 发送：草稿已是最终文本 → 复用已 settle 的预取 → 立即发出且带记忆
      const xhr = pageSend(h.FakeXHR, draft, 's-warm');
      expect(xhr.sent).toBe(true);
      expect(bodyOf(xhr)).toContain(MEMORY_ROW.content);
    } finally {
      h.handle.stop();
    }
  });

  it('⑤ 可观测点：diag 里出现 memory.bytes=…（Verify 真机抓包可 grep）', async () => {
    vi.useFakeTimers();
    const h = installHarness({ select: () => { /* 手动结算 */ } });
    try {
      const first = pageSend(h.FakeXHR, '观测点任务');
      await vi.advanceTimersByTimeAsync(120);
      expect(first.sent).toBe(true);
      expect(h.diagLines.some((l) => l.includes('memory.bytes='))).toBe(true);
      expect(memoryBytesOf(h.diagLines)).toBe(0); // 还没结算 → 0 B

      h.resolveNext({ ok: true, data: { memories: [MEMORY_ROW] } });
      await vi.advanceTimersByTimeAsync(60);

      const second = pageSend(h.FakeXHR, '观测点任务', 's-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(second.sent).toBe(true);
      expect(memoryBytesOf(h.diagLines)).toBeGreaterThan(0);
    } finally {
      h.handle.stop();
    }
  });

  it('⑥ 120ms 预算没被调大：select 170ms 才到，发送仍在 120ms 准点发生', async () => {
    vi.useFakeTimers();
    const h = installHarness({ select: () => { /* 170ms 才结算 */ } });
    try {
      const xhr = pageSend(h.FakeXHR, '预算不被调大');
      await vi.advanceTimersByTimeAsync(119);
      expect(xhr.sent).toBe(false); // 119ms 时还没发
      await vi.advanceTimersByTimeAsync(1);
      expect(xhr.sent).toBe(true);  // 120ms 准点发，不等 select 的 170ms
    } finally {
      h.handle.stop();
    }
  });

  it('⑦ 真实时序（真 timer）：select 真实 170ms 后结算，下一轮请求体带记忆', async () => {
    const h = installHarness({
      select: (call) => {
        // 真 timer：170ms 后结算（不靠 fake clock）
        setTimeout(() => call.resolve({ ok: true, data: { memories: [MEMORY_ROW] } }), 170);
      },
    });
    try {
      const first = pageSend(h.FakeXHR, '真实时序任务');
      await new Promise((r) => setTimeout(r, 250)); // 等 120ms 预算 + 170ms 结算都过去
      expect(first.sent).toBe(true);
      expect(bodyOf(first)).not.toContain(MEMORY_ROW.content);

      const second = pageSend(h.FakeXHR, '真实时序任务', 's-2');
      await new Promise((r) => setTimeout(r, 20));
      expect(second.sent).toBe(true);
      expect(bodyOf(second)).toContain(MEMORY_ROW.content);
    } finally {
      h.handle.stop();
    }
  });
});
