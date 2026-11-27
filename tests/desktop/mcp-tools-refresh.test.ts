import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ㊿-c-补⑫ 件④：jsdom 的 window.confirm 未实现，注入层同文护栏会调它落 stderr。
// 全局 stub 为返回 true（确认放行）：不弹真框、不拦截。
beforeAll(() => {
  (window as unknown as Record<string, unknown>).confirm = () => true;
});

// auto-continue（首轮原样重发）会算 PoW；这里只需要它立即返回，不关心真实凭证。
vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'mcp-refresh-stub' })),
}));

import {
  __resetMcpToolsFreshnessForTests,
  __resetSkillsFreshnessForTests,
  __setMcpToolsFreshnessClockForTests,
  __setSkillsFreshnessClockForTests,
  installMainWorldInterceptor,
  type MainWorldInterceptorHandle,
} from '../../src/inject/main-world-interceptor';
import type { ExecuteResult } from '../../src/capabilities/types';

// @vitest-environment jsdom

/**
 * ㊿-c-补⑤：MCP 工具清单运行期刷新（注入侧，PM 卡 2026-11-23）。
 *
 * 现场：`mcp.list` 只在启动 IIFE（`mcp-tools-init`）拉一次，之后 `currentMcpTools`
 * 永不刷新。出资人关掉全部 MCP 服务器后，注入提示词仍带着被关服务器的工具
 * ⇒ 模型答「有这些 MCP 工具」，与设置矛盾。修法＝把技能侧同族机制（TTL＋发送点
 * kick＋打字预热＋in-flight 复用＋成功才更新）同构搬到 MCP 工具清单。
 *
 * 本文件按语义断言（`mcp.list` 被调了几次、注入块里有没有工具、发送是否被阻塞），
 * 不依赖内部变量。五格（卡面判据）：
 *   ① TTL 内新鲜 ⇒ 不额外调 mcp.list；
 *   ② TTL 过期 ⇒ 发送点 kick 拉取并更新注入块（关 ⇒ 工具消失，开 ⇒ 恢复，双向）；
 *   ③ 并发发送 ⇒ mcp.list 只发一次；
 *   ④ 拉取失败 ⇒ 保留旧清单、注入块不变、不抛；
 *   ⑤ 预热：输入停顿后异步拉，发送点直接用新清单。
 *
 * 负控（仓外副本树 `logs/ui-mcp-refresh-negctl/`）：摘掉 TTL 判断或发送点 kick
 * ⇒ ② 格必须红（旧清单仍被注入）。
 */

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';
const MCP_BLOCK_MARKER = '## 已配置的 MCP 工具';

const MCP_TOOL_A = { serverId: 'srv-a', name: 'alpha_tool', description: '工具A描述' };
const MCP_TOOL_B = { serverId: 'srv-b', name: 'beta_tool', description: '工具B描述' };

type McpToolStub = { serverId: string; name: string; description: string };

// ─── 可控新鲜度时钟（生产默认 performance.now，测试里手动推进） ──

let clockNow = 0;

function advanceClock(ms: number): void {
  clockNow += ms;
}

// ─── FakeXHR（同 skills-fresh）─────────────────────────────────

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
    /** origSend 是否被实际调用（有界等待期间为 false）。 */
    sent = false;
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
      this.onreadystatechange?.();
    }
    abort() { this.status = 0; this.responseText = ''; this.readyState = 4; this.onreadystatechange?.(); }
  };
}

// ─── Chat UI stub ─────────────────────────────────────────────

function makeChatUI() {
  return {
    sessionKey: 'mcp-refresh:session',
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

// ─── sender stub：mcp.list 可切换为「挂起／失败」，其余按需返回 ───

interface SenderRequest {
  invocationName: string;
  params?: Record<string, unknown>;
}

type Sender = (req: SenderRequest) => Promise<ExecuteResult>;

interface HeldMcpList {
  release(result: ExecuteResult): void;
}

interface Harness {
  FakeXHR: ReturnType<typeof makeFakeXhrClass>;
  handle: MainWorldInterceptorHandle;
  sender: ReturnType<typeof vi.fn<Sender>>;
  fetchMock: ReturnType<typeof vi.fn>;
  setMcpTools(tools: McpToolStub[]): void;
  setMcpFail(fail: boolean): void;
  holdNextMcpList(): HeldMcpList;
  mcpListCalls(): number;
  skillListCalls(): number;
}

function installHarness(opts: { tools?: McpToolStub[] } = {}): Harness {
  const tools: McpToolStub[] = opts.tools ? opts.tools.map((t) => ({ ...t })) : [{ ...MCP_TOOL_A }];
  let fail = false;
  let held: { promise: Promise<ExecuteResult>; release(result: ExecuteResult): void } | null = null;

  const sender = vi.fn(async (req: SenderRequest): Promise<ExecuteResult> => {
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    if (req.invocationName === 'mcp.list') {
      if (held) return held.promise;
      if (fail) return { ok: false, error: 'mcp-stub-fail' };
      return { ok: true, data: { tools: tools.map((t) => ({ ...t })), servers: [...new Set(tools.map((t) => t.serverId))] } };
    }
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
  }) as ReturnType<typeof vi.fn<Sender>>;

  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  }));

  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });

  const diagLines: string[] = [];
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: makeChatUI() as never,
    diag: (line) => diagLines.push(line),
  });

  return {
    FakeXHR,
    handle,
    sender,
    fetchMock,
    setMcpTools(next) { tools.splice(0, tools.length, ...next.map((t) => ({ ...t }))); },
    setMcpFail(next) { fail = next; },
    holdNextMcpList() {
      let release!: (result: ExecuteResult) => void;
      const promise = new Promise<ExecuteResult>((resolve) => { release = resolve; });
      held = {
        promise,
        release(result) {
          held = null;
          release(result);
        },
      };
      return { release: (result: ExecuteResult) => held?.release(result) ?? release(result) };
    },
    mcpListCalls() {
      return sender.mock.calls.filter((c) => (c[0] as SenderRequest)?.invocationName === 'mcp.list').length;
    },
    skillListCalls() {
      return sender.mock.calls.filter((c) => (c[0] as SenderRequest)?.invocationName === 'skill.list').length;
    },
  };
}

// ─── 辅助（同 skills-fresh）───────────────────────────────────

/** 等若干轮 microtask（不依赖 timers，fake timers 下同样可用）。 */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function pageSend(
  FakeXHR: ReturnType<typeof makeFakeXhrClass>,
  body: Record<string, unknown>,
): InstanceType<ReturnType<typeof makeFakeXhrClass>> {
  const xhr = new FakeXHR();
  xhr.open('POST', CHAT_URL);
  xhr.onreadystatechange = () => {};
  xhr.send(JSON.stringify(body));
  return xhr;
}

function sentBody(xhr: { body: string | null }): string {
  return String(xhr.body ?? '');
}

/** 在输入框里敲一下（触发 document 上的 input 捕获监听）。 */
function typeInComposer(): void {
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.value = '/';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  clockNow = 0;
  __resetSkillsFreshnessForTests();
  __setSkillsFreshnessClockForTests(() => clockNow);
  __resetMcpToolsFreshnessForTests();
  __setMcpToolsFreshnessClockForTests(() => clockNow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetSkillsFreshnessForTests();
  __resetMcpToolsFreshnessForTests();
});

describe('㊿-c-补⑤ MCP 工具清单运行期刷新', () => {
  it('① TTL 内新鲜：发送点不额外调 mcp.list（负控：不重复拉取）', async () => {
    const h = installHarness({ tools: [MCP_TOOL_A] });
    try {
      await flush();
      // 启动 IIFE 拉过一次（tools 非空即停）。
      expect(h.mcpListCalls()).toBe(1);

      advanceClock(1_000); // 仍在 5s TTL 内
      const xhr = pageSend(h.FakeXHR, { prompt: '你好', chat_session_id: 'm-ttl-1' });
      // 正控：TTL 内不延迟、不拉取。
      expect(xhr.sent).toBe(true);
      expect(h.mcpListCalls()).toBe(1);
      expect(sentBody(xhr)).toContain(MCP_BLOCK_MARKER);
      expect(sentBody(xhr)).toContain('### 服务器：srv-a');
    } finally {
      h.handle.stop();
    }
  });

  it('② TTL 过期：关 ⇒ 注入块消失，开 ⇒ 恢复（双向，真源在宿主）', async () => {
    const h = installHarness({ tools: [MCP_TOOL_A] });
    try {
      await flush();
      expect(h.mcpListCalls()).toBe(1);

      // 关：宿主侧全关后 mcp.list 回空清单（enabled-only 模型面）。
      h.setMcpTools([]);
      advanceClock(5_001);
      const off = pageSend(h.FakeXHR, { prompt: '你有哪些 MCP 工具', chat_session_id: 'm-off' });
      await flush();
      expect(h.mcpListCalls()).toBe(2); // 过期后 kick 拉了一次
      const offBody = sentBody(off);
      expect(offBody).not.toContain(MCP_BLOCK_MARKER); // 空清单 ⇒ 整块消失
      expect(offBody).not.toContain('alpha_tool');

      // 开：宿主重新启用，清单恢复；再过期再拉。
      h.setMcpTools([MCP_TOOL_A, MCP_TOOL_B]);
      advanceClock(5_001);
      const on = pageSend(h.FakeXHR, { prompt: '你有哪些 MCP 工具', chat_session_id: 'm-on' });
      await flush();
      expect(h.mcpListCalls()).toBe(3);
      const onBody = sentBody(on);
      expect(onBody).toContain(MCP_BLOCK_MARKER);
      expect(onBody).toContain('### 服务器：srv-a');
      expect(onBody).toContain('### 服务器：srv-b');
    } finally {
      h.handle.stop();
    }
  });

  it('③ 并发两次 chat send 复用同一 in-flight（mcp.list 只发一次）', async () => {
    const h = installHarness({ tools: [MCP_TOOL_A] });
    try {
      await flush();
      expect(h.mcpListCalls()).toBe(1);

      advanceClock(5_001);
      const gate = h.holdNextMcpList(); // 让这次刷新挂起
      const a = pageSend(h.FakeXHR, { prompt: '并发 A', chat_session_id: 'm-conc-a' });
      const b = pageSend(h.FakeXHR, { prompt: '并发 B', chat_session_id: 'm-conc-b' });
      await flush();

      // 两次 send 只多出一次 mcp.list。
      expect(h.mcpListCalls()).toBe(2);
      expect(a.sent).toBe(false);
      expect(b.sent).toBe(false);

      gate.release({ ok: true, data: { tools: [MCP_TOOL_A, MCP_TOOL_B], servers: ['srv-a', 'srv-b'] } });
      await flush();

      expect(a.sent).toBe(true);
      expect(b.sent).toBe(true);
      expect(h.mcpListCalls()).toBe(2); // 没有再发第二条
    } finally {
      h.handle.stop();
    }
  });

  it('④ 拉取失败：保留旧清单、注入块不变、不抛（不假清空）', async () => {
    const h = installHarness({ tools: [MCP_TOOL_A] });
    try {
      await flush();
      expect(h.mcpListCalls()).toBe(1);
      // 缓存里已有 srv-a 的工具。
      const before = pageSend(h.FakeXHR, { prompt: '第一问', chat_session_id: 'm-fail-0' });
      await flush();
      expect(sentBody(before)).toContain('alpha_tool');

      // 宿主拒绝（模拟 401/断连）：过期后 kick 拉取失败。
      h.setMcpFail(true);
      advanceClock(5_001);
      const xhr = pageSend(h.FakeXHR, { prompt: '第二问', chat_session_id: 'm-fail-1' });
      await flush();
      expect(h.mcpListCalls()).toBe(2); // 失败那次也计
      // 不假清空：旧清单（srv-a）仍在注入块里；发送不被阻塞。
      const body = sentBody(xhr);
      expect(xhr.sent).toBe(true);
      expect(body).toContain(MCP_BLOCK_MARKER);
      expect(body).toContain('alpha_tool');
    } finally {
      h.handle.stop();
    }
  });

  it('⑤ 打字预热：输入停顿后异步拉，发送点直接用新清单（不再挂起）', async () => {
    vi.useFakeTimers();
    const h = installHarness({ tools: [MCP_TOOL_A] });
    try {
      await flush();
      expect(h.mcpListCalls()).toBe(1); // 启动拉过一次

      // 运行期新增 srv-b + TTL 过期。
      h.setMcpTools([MCP_TOOL_A, MCP_TOOL_B]);
      advanceClock(5_001);

      typeInComposer();
      // 负控：输入本身不拉（预热是排队，不是同步打请求）。
      expect(h.mcpListCalls()).toBe(1);
      await vi.advanceTimersByTimeAsync(600); // 输入停顿 → 预热触发
      expect(h.mcpListCalls()).toBe(2);

      // 正控：TTL 已新鲜，发送不被有界等待挂起，当轮即带新清单。
      const xhr = pageSend(h.FakeXHR, { prompt: '列出全部工具', chat_session_id: 'm-prewarm' });
      expect(xhr.sent).toBe(true);
      await flush();
      const body = sentBody(xhr);
      expect(body).toContain('### 服务器：srv-b');
      expect(h.mcpListCalls()).toBe(2); // 发送点没有再拉
    } finally {
      h.handle.stop();
    }
  });
});
