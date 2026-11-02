import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  installMainWorldInterceptor,
  configureMemorySelect,
  type MainWorldInterceptorHandle,
} from '../../src/inject/main-world-interceptor';
import type { ExecuteResult } from '../../src/capabilities/types';

// @vitest-environment jsdom

/**
 * 卡 B 回归：XHR 延迟发送路径丢弃 memory.select 预取结果。
 *
 * 缺陷（PM 核实）：`doDelayedSend` 用 `void pendingSel.then(...)` 消费预取结果，
 * 微任务排在当前同步块之后；紧接着 `prepareChatSend()` **同步**读 `currentMemories`，
 * 拿到的还是**上一轮**的值。于是：
 *   - 为记忆预取等了最多 120ms；
 *   - 本轮注入的仍是旧记忆，新记忆要等**下一条** chat 请求才生效；
 *   - `pendingSel` 的语义（发送前刷新记忆）在 XHR 路径完全失效。
 *
 * 修法：抽出共用 helper `consumeMemorySelect()`，**先 await 再赋值**；
 * XHR 正常路径在构造请求体前 await，abort 路径保持**同步**补发（readyState=4 链不能悬）。
 *
 * 本文件用「记忆内容标记」断言当轮生效：注入体里出现新记忆标记 ⇒ 本轮就带上了。
 */

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

interface TestToolCallRequest {
  invocationName: string;
  params?: Record<string, unknown>;
}
type TestSender = (req: TestToolCallRequest) => Promise<ExecuteResult>;

function defaultSenderResult(invocationName: string, memories?: unknown[]): ExecuteResult {
  if (invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
  if (invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
  if (invocationName === 'memory.select') return { ok: true, data: { memories: memories ?? [] } };
  return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
}

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
    sent = false;
    aborted = false;
    constructor() { FakeXHR.instances.push(this); }
    open(m: string, u: string | URL) { this.method = m; this.url = String(u); this.readyState = 1; }
    setRequestHeader() { /* noop */ }
    send(body?: string | null) {
      this.body = typeof body === 'string' ? body : null;
      this.sent = true;
    }
    respond(status: number, text: string) {
      this.status = status; this.responseText = text; this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
    }
    abort() {
      this.aborted = true;
      this.status = 0; this.responseText = ''; this.readyState = 4;
      this.onreadystatechange?.();
    }
  };
}

function makeChatUI() {
  return {
    sessionKey: 'memsel-b:session',
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

interface Harness {
  FakeXHR: ReturnType<typeof makeFakeXhrClass>;
  handle: MainWorldInterceptorHandle;
  sender: ReturnType<typeof vi.fn<TestSender>>;
  chatUI: ReturnType<typeof makeChatUI>;
}

function installHarness(): Harness {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async (req: TestToolCallRequest) => defaultSenderResult(req.invocationName));
  const chatUI = makeChatUI();
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: () => {},
  });
  configureMemorySelect({
    enabled: () => true,
    invoke: (taskText: string) => sender({ invocationName: 'memory.select', params: { taskText } })
      .then((r) => r as { ok: boolean; data?: { memories?: unknown } }),
  });
  return { FakeXHR, handle, sender, chatUI };
}

function pageSend(FakeXHR: Harness['FakeXHR'], body: Record<string, unknown>) {
  const xhr = new FakeXHR();
  xhr.open('POST', CHAT_URL);
  xhr.send(JSON.stringify(body));
  return xhr;
}

function sentBody(xhr: { body: string | null }): string {
  return String(xhr.body ?? '');
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('卡 B：XHR 延迟路径必须消费 memory.select 预取结果', () => {
  it('预取在下一 tick resolve：本轮请求体里就有新记忆（旧实现只有下一轮才有）', async () => {
    const h = installHarness();
    try {
      // 第一轮：预取返回「旧记忆」，用于建立基线。
      h.sender.mockImplementation(async (req: TestToolCallRequest) => {
        if (req.invocationName === 'memory.select') {
          await flush(2);
          return { ok: true, data: { memories: [{ id: 'old', type: 'note', name: '旧记忆', content: 'OLD_MARKER', tags: [] }] } };
        }
        return defaultSenderResult(req.invocationName);
      });
      const first = pageSend(h.FakeXHR, { prompt: '第一轮', chat_session_id: 'b-1' });
      await flush();
      expect(first.sent).toBe(true);
      expect(sentBody(first)).toContain('OLD_MARKER');

      // 第二轮：预取返回「新记忆」，且**下一 tick 才 resolve**（最易暴露竞态）。
      h.sender.mockImplementation(async (req: TestToolCallRequest) => {
        if (req.invocationName === 'memory.select') {
          await flush(2);
          return { ok: true, data: { memories: [{ id: 'new', type: 'note', name: '新记忆', content: 'NEW_MARKER', tags: [] }] } };
        }
        return defaultSenderResult(req.invocationName);
      });
      const second = pageSend(h.FakeXHR, { prompt: '第二轮', chat_session_id: 'b-2' });
      await flush(30);

      // 核心断言：**本轮**请求体里就有新记忆（旧实现会缺，要等下一轮）。
      expect(second.sent).toBe(true);
      const body = sentBody(second);
      expect(body).toContain('NEW_MARKER');
      // 负控：旧记忆不再出现（说明确实换成了新清单，而不是两份都注入）
      expect(body).not.toContain('OLD_MARKER');
    } finally {
      h.handle.stop();
    }
  });

  it('超时：预取永不 resolve → 120ms 后照常发送，注入保持上一帧，不抛错', async () => {
    vi.useFakeTimers();
    const h = installHarness();
    try {
      // 第一轮建立「上一帧」记忆。
      h.sender.mockImplementation(async (req: TestToolCallRequest) => {
        if (req.invocationName === 'memory.select') {
          return { ok: true, data: { memories: [{ id: 'old', type: 'note', name: '旧记忆', content: 'OLD_MARKER', tags: [] }] } };
        }
        return defaultSenderResult(req.invocationName);
      });
      const first = pageSend(h.FakeXHR, { prompt: '第一轮', chat_session_id: 't-1' });
      await flush();
      expect(sentBody(first)).toContain('OLD_MARKER');

      // 第二轮：预取永不 resolve → 走 120ms 预算超时。
      h.sender.mockImplementation(async (req: TestToolCallRequest) => {
        if (req.invocationName === 'memory.select') {
          return new Promise<ExecuteResult>(() => { /* 永不 resolve */ });
        }
        return defaultSenderResult(req.invocationName);
      });
      const second = pageSend(h.FakeXHR, { prompt: '第二轮', chat_session_id: 't-2' });
      await vi.advanceTimersByTimeAsync(130);
      await flush();

      // 超时后照常发送，且沿用上一帧记忆（不清空、不换成空）。
      expect(second.sent).toBe(true);
      const body = sentBody(second);
      expect(body).toContain('OLD_MARKER');
      expect(body).not.toContain('NEW_MARKER');
    } finally {
      h.handle.stop();
    }
  });

  it('abort：延迟期内 abort → origSend 与 origAbort 都发出，readyState=4 链完整', async () => {
    const h = installHarness();
    try {
      // 让预取挂住，触发延迟发送路径。
      h.sender.mockImplementation(async (req: TestToolCallRequest) => {
        if (req.invocationName === 'memory.select') {
          return new Promise<ExecuteResult>(() => { /* 永不 resolve */ });
        }
        return defaultSenderResult(req.invocationName);
      });
      const xhr = pageSend(h.FakeXHR, { prompt: '会被 abort', chat_session_id: 'a-1' });
      await flush();
      expect(xhr.sent).toBe(false); // 处于延迟态

      // 用户 abort
      (xhr as unknown as { abort: () => void }).abort();
      await flush();

      // 补发 + abort 都要发生（readyState=4 链不能悬）
      expect(xhr.sent).toBe(true);
      expect(xhr.aborted).toBe(true);
      expect(xhr.readyState).toBe(4);
    } finally {
      h.handle.stop();
    }
  });
});
