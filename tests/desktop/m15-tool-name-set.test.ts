// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'm15-stub' })),
}));

import {
  installMainWorldInterceptor,
  interceptorTraceSnapshot,
  capabilityPromptText,
  catalogText,
  catalogTextToolNames,
  __setCapabilityPromptForTesting,
} from '../../src/inject/main-world-interceptor';

/**
 * M1.5 护栏：删掉续跑 prompt 里的重复工具目录后，**最终 body 的 prompt** 里
 * 10 个 studio 工具名仍然齐全。
 *
 * 为什么必须打真实路径：工具名是靠「二次注入」（能力块）补回来的，
 * 哪条路径没走注入，名字就没了 → 断言必须打在 `prepareOutgoingBody`
 * 产出的最终 prompt 上，不是 `buildCapabilityPrompt`。
 *
 * 本文件驱动**真实续跑轮**（首轮 SSE 里带工具标签 → 宿主回工具结果 →
 * auto-continue 发第二条 chat 请求），抓那条请求的 body = 最终 body。
 */

type Handler = ((...a: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n';
}
function sseTool(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo hi\\"}</shell_exec>"}]}\n\n';
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

interface Harness {
  FakeXHR: ReturnType<typeof makeFakeXhrClass>;
  handle: { stop(): void };
  chatRequests(): Array<{ body: string | null }>;
}

function installHarness(): Harness {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'hi', exitCode: 0 } }));
  const chatUI = {
    sessionKey: 'm15:session',
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
  const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });
  return {
    FakeXHR,
    handle,
    chatRequests: () => FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion')),
  };
}

/** 跑一轮带工具的真实对话，拿到续跑轮的请求 body（= 最终 body）。 */
async function runContinuationRound(h: Harness, sessionId: string): Promise<string> {
  const first = new h.FakeXHR();
  first.open('POST', CHAT_URL);
  first.onreadystatechange = () => {};
  first.send(JSON.stringify({ prompt: '帮我跑个命令', chat_session_id: sessionId }));
  first.respond(200, sseTool() + sseDone());
  await vi.advanceTimersByTimeAsync(2_000);
  const requests = h.chatRequests();
  expect(requests.length).toBeGreaterThanOrEqual(2);
  return String(requests[1].body ?? '');
}

/** 最终 body 的 prompt。 */
function promptOf(body: string): string {
  const parsed = JSON.parse(body) as { prompt?: string };
  return parsed.prompt ?? '';
}

/** 工具声明行（能力块「## 可用工具」段的 10 行，与目录逐字节相同）。 */
function catalogLines(): string[] {
  return catalogText().split('\n').filter((l) => l.startsWith('- '));
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return n;
    n += 1;
    from = at + needle.length;
  }
}

/** 摘掉能力块里的「## 可用工具」段（负控：模拟「二次注入那一段被摘掉」）。 */
function stripToolSection(capability: string): string {
  const start = capability.indexOf('## 可用工具');
  if (start < 0) return capability;
  const tail = '\n\n系统会真实执行';
  const tailIdx = capability.indexOf(tail, start);
  return tailIdx >= 0 ? capability.slice(0, start) + capability.slice(tailIdx) : capability.slice(0, start);
}

beforeEach(() => {
  __setCapabilityPromptForTesting(null);
});

afterEach(() => {
  __setCapabilityPromptForTesting(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('M1.5 护栏：工具名可发现性（打真实路径）', () => {
  it('真实续跑轮的最终 body 里，10 个 studio 工具名全部齐全（且只出现一次）', async () => {
    vi.useFakeTimers();
    const h = installHarness();
    try {
      const body = await runContinuationRound(h, 'm15-names');
      const prompt = promptOf(body);
      const names = catalogTextToolNames();
      expect(names).toHaveLength(10);
      for (const name of names) {
        expect(prompt, `工具名缺失：${name}`).toContain(name);
      }
      // 能力块确实进了最终 body（否则上面的断言是假的）
      expect(prompt).toContain('[studio-tool-capability]');
      // M1.5 删冗余后：工具声明**只出现一次**（删前是 2 次 —— head 一次 + tail 的重复目录一次）
      expect(countOccurrences(prompt, '## 可用工具')).toBe(1);
      for (const line of catalogLines()) {
        expect(countOccurrences(prompt, line), `工具声明行重复或缺失：${line}`).toBe(1);
      }
    } finally {
      h.handle.stop();
    }
  });

  it('负控：把二次注入那一段摘掉 → 工具声明行必须消失（护栏转红，不是摆设）', async () => {
    // 删掉 tail 的重复目录后，head 是工具声明的**唯一**来源：
    // 把 head 那段摘掉，10 行声明必须全部消失 —— 否则上面那条护栏就是摆设。
    vi.useFakeTimers();
    const h = installHarness();
    try {
      __setCapabilityPromptForTesting(stripToolSection(capabilityPromptText()));
      const body = await runContinuationRound(h, 'm15-neg');
      const prompt = promptOf(body);
      for (const line of catalogLines()) {
        expect(prompt, `摘掉二次注入后工具声明行仍在：${line}`).not.toContain(line);
      }
    } finally {
      h.handle.stop();
    }
  });

  it('工具目录文本本身是能力块工具段的逐字节重复（删冗余的依据）', () => {
    const cap = capabilityPromptText();
    const catalog = catalogText();
    const capSection = cap.slice(cap.indexOf('## 可用工具'));
    const capLines = capSection.split('\n').filter((l) => l.startsWith('- '));
    const catLines = catalog.split('\n').filter((l) => l.startsWith('- '));
    expect(capLines).toHaveLength(10);
    expect(catLines).toHaveLength(10);
    expect(capLines).toEqual(catLines); // 逐字节相同
    // 目录只多一行「调用方式」说明（134 B），已被能力块「## 工具调用」段覆盖
    expect(catalog.length - capLines.join('\n').length).toBeGreaterThan(0);
  });

  it('真实续跑轮：续跑 prompt 已不带目录（m15.continuation_prompt.hasCatalog=false）', async () => {
    vi.useFakeTimers();
    const h = installHarness();
    try {
      await runContinuationRound(h, 'm15-nocatalog');
      const events = interceptorTraceSnapshot()
        .filter((e) => (e as unknown as { t: string }).t === 'm15.continuation_prompt') as unknown as
        Array<{ hasCatalog: boolean; bytes: number }>;
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1].hasCatalog).toBe(false);
      expect(events[events.length - 1].bytes).toBeGreaterThan(0);
    } finally {
      h.handle.stop();
    }
  });
});
