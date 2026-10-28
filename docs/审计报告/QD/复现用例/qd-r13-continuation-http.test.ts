// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

/**
 * QD-R13 复现件：自动续跑的请求生命周期（凭证捕获 / 超时）。
 *
 * 断言按「期望行为」写：
 *   - 控制腿必须通过（证明夹具与主链是通的）；
 *   - 复现腿失败 = 缺陷成立。
 *
 * 面：盘面 src/inject/main-world-interceptor.ts sha1 a13385f5（mtime 2026-10-23 01:56:27）；
 *     src/inject/pow.ts sha1 0249c7dd（mtime 2026-10-21 07:55:00）。
 * PoW 被部分 mock：记录收到的 headers 后按模式抛错/返回桩头，不触网、不跑 WASM。
 */

const powState = vi.hoisted(() => ({
  calls: [] as Record<string, string>[],
  mode: 'throw' as 'throw' | 'ok',
}));

vi.mock('../../src/inject/pow', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/inject/pow')>();
  return {
    ...real,
    createPowHeaders: vi.fn(async (headers: Record<string, string>) => {
      powState.calls.push({ ...headers });
      if (powState.mode === 'throw') throw new Error('pow-stub-for-r13');
      return { 'X-DS-PoW-Response': 'stub-pow' };
    }),
  };
});

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

const DONE =
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
  + 'event: close\ndata: {"click_behavior":"none"}\n\n';

function sseText(text: string): string {
  return `data: ${JSON.stringify({ v: text })}\n\n`;
}

function toChunks(text: string, size: number): Uint8Array[] {
  const enc = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < enc.length; i += size) out.push(enc.slice(i, i + size));
  return out;
}

function makeStreamResponse(chunks: Uint8Array[]) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    statusText: 'OK',
    body: {
      getReader() {
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
  } as unknown as Response;
}

/** 假 XHR：记录实例与请求头，不自动回调；由用例手动驱动。 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  readyState = 0;
  status = 0;
  responseText = '';
  timeout = 0;
  ontimeout: (() => void) | null = null;
  onreadystatechange: (() => void) | null = null;
  method = '';
  url = '';
  body: unknown = null;
  headers: Record<string, string> = {};
  aborted = false;

  open(method: string, url: string): void {
    this.method = method;
    this.url = String(url);
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body?: unknown): void {
    this.body = body;
    FakeXhr.instances.push(this);
  }

  abort(): void {
    this.aborted = true;
    this.readyState = 4;
    this.status = 0;
    this.onreadystatechange?.();
  }

  drive(stream: string): void {
    this.status = 200;
    this.responseText = stream;
    this.readyState = 3;
    this.onreadystatechange?.();
    this.readyState = 4;
    this.onreadystatechange?.();
  }
}

function makeChatUI() {
  return {
    sessionKey: 'test:session',
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
  };
}

function installHarness() {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const diags: string[] = [];
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
  });
  const chatUI = makeChatUI();
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: (m: string) => { diags.push(String(m)); },
  });
  return { handle, sender, chatUI, fetchMock, diags };
}

async function sendViaFetch(fetchMock: ReturnType<typeof vi.fn>, prompt: string, response: Response): Promise<void> {
  fetchMock.mockResolvedValue(response);
  await (globalThis as unknown as { fetch: typeof fetch }).fetch(CHAT_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'X-Client-Version': '9.9.9' },
    body: JSON.stringify({ prompt, chat_session_id: 'r13' }),
  });
  await new Promise((r) => setTimeout(r, 80));
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  powState.calls.length = 0;
  powState.mode = 'throw';
  FakeXhr.instances = [];
  vi.unstubAllGlobals();
});

describe('QD-R13 控制腿：页面走 XHR 时请求头能被捕获并喂给续跑 PoW', () => {
  it('CONTROL setRequestHeader 捕获的 authorization 出现在 createPowHeaders 入参里', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { handle, chatUI, diags } = installHarness();
    try {
      const page = new FakeXhr();
      page.open('POST', CHAT_URL);
      page.setRequestHeader('Authorization', 'Bearer captured');
      page.setRequestHeader('X-Client-Version', '9.9.9');
      page.send(JSON.stringify({ prompt: '执行一下', chat_session_id: 'r13' }));
      page.drive(sseText('<shell_exec>{"command":"echo step"}</shell_exec>') + DONE);

      await waitFor(() => diags.some((d) => d.includes('computing PoW')));
      expect(powState.calls.length, '未进入续跑').toBeGreaterThan(0);
      const sent = Object.fromEntries(
        Object.entries(powState.calls[0]).map(([k, v]) => [k.toLowerCase(), v]),
      );
      expect(sent.authorization).toBe('Bearer captured');
      expect(sent['x-client-version']).toBe('9.9.9');
      expect(chatUI.appendError.mock.calls.map((c) => c[0])).not.toContain('network-error');
    } finally {
      handle.stop();
    }
  });
});

describe('QD-R13-01 fetch 路径的请求头不进 capturedHeaders', () => {
  it('REPRO 页面用 fetch + init.headers 时，续跑 PoW 拿不到 authorization', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { handle, fetchMock } = installHarness();
    try {
      await sendViaFetch(
        fetchMock,
        '执行一下',
        makeStreamResponse(toChunks(
          sseText('<shell_exec>{"command":"echo step"}</shell_exec>') + DONE,
          9,
        )),
      );

      await waitFor(() => powState.calls.length > 0);
      expect(powState.calls.length, '未进入续跑').toBeGreaterThan(0);
      expect(
        Object.keys(powState.calls[0]).map((k) => k.toLowerCase()).sort(),
        'fetch hook 只捕获 body，不捕获 init.headers：续跑 PoW 的凭证集为空',
      ).toContain('authorization');
    } finally {
      handle.stop();
    }
  });
});

describe('QD-R13-02 续跑 XHR 无超时、无 ontimeout 兜底', () => {
  it('REPRO 连接挂住时循环与 UI 永久停在 running（无超时配置、无错误、busy 不复位）', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    powState.mode = 'ok';
    const { handle, chatUI, diags } = installHarness();
    try {
      const page = new FakeXhr();
      page.open('POST', CHAT_URL);
      page.setRequestHeader('Authorization', 'Bearer captured');
      page.send(JSON.stringify({ prompt: '执行一下', chat_session_id: 'r13' }));
      page.drive(sseText('<shell_exec>{"command":"echo step"}</shell_exec>') + DONE);

      // 等续跑请求真正发出（PoW 返回桩头后 new XMLHttpRequest().send()）。
      await waitFor(() => diags.some((d) => d.includes('PoW done')));
      const cont = FakeXhr.instances.find((x) => x !== page && x.method === 'POST');
      expect(cont, '续跑 XHR 未发出').toBeTruthy();

      // 模拟 TCP 黑洞：不回调、不超时。等 1.2s 观察是否有人兜底。
      await new Promise((r) => setTimeout(r, 1200));

      expect.soft(cont!.timeout, '续跑 XHR 未设置 timeout（默认 0 = 永不超时）').toBeGreaterThan(0);
      expect.soft(cont!.ontimeout, '续跑 XHR 未注册 ontimeout 兜底').not.toBeNull();
      const busyCalls = chatUI.setBusy.mock.calls.map((c) => c[0]);
      expect.soft(busyCalls[busyCalls.length - 1], '挂起 1.2s 后 UI 仍停在 busy（无任何可见错误）').toBe(false);
      expect.soft(chatUI.appendError.mock.calls.map((c) => c[0]), '挂起后没有任何可见错误').not.toEqual([]);
    } finally {
      handle.stop();
    }
  });
});
