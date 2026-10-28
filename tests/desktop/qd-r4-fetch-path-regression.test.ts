import { describe, expect, it, vi, afterEach } from 'vitest';
import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

// @vitest-environment jsdom

/**
 * QD-R4-02 / QD-R4-06 的 fetch 路径回归。
 *
 * R4-02：fetch 路径 flush 了 parser 但只取 `fin.calls`，残留 tail 被丢弃，
 *         半截工具标签静默消失。
 * R4-06：读流中途抛错时 `controller.error(err); return;` 直接返回，
 *         streamActive 永远停在 true、onStreamEnd 不执行 → 工具循环卡死且 UI 无收尾。
 *
 * 审计报告把 R4-06 标为「Not Verified（条件触发）」——未确认 DeepSeek 页面走 fetch
 * 还是 XHR。这里的用例固定走 fetch 路径，只证明「一旦走 fetch，缺陷成立且已修」。
 */

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

/** DeepSeek 的真实完成哨兵（实测 20 份抓包里没有 `data: [DONE]`）。 */
const DONE = 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
  + 'event: close\ndata: {"click_behavior":"none"}\n\n';

/** 单字符增量形态的 SSE 帧。 */
function sseText(text: string): string {
  return `data: ${JSON.stringify({ v: text })}\n\n`;
}

/** 故意切在标签中间：有完整开标签、JSON body 未闭合、没有 </shell_exec>。 */
function sseTailCut(): string {
  return sseText('<shell_exec>{"command":"echo one"');
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

/** 把响应切成任意大小的分片，模拟真实网络字节边界。 */
function toChunks(text: string, size: number): Uint8Array[] {
  const enc = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < enc.length; i += size) out.push(enc.slice(i, i + size));
  return out;
}

function makeStreamResponse(chunks: Uint8Array[], opts: { failMidway?: boolean } = {}) {
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
            if (opts.failMidway && i === chunks.length - 1) {
              throw new Error('network reset mid-stream');
            }
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
  } as unknown as Response;
}

function installHarness() {
  // installMainWorldInterceptor 在安装时捕获 window.fetch 作为 origFetch，
  // 所以必须在 install 之前把 fetch 换成桩，否则 hook 到的是 jsdom 原生实现。
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // 提示词注入会额外触发 mcp.list / skill.list 两次探测调用，断言工具执行次数时
  // 必须按 invocationName 过滤，不能直接数 sender.mock.calls.length。
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'mcp.list') {
      return { ok: true, data: { tools: [{ serverId: 's', name: 'n', description: 'd' }] } };
    }
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
  });
  const chatUI = makeChatUI();
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: () => {},
  });
  return { handle, sender, chatUI, fetchMock };
}

/** 只统计真正的工具执行（排除提示词注入的 mcp.list / skill.list 探测）。 */
function toolExecs(sender: ReturnType<typeof vi.fn>, name = 'shell_exec') {
  return sender.mock.calls.filter((c) => c[0].invocationName === name);
}

async function sendViaFetch(fetchMock: ReturnType<typeof vi.fn>, session: string, prompt: string, response: Response) {
  fetchMock.mockResolvedValue(response);
  await (globalThis as { fetch: typeof fetch }).fetch(CHAT_URL, {
    method: 'POST',
    body: JSON.stringify({ prompt, chat_session_id: session }),
  });
  // 让 ReadableStream 的 start() 跑完（真实场景由页面消费驱动，这里直接等微任务队列）。
  await new Promise((r) => setTimeout(r, 30));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QD-R4-02 fetch 路径：截断的工具标签不再静默消失', () => {
  it('流在工具标签中间结束时报 tool-call-truncated，且不当成正常完成', async () => {
    const { handle, sender, chatUI, fetchMock } = installHarness();
    try {
      await sendViaFetch(fetchMock, 'f-trunc', 'write a file',
        makeStreamResponse(toChunks(sseText('我先执行。') + sseTailCut(), 7)));

      expect(toolExecs(sender)).toHaveLength(0);
      expect(chatUI.appendError.mock.calls[0]?.[0]).toBe('tool-call-truncated');
      expect(chatUI.setBusy).toHaveBeenCalledWith(false);
    } finally {
      handle.stop();
    }
  });

  it('完整流（带完成哨兵）不报错', async () => {
    const { handle, chatUI, fetchMock } = installHarness();
    try {
      await sendViaFetch(fetchMock, 'f-ok', 'hello',
        makeStreamResponse(toChunks(
          sseText('你好') + sseText('<shell_exec>{"command":"echo hi"}</shell_exec>') + DONE,
          9,
        )));

      expect(chatUI.appendError.mock.calls).toEqual([]);
    } finally {
      handle.stop();
    }
  });
});

describe('QD-R4-06 fetch 路径：读流中途抛错不再卡死', () => {
  it('UI 收尾并给出可见错误（修复前 streamActive 永为 true、无任何反馈）', async () => {
    const { handle, chatUI, fetchMock } = installHarness();
    try {
      await sendViaFetch(fetchMock, 'f-err', 'long task',
        makeStreamResponse(
          toChunks(sseText('<shell_exec>{"command":"echo one"}</shell_exec>') + DONE, 5),
          { failMidway: true },
        ));

      expect(chatUI.appendError.mock.calls[0]?.[0]).toBe('stream-error');
      expect(chatUI.setBusy).toHaveBeenCalledWith(false);
      expect(chatUI.finishAssistantMessage).toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });
});
