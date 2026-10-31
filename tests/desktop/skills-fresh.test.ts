import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// auto-continue（首轮原样重发）会算 PoW；这里只需要它立即返回，不关心真实凭证。
vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'skills-fresh-stub' })),
}));

import {
  __resetSkillsFreshnessForTests,
  __setSkillsFreshnessClockForTests,
  installMainWorldInterceptor,
  type MainWorldInterceptorHandle,
  type StudioSkillDescriptor,
} from '../../src/inject/main-world-interceptor';
import type { ExecuteResult } from '../../src/capabilities/types';

// @vitest-environment jsdom

/**
 * P0：技能清单运行期刷新（注入侧）。
 *
 * 现场：启动时 `skill.list` 只拉一次，之后 `currentSkills` 永不刷新。运行期新增技能在
 * `/` 浮层里看得到（desktop/entry.ts 自己刷新），但注入提示词仍读旧缓存
 * → 「面板看得到、模型调不到」。
 *
 * 本文件按语义断言（发出的请求体里有什么、skill.list 被调了几次、发送是否被阻塞），
 * 不依赖内部变量：
 *   1. TTL 内连续两次 send 只触发一次 skill.list（负控：不重复拉取）；
 *   2. 并发两次 send 复用同一 in-flight（只发一次）；
 *   3. TTL 过期后刷新，新增技能真的进入注入的显式技能块（负控：刷新前不含）；
 *   4. 有界等待 150ms 超时后照常发送，并用旧清单注入；
 *   5. inFirstAttemptResend=true 时不刷新、不二次注入（逐字节幂等）；
 *   6. XHR 每条请求只注入一份能力提示（含延迟发送路径）；
 *   7. fetch 路径 chat 请求会刷新、非 chat 请求不刷新。
 */

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';
const NON_CHAT_URL = 'https://chat.deepseek.com/api/v0/client/settings';
const CAP_MARKER = '[studio-tool-capability]';
const CAP_END_MARKER = '[studio-tool-capability-end]';

const SKILL_A: StudioSkillDescriptor = {
  id: 'skill-a',
  name: '技能A',
  description: 'A 的描述',
  skillMdPath: 'E:/NAS/skills/skill-a/SKILL.md',
};
const SKILL_B: StudioSkillDescriptor = {
  id: 'skill-b',
  name: '技能B',
  description: 'B 的描述',
  skillMdPath: 'E:/NAS/skills/skill-b/SKILL.md',
};

// ─── 可控新鲜度时钟（生产默认 performance.now，测试里手动推进） ──

let clockNow = 0;

function advanceClock(ms: number): void {
  clockNow += ms;
}

// ─── FakeXHR：带 sent 标志，能断言 origSend 是否被延迟 ─────────

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
    sessionKey: 'skills-fresh:session',
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

// ─── sender stub：skill.list 可切换为「挂起」，其余按需返回 ───

interface SenderRequest {
  invocationName: string;
  params?: Record<string, unknown>;
}

type Sender = (req: SenderRequest) => Promise<ExecuteResult>;

interface HeldSkillList {
  release(result: ExecuteResult): void;
}

interface Harness {
  FakeXHR: ReturnType<typeof makeFakeXhrClass>;
  handle: MainWorldInterceptorHandle;
  sender: ReturnType<typeof vi.fn<Sender>>;
  chatUI: ReturnType<typeof makeChatUI>;
  fetchMock: ReturnType<typeof vi.fn>;
  diagLines: string[];
  setSkills(skills: StudioSkillDescriptor[]): void;
  holdNextSkillList(): HeldSkillList;
  skillListCalls(): number;
}

function installHarness(opts: { skills?: StudioSkillDescriptor[] } = {}): Harness {
  let skills: StudioSkillDescriptor[] = opts.skills ? [...opts.skills] : [];
  let held: { promise: Promise<ExecuteResult>; release(result: ExecuteResult): void } | null = null;

  const sender = vi.fn(async (req: SenderRequest): Promise<ExecuteResult> => {
    if (req.invocationName === 'skill.list') {
      if (held) return held.promise;
      return { ok: true, data: { skills: [...skills] } };
    }
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
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

  const chatUI = makeChatUI();
  const diagLines: string[] = [];
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: (line) => diagLines.push(line),
  });

  return {
    FakeXHR,
    handle,
    sender,
    chatUI,
    fetchMock,
    diagLines,
    setSkills(next) { skills = [...next]; },
    holdNextSkillList() {
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
    skillListCalls() {
      return sender.mock.calls.filter((c) => (c[0] as SenderRequest)?.invocationName === 'skill.list').length;
    },
  };
}

// ─── 辅助 ─────────────────────────────────────────────────────

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

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

/** 取出实际发出的请求体（注入发生在 origSend 之前，body 即最终字节）。 */
function sentBody(xhr: { body: string | null }): string {
  return String(xhr.body ?? '');
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

beforeEach(() => {
  __resetSkillsFreshnessForTests();
  clockNow = 0;
  __setSkillsFreshnessClockForTests(() => clockNow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetSkillsFreshnessForTests();
});

describe('P0 技能清单运行期刷新', () => {
  it('TTL 内连续两次 chat send 只触发一次 skill.list', async () => {
    const h = installHarness({ skills: [SKILL_A] });
    try {
      await flush();
      // 启动加载一次。
      expect(h.skillListCalls()).toBe(1);

      advanceClock(5_001); // 超过 5s TTL → 过期
      const first = pageSend(h.FakeXHR, { prompt: '你好', chat_session_id: 's-ttl-1' });
      // 正控：过期后的发送确实被有界等待挂起（不是直接放行旧清单）。
      expect(first.sent).toBe(false);
      await flush();
      expect(first.sent).toBe(true);
      expect(h.skillListCalls()).toBe(2); // 过期后刷新一次

      advanceClock(1_000); // 仍在 TTL 内
      const second = pageSend(h.FakeXHR, { prompt: '再来一次', chat_session_id: 's-ttl-2' });
      await flush();
      // 负控：TTL 内不再拉取，也没有延迟。
      expect(h.skillListCalls()).toBe(2);
      expect(second.sent).toBe(true);
    } finally {
      h.handle.stop();
    }
  });

  it('并发两次 chat send 复用同一 in-flight（只发一次 skill.list）', async () => {
    const h = installHarness({ skills: [SKILL_A] });
    try {
      await flush();
      expect(h.skillListCalls()).toBe(1);

      advanceClock(5_001);
      const gate = h.holdNextSkillList(); // 让这次刷新挂起
      const a = pageSend(h.FakeXHR, { prompt: '并发 A', chat_session_id: 's-conc-a' });
      const b = pageSend(h.FakeXHR, { prompt: '并发 B', chat_session_id: 's-conc-b' });
      await flush();

      // 两次 send 只多出一次 skill.list。
      expect(h.skillListCalls()).toBe(2);
      expect(a.sent).toBe(false);
      expect(b.sent).toBe(false);

      gate.release({ ok: true, data: { skills: [SKILL_A, SKILL_B] } });
      await flush();

      // 复用同一个 in-flight：两条请求都放行，且没有再发 skill.list。
      expect(a.sent).toBe(true);
      expect(b.sent).toBe(true);
      expect(h.skillListCalls()).toBe(2);
    } finally {
      h.handle.stop();
    }
  });

  it('TTL 过期后刷新，新增技能进入注入的显式技能块', async () => {
    const h = installHarness({ skills: [SKILL_A] });
    try {
      await flush();

      // 负控：缓存里还没有 skill-b，点名它也不会出现在提示词里。
      const before = pageSend(h.FakeXHR, { prompt: '用 skill-b 跑一遍', chat_session_id: 's-new-before' });
      await flush();
      expect(sentBody(before)).not.toContain(SKILL_B.skillMdPath);

      // 运行期新增技能 + TTL 过期。
      h.setSkills([SKILL_A, SKILL_B]);
      advanceClock(5_001);
      const after = pageSend(h.FakeXHR, { prompt: '用 skill-b 跑一遍', chat_session_id: 's-new-after' });
      await flush();

      const body = sentBody(after);
      // 正控：新技能真的进了本轮注入的显式技能块。
      expect(body).toContain('## 技能（仅限用户明确点名）');
      expect(body).toContain(SKILL_B.skillMdPath);
      expect(body).toContain('skill-b');
      // 用户原文不被改写。
      expect(body).toContain('用 skill-b 跑一遍');
    } finally {
      h.handle.stop();
    }
  });

  it('有界等待超时（150ms）不阻塞发送，且用旧清单注入', async () => {
    vi.useFakeTimers();
    const h = installHarness({ skills: [SKILL_A] });
    try {
      await flush();
      expect(h.skillListCalls()).toBe(1);

      advanceClock(5_001);
      h.holdNextSkillList(); // 刷新永不返回
      const xhr = pageSend(h.FakeXHR, { prompt: '用 skill-a 做审计', chat_session_id: 's-timeout' });
      expect(xhr.sent).toBe(false);

      await vi.advanceTimersByTimeAsync(149);
      expect(xhr.sent).toBe(false); // 仍在 150ms 预算内

      await vi.advanceTimersByTimeAsync(1);
      expect(xhr.sent).toBe(true); // 超时放行，不阻塞发送

      // 用旧清单（A）注入，而不是空清单/新清单。
      const body = sentBody(xhr);
      expect(body).toContain(SKILL_A.skillMdPath);
      expect(body).not.toContain(SKILL_B.skillMdPath);
      expect(countOccurrences(body, CAP_MARKER)).toBe(1);
    } finally {
      h.handle.stop();
    }
  });

  it('首轮原样重发（inFirstAttemptResend）不刷新、不二次注入', async () => {
    vi.useFakeTimers();
    const h = installHarness({ skills: [SKILL_A] });
    try {
      await flush();
      expect(h.skillListCalls()).toBe(1);

      const first = pageSend(h.FakeXHR, { prompt: '用 skill-a 做审计', chat_session_id: 's-resend' });
      await flush();
      const firstBody = sentBody(first);
      expect(firstBody).toContain(SKILL_A.skillMdPath);
      expect(countOccurrences(firstBody, CAP_MARKER)).toBe(1);
      expect(countOccurrences(firstBody, CAP_END_MARKER)).toBe(1);

      // 首轮网络失败 → 2s 退避后原样重发；期间 TTL 过期，但重发不得刷新。
      first.respond(0, '');
      advanceClock(5_001);
      await vi.advanceTimersByTimeAsync(5_000);

      const requests = chatRequests(h.FakeXHR);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      const resend = requests[1];
      // 逐字节相同：既没有二次注入，也没有重新序列化。
      expect(sentBody(resend)).toBe(firstBody);
      expect(countOccurrences(sentBody(resend), CAP_MARKER)).toBe(1);
      // 负控：重发没有触发 skill.list。
      expect(h.skillListCalls()).toBe(1);
    } finally {
      h.handle.stop();
    }
  });

  it('XHR 每条请求只注入一份能力提示（含延迟发送路径）', async () => {
    const h = installHarness({ skills: [SKILL_A] });
    try {
      await flush();

      // 立即发送路径。
      const direct = pageSend(h.FakeXHR, { prompt: '第一轮', chat_session_id: 's-inject-1' });
      await flush();
      expect(direct.sent).toBe(true);

      // 延迟发送路径（TTL 过期 → 有界等待后 origSend）。
      advanceClock(5_001);
      const delayed = pageSend(h.FakeXHR, { prompt: '第二轮', chat_session_id: 's-inject-2' });
      expect(delayed.sent).toBe(false);
      await flush();
      expect(delayed.sent).toBe(true);

      for (const xhr of [direct, delayed]) {
        const body = sentBody(xhr);
        expect(countOccurrences(body, CAP_MARKER)).toBe(1);
        expect(countOccurrences(body, CAP_END_MARKER)).toBe(1);
      }
      // 用户原文各出现一次（没有被拼接两遍）。
      expect(countOccurrences(sentBody(direct), '第一轮')).toBe(1);
      expect(countOccurrences(sentBody(delayed), '第二轮')).toBe(1);
      // 注入分支每条请求只跑一次（延迟路径若二次注入会多一条 injected 诊断）。
      const injectedDiag = h.diagLines.filter((line) => line.includes('xhr chat body injected'));
      expect(injectedDiag).toHaveLength(2);
    } finally {
      h.handle.stop();
    }
  });

  it('fetch 路径：chat 请求会刷新清单，非 chat 请求不刷新', async () => {
    const h = installHarness({ skills: [SKILL_A] });
    try {
      await flush();
      expect(h.skillListCalls()).toBe(1);

      advanceClock(5_001);
      const fetchFn = (globalThis as { fetch: typeof fetch }).fetch;

      // 非 chat：不得阻塞、也不得刷新。
      await fetchFn(NON_CHAT_URL, { method: 'POST', body: JSON.stringify({ scope: 'main' }) });
      expect(h.skillListCalls()).toBe(1);

      // chat：刷新一次后照常完成请求。
      const response = await fetchFn(CHAT_URL, {
        method: 'POST',
        body: JSON.stringify({ prompt: '你好', chat_session_id: 's-fetch' }),
      });
      expect(h.skillListCalls()).toBe(2);
      expect(response.status).toBe(200);
    } finally {
      h.handle.stop();
    }
  });
});
