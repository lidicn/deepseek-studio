// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * QD-R8o 复现件：同一段工具标签被 fetch 与 XHR 两条拦截通道各自解析时，宿主收到几次执行。
 *
 * 断言全部按「应有行为」写：复现腿红＝缺陷成立。
 *   CONTROL-E fetch 单通道一次 → 宿主 1 次（计数尺与链路基准）
 *   CONTROL-F XHR 单通道一次 → 宿主 1 次（证明 XHR 通道确实解析工具标签）
 *   REPRO-E   同一段字节两通道各投一次 → 应有行为＝宿主只真跑 1 次
 *
 * 面：`9d093dc` 的盘面 src/inject/main-world-interceptor.ts（:888/:910 fetch 解析点、
 * :1141/:1186 XHR 解析点、:1452-1456 callId 去重门）。⛔ 改 src，⛔ commit。
 * 夹具来源：tests/desktop/qd-r7-stream-sentinel-ownership.test.ts 的 FakeXHR 与
 * docs/审计报告/QD/复现用例/qd-r12-stream-pipeline.test.ts 的 fetch 流式夹具。
 */

vi.mock('../../src/inject/pow', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/inject/pow')>();
  return {
    ...real,
    createPowHeaders: vi.fn(async () => {
      throw new Error('pow-stub-for-r8o-dual');
    }),
  };
});

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

const DONE =
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
  + 'event: close\ndata: {"click_behavior":"none"}\n\n';

/** 同一段字节：两条通道读到的是完全相同的 SSE 文本。 */
const SEGMENT =
  `data: ${JSON.stringify({ v: '我来执行：' })}\n\n`
  + `data: ${JSON.stringify({ v: '<shell_exec>{"command":"echo dual-channel"}</shell_exec>' })}\n\n`
  + DONE;

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

type Handler = ((...args: unknown[]) => void) | null;

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
    /** 分两段回：先 readyState=3（流中），再 4（EOF）——与真 XHR 同形。 */
    respond(status: number, text: string) {
      this.status = status;
      const half = Math.floor(text.length / 2);
      this.responseText = text.slice(0, half);
      this.readyState = 3;
      this.onreadystatechange?.();
      this.responseText = text;
      this.readyState = 4;
      this.onreadystatechange?.();
    }
    abort() {
      this.status = 0;
      this.responseText = '';
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  };
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
  const FakeXHR = makeFakeXhrClass();
  FakeXHR.instances = [];
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const diags: string[] = [];
  const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'ok', exitCode: 0 } }));
  const chatUI = makeChatUI();
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: (m: string) => { diags.push(String(m)); },
  });
  return { handle, sender, chatUI, fetchMock, FakeXHR, diags };
}

function shellCalls(sender: ReturnType<typeof vi.fn>) {
  return sender.mock.calls
    .map((c) => c[0] as { callId?: string; invocationName?: string })
    .filter((r) => r.invocationName === 'shell_exec');
}

async function sendViaFetch(fetchMock: ReturnType<typeof vi.fn>, prompt: string): Promise<void> {
  fetchMock.mockResolvedValue(makeStreamResponse(toChunks(SEGMENT, 9)));
  await (globalThis as unknown as { fetch: typeof fetch }).fetch(CHAT_URL, {
    method: 'POST',
    body: JSON.stringify({ prompt, chat_session_id: 'r8o-dual' }),
  });
  await new Promise((r) => setTimeout(r, 120));
}

function sendViaXhr(FakeXHR: ReturnType<typeof makeFakeXhrClass>): void {
  const xhr = new FakeXHR();
  xhr.open('POST', CHAT_URL);
  xhr.setRequestHeader('Authorization', 'Bearer test');
  xhr.onreadystatechange = () => {};
  xhr.send(JSON.stringify({ prompt: '执行一下', chat_session_id: 'r8o-dual' }));
  xhr.respond(200, SEGMENT);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QD-R8o · 单通道基准（计数尺不糊）', () => {
  it('CONTROL-E：fetch 单通道投一段工具标签 → 宿主 1 次', async () => {
    const { handle, sender, fetchMock } = installHarness();
    try {
      await sendViaFetch(fetchMock, '执行一下');
      const calls = shellCalls(sender);
      console.log(`[CONTROL-E] fetch 单通道 shell_exec 投递=${calls.length} 条 id=${calls.map((c) => c.callId).join(',')}`);
      expect(calls).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it('CONTROL-F：XHR 单通道投同一段 → 宿主 1 次（证明该通道确实解析）', async () => {
    const { handle, sender, FakeXHR } = installHarness();
    try {
      sendViaXhr(FakeXHR);
      await new Promise((r) => setTimeout(r, 60));
      const calls = shellCalls(sender);
      console.log(`[CONTROL-F] XHR 单通道 shell_exec 投递=${calls.length} 条 id=${calls.map((c) => c.callId).join(',')}`);
      expect(calls).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });
});

describe('QD-R8o · 双通道同段字节的幂等门', () => {
  it('REPRO-E：同一段字节 fetch 与 XHR 各投一次 → 应有行为＝宿主只真跑 1 次', async () => {
    const { handle, sender, fetchMock, FakeXHR } = installHarness();
    try {
      sendViaXhr(FakeXHR);
      await sendViaFetch(fetchMock, '执行一下');
      await new Promise((r) => setTimeout(r, 60));
      const calls = shellCalls(sender);
      const ids = calls.map((c) => c.callId ?? '');
      console.log(
        `[REPRO-E] 双通道 shell_exec 投递=${calls.length} 条 id相同=${ids.length === 2 ? ids[0] === ids[1] : 'n/a'} `
        + `ids=${ids.join(',')} sseTextLen=${sseText('x').length}`,
      );
      expect(calls).toHaveLength(1);
      expect(new Set(ids).size).toBe(1);
    } finally {
      handle.stop();
    }
  });
});
