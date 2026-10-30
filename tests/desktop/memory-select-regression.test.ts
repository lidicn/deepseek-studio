import { describe, expect, it, vi, afterEach } from 'vitest';
import { installMainWorldInterceptor, configureMemorySelect, type MainWorldInterceptorHandle } from '../../src/inject/main-world-interceptor';
import type { ExecuteResult } from '../../src/capabilities/types';

// @vitest-environment jsdom

/** vitest/jsdom 下扩展 globalThis feature flag 类型（真机由 desktop/entry.ts 注入）。 */
declare global {
  // eslint-disable-next-line no-var
  var __studioMemorySelect: boolean | undefined;
}

/** 测试内部统一的 ToolCallRequest 形状（src/inject 模块内部类型不导出）。 */
interface TestToolCallRequest {
  invocationName: string;
  params?: Record<string, unknown>;
}

/** 统一 sender 类型（用 ExecuteResult 让联合类型闭合，所有 invocationName 都有 ok + 完整 data 形状）。 */
type TestSender = (req: TestToolCallRequest) => Promise<ExecuteResult>;

/** 构造 sender 标准返回——覆盖所有已知 invocationName，让联合类型闭合。 */
function defaultSenderResult(invocationName: string, memories?: unknown[]): ExecuteResult {
  if (invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
  if (invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
  if (invocationName === 'memory.select') return { ok: true, data: { memories: memories ?? [] } };
  return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
}

/** vitest fn 的统一 sender stub——所有 invocationName 都返回正确形状。 */
function makeTestSender(): ReturnType<typeof vi.fn<TestSender>> {
  return vi.fn(async (req: TestToolCallRequest) => defaultSenderResult(req.invocationName));
}

// ─── 常量 ───────────────────────────────────────────────────

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';
const NON_CHAT_URL = 'https://chat.deepseek.com/api/v0/client/settings';

// ─── FakeXHR：加 sent 标志，让测试能断言 origSend 是否被延迟 ──

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
    /** origSend 是否被实际调用过（NEED_MEM_SELECT_WAIT 时会延迟）。 */
    sent = false;
    constructor() { FakeXHR.instances.push(this); }
    open(m: string, u: string | URL) { this.method = m; this.url = String(u); this.readyState = 1; }
    setRequestHeader() { /* noop */ }
    send(body?: string | null) {
      this.body = typeof body === 'string' ? body : null;
      this.sent = true; // 只有 origSend 被调用时才设
    }
    respond(status: number, text: string) {
      this.status = status; this.responseText = text; this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
    }
    abort() { this.status = 0; this.responseText = ''; this.readyState = 4; this.onreadystatechange?.(); }
  };
}

// ─── Chat UI stub ────────────────────────────────────────────

function makeChatUI() {
  return {
    sessionKey: 'test:session',
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

// ─── 辅助：等一个 tick，让 Promise.then 链跑完 ────────────────

function nextTick(): Promise<void> {
  return Promise.resolve();
}

// ─── 辅助：统计 memory.select 调用次数 ───────────────────────

function memorySelectCalls(sender: ReturnType<typeof vi.fn<TestSender>>) {
  return sender.mock.calls.filter((c: unknown[]) => {
    const req = c[0] as TestToolCallRequest;
    return req?.invocationName === 'memory.select';
  });
}

// ─── Harness ────────────────────────────────────────────────

interface Harness {
  FakeXHR: ReturnType<typeof makeFakeXhrClass>;
  handle: MainWorldInterceptorHandle;
  sender: ReturnType<typeof vi.fn<TestSender>>;
  chatUI: ReturnType<typeof makeChatUI>;
}

function installHarness(opts: { flagEnabled?: boolean | (() => boolean) } = {}): Harness {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

  const sender = makeTestSender();
  const chatUI = makeChatUI();
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: () => {},
  });

  // C1-F1：用 getter 函数让 enabled 运行期可读取（模拟 entry.ts 的修复）
  const defaultEnabled: () => boolean = () => Boolean((globalThis as { __studioMemorySelect?: boolean }).__studioMemorySelect);
  configureMemorySelect({
    enabled: opts.flagEnabled ?? defaultEnabled,
    invoke: (taskText: string) => sender({ invocationName: 'memory.select', params: { taskText } })
      .then((r) => r as { ok: boolean; data?: { memories?: unknown } }),
  });

  return { FakeXHR, handle, sender, chatUI };
}

function pageSend(FakeXHR: Harness['FakeXHR'], url: string, body?: string): InstanceType<Harness['FakeXHR']> {
  const xhr = new FakeXHR();
  xhr.open('POST', url);
  xhr.send(body);
  return xhr;
}

// ─── after ─────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).__studioMemorySelect;
});

// ════════════════════════════════════════════════════════════
// C1-F1 回归：memory.select 自动预取闭环
// ════════════════════════════════════════════════════════════

describe('C1-F1 memory.select 自动预取闭环', () => {

  // ─── 红转绿-1：注入时 flag=null，之后变 true → 自动预取能生效 ──

  it('【红转绿-1】flag 运行期可生效：注入时 null → 设 true 后 chat XHR 会触发 memory.select', async () => {
    const { FakeXHR, handle, sender } = installHarness();
    try {
      // 初始：__studioMemorySelect 未设置（undefined → getter 读 false）
      const xhr1 = pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '你好', chat_session_id: 's1' }));
      await nextTick();
      // enabled=false → kick 不触发，XHR 不延迟、sent 立即 true
      expect(xhr1.sent).toBe(true);
      expect(memorySelectCalls(sender)).toHaveLength(0);

      // 运行期：页端设置 flag=true
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      // 第二次 chat：kickMemorySelect 触发 → 但 sender 很快 resolve → pending 很快被消费
      // XHR 在 NEED_MEM_SELECT_WAIT 里检查 !!memorySelectState.pending —— 如果 pending 已 resolve
      // 则会进入，但 Promise.race 会立即触发 doDelayedSend
      pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '写个函数', chat_session_id: 's2' }));
      await nextTick();
      // 等 sender async 返回（resolve pending）
      await nextTick();

      const mselCalls = memorySelectCalls(sender);
      expect(mselCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      handle.stop();
    }
  });

  // ─── 红转绿-2：XHR 有界等待（延迟 origSend 最多 120ms） —— 原假绿 ──

  it('【红转绿-2】有 pending 时 chat XHR 延迟发送（≤120ms），超时回落继续发', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender } = installHarness();
    try {
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      // 让 memory.select 永不 resolve —— 强制 pending 状态
      sender.mockImplementationOnce(async (_req: TestToolCallRequest) => {
        if (_req.invocationName === 'memory.select') {
          return new Promise<ExecuteResult>(() => { /* 永不 resolve */ });
        }
        return defaultSenderResult(_req.invocationName);
      });

      // 第一次 pageSend：kickMemorySelect 创建 pending（永不 resolve）
      // invoke 返回永不 resolve 的 Promise → memorySelectState.pending = Promise<rows> 永不 resolve
      pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '造 pending', chat_session_id: 's1' }));
      // runAllTimers 让所有 microtask 走完，确认 pending 已创建
      await vi.runAllTimersAsync();

      // 第二次 pageSend：命中 NEED_MEM_SELECT_WAIT → 延迟 send
      const xhr2 = pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '任务B', chat_session_id: 's2' }));

      // 关键断言 1：sent 应该还是 false（被延迟了）
      expect(xhr2.sent).toBe(false);

      // 推进时间超过 120ms budget
      await vi.advanceTimersByTimeAsync(130);

      // 关键断言 2：超时回落 → origSend 被调用
      expect(xhr2.sent).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  // ─── 红转绿-3：fetch 路径 enabled=true 有 pending → memory.select 被触发 ──

  it('【红转绿-3】fetch 路径 enabled=true → memory.select 被触发且 fetch 正常完成', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => ({ done: true }) }) } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

    const sender = makeTestSender();
    const chatUI = makeChatUI();
    const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });

    configureMemorySelect({
      enabled: () => true,
      invoke: (taskText: string) => sender({ invocationName: 'memory.select', params: { taskText } })
        .then((r) => r as { ok: boolean; data?: { memories?: unknown } }),
    });

    try {
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      await (globalThis as { fetch: typeof fetch }).fetch(CHAT_URL, {
        method: 'POST',
        body: JSON.stringify({ prompt: '第一次', chat_session_id: 's1' }),
      });
      await nextTick();

      const mselCalls = memorySelectCalls(sender);
      expect(mselCalls.length).toBeGreaterThanOrEqual(1);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });

  // ─── 红转绿-4：超时回落（fetch + 永不 resolve pending） ──

  it('【红转绿-4】fetch 路径有 pending 永不 resolve → 120ms 超时后 fetch 继续发', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => ({ done: true }) }) } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

    const sender = makeTestSender();
    sender.mockImplementationOnce(async (req: TestToolCallRequest) => {
      if (req.invocationName === 'memory.select') {
        return new Promise<ExecuteResult>(() => { /* 永不 resolve */ });
      }
      return defaultSenderResult(req.invocationName);
    });

    const chatUI = makeChatUI();
    const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });
    configureMemorySelect({
      enabled: () => true,
      invoke: (taskText: string) => sender({ invocationName: 'memory.select', params: { taskText } })
        .then((r) => r as { ok: boolean; data?: { memories?: unknown } }),
    });

    try {
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      const fetchPromise = (globalThis as { fetch: typeof fetch }).fetch(CHAT_URL, {
        method: 'POST',
        body: JSON.stringify({ prompt: '超时测试', chat_session_id: 's1' }),
      });

      // 先 runAllTimers 让 kickMemorySelect 的 async 链走完
      await vi.runAllTimersAsync();

      // 推进 130ms → budget 超时 → awaitMemorySelectBudget 返回 → fetch 继续
      await vi.advanceTimersByTimeAsync(130);
      await fetchPromise;

      expect(fetchMock).toHaveBeenCalled();
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  // ─── 红转绿-5：memory.select 确实走 host.sendToolCall ──

  it('【红转绿-5】自动预取确实调用 sender(invocationName:"memory.select") 且 params.taskText 包含用户 prompt', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => ({ done: true }) }) } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

    const sender = makeTestSender();
    const chatUI = makeChatUI();
    const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });
    configureMemorySelect({
      enabled: () => true,
      invoke: (taskText: string) => sender({ invocationName: 'memory.select', params: { taskText } })
        .then((r) => r as { ok: boolean; data?: { memories?: unknown } }),
    });

    try {
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      await (globalThis as { fetch: typeof fetch }).fetch(CHAT_URL, {
        method: 'POST',
        body: JSON.stringify({ prompt: '我要写个排序函数', chat_session_id: 's1' }),
      });
      await nextTick();

      const msel = memorySelectCalls(sender);
      expect(msel).toHaveLength(1);
      const taskText = (msel[0][0] as TestToolCallRequest).params?.taskText;
      expect(taskText).toBeTruthy();
      expect(typeof taskText).toBe('string');
      expect(taskText).toContain('排序');
    } finally {
      handle.stop();
    }
  });

  // ─── 红转绿-6：非聊天 XHR 不等待、不触发 memory.select —— 原假绿 ──

  it('【红转绿-6】非聊天 XHR 立即发送（sent=true）且不触发额外 memory.select', async () => {
    const { FakeXHR, handle, sender } = installHarness();
    try {
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      // 先发 chat → kick 一个 pending（sender 立即 resolve）
      pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '制造 pending', chat_session_id: 's1' }));
      await nextTick();

      // 让下一个 memory.select 永不 resolve → 造真正 pending
      sender.mockImplementationOnce(async (_req: TestToolCallRequest) => {
        if (_req.invocationName === 'memory.select') {
          return new Promise<ExecuteResult>(() => { /* 永不 resolve */ });
        }
        return defaultSenderResult(_req.invocationName);
      });
      pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '第二个 chat', chat_session_id: 's2' }));
      await nextTick();

      // 此时 memory.select 还 pending 着

      // 非聊天 XHR：NEED_MEM_SELECT_WAIT 里 isChat=false → 不走延迟
      const before = memorySelectCalls(sender).length;
      const nonChatXhr = pageSend(FakeXHR, NON_CHAT_URL);

      // 关键断言 1：sent 立即为 true（没有被延迟）
      expect(nonChatXhr.sent).toBe(true);

      // 关键断言 2：不触发额外 memory.select（非 chat 不 kick）
      await nextTick();
      const after = memorySelectCalls(sender).length;
      expect(after).toBe(before);
    } finally {
      handle.stop();
    }
  });

  // ─── 红转绿-7：有 pending 但 enabled=false → XHR 立即发送（等价于 inFirstAttemptResend 跳过等待） ──

  it('【红转绿-7】有 pending 但 enabled=false → XHR 立即发送、不触发 memory.select', async () => {
    const { FakeXHR, handle, sender } = installHarness();
    try {
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      // 先发 chat → kick pending
      pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '制造 pending', chat_session_id: 's1' }));
      await nextTick();

      // 造永不 resolve pending
      sender.mockImplementationOnce(async (_req: TestToolCallRequest) => {
        if (_req.invocationName === 'memory.select') {
          return new Promise<ExecuteResult>(() => { /* 永不 resolve */ });
        }
        return defaultSenderResult(_req.invocationName);
      });
      pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: '造 pending', chat_session_id: 's2' }));
      await nextTick();

      // 现在关闭 flag → enabled=false
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = false;

      // 再发 chat：enabled=false → NEED_MEM_SELECT_WAIT 里 isMemorySelectEnabled()=false → 不延迟
      // kickMemorySelect 也因 enabled=false 不触发
      const beforeCount = memorySelectCalls(sender).length;
      const xhr3 = pageSend(FakeXHR, CHAT_URL, JSON.stringify({ prompt: 'flag关了', chat_session_id: 's3' }));

      // 关键断言 1：sent 立即为 true（没有延迟）
      expect(xhr3.sent).toBe(true);

      // 关键断言 2：没有新的 memory.select 调用
      await nextTick();
      const afterCount = memorySelectCalls(sender).length;
      expect(afterCount).toBe(beforeCount);
    } finally {
      handle.stop();
    }
  });

  // ─── 红转绿-8：延迟发送仍必须安装响应钩子（否则工具解析静默失效） ──

  it('【红转绿-8】延迟发送仍安装响应钩子并解析 shell_exec', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, sender } = installHarness();
    try {
      (globalThis as { __studioMemorySelect: boolean }).__studioMemorySelect = true;

      // captureChatRequest 会同步 kick memory.select；让它永不返回，强制本次 XHR 走延迟分支。
      sender.mockImplementationOnce(async (req: TestToolCallRequest) => {
        if (req.invocationName === 'memory.select') {
          return new Promise<ExecuteResult>(() => { /* 永不 resolve */ });
        }
        return defaultSenderResult(req.invocationName);
      });

      const xhr = pageSend(
        FakeXHR,
        CHAT_URL,
        JSON.stringify({ prompt: '延迟钩子测试', chat_session_id: 's8' }),
      );
      expect(xhr.sent).toBe(false);

      await vi.advanceTimersByTimeAsync(130);
      expect(xhr.sent).toBe(true);

      const sseTool = `data: ${JSON.stringify({
        v: [{ type: 'RESPONSE', content: '<shell_exec>{"command":"echo delayed"}</shell_exec>' }],
      })}\n\n`;
      const sseDone = 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n';
      xhr.respond(200, sseTool + sseDone);
      await nextTick();
      await nextTick();

      expect(sender).toHaveBeenCalledWith(
        expect.objectContaining({
          invocationName: 'shell_exec',
          params: expect.objectContaining({ command: 'echo delayed' }),
        }),
      );
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
