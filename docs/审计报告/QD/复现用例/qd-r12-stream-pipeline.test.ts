// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installMainWorldInterceptor, interceptorTraceSnapshot } from '../../src/inject/main-world-interceptor';

/**
 * QD-R12 复现件：流式管线状态与「代码块边界」。
 *
 * 断言全部按「期望行为」写：
 *   - 控制腿必须通过（证明夹具与主链是通的）；
 *   - 复现腿失败 = 缺陷成立。
 *
 * 面：盘面 src/inject/main-world-interceptor.ts sha1 a13385f5（mtime 2026-10-23 01:56:27）。
 * 首次跑在 983d203f（01:47:52）上：该快照是重构中途态，流结束处 settleStreamEnd 引用未定义
 * 的 d，loopDepth/推理尾段两条腿因此被异常截断；重跑改用 a13385f5 后四腿齐红。
 * PoW 被部分 mock 成抛错，只为让 auto-continue 在打印 `loop=N` 后立刻收尾，不触网。
 */

vi.mock('../../src/inject/pow', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/inject/pow')>();
  return {
    ...real,
    createPowHeaders: vi.fn(async () => {
      throw new Error('pow-stub-for-r12');
    }),
  };
});

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

/** DeepSeek 的真实完成哨兵（页面不发 data: [DONE]）。 */
const DONE =
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
  + 'event: close\ndata: {"click_behavior":"none"}\n\n';

/** 单字符增量形态的 SSE 帧。 */
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

function toolExecs(sender: ReturnType<typeof vi.fn>, name: string) {
  return sender.mock.calls.filter((c) => (c[0] as { invocationName?: string }).invocationName === name);
}

function visibleText(chatUI: ReturnType<typeof makeChatUI>): string {
  return chatUI.appendToAssistantMessage.mock.calls
    .map((c) => String(c[0]))
    .join('');
}

async function sendViaFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  prompt: string,
  response: Response,
): Promise<void> {
  fetchMock.mockResolvedValue(response);
  await (globalThis as unknown as { fetch: typeof fetch }).fetch(CHAT_URL, {
    method: 'POST',
    body: JSON.stringify({ prompt, chat_session_id: 'r12' }),
  });
  // 让 ReadableStream 的 start() 与 forward 的 then 链跑完。
  await new Promise((r) => setTimeout(r, 80));
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QD-R12 控制腿：流式链路本身可通', () => {
  it('CONTROL 散文里的工具标签照常执行一次', async () => {
    const { handle, sender, fetchMock } = installHarness();
    try {
      await sendViaFetch(
        fetchMock,
        '执行一下',
        makeStreamResponse(toChunks(
          sseText('我来执行：') + sseText('<shell_exec>{"command":"echo plain"}</shell_exec>') + DONE,
          9,
        )),
      );
      expect(toolExecs(sender, 'shell_exec')).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it('CONTROL HTML 转义后的标签不执行', async () => {
    const { handle, sender, fetchMock } = installHarness();
    try {
      await sendViaFetch(
        fetchMock,
        '给我看示例',
        makeStreamResponse(toChunks(
          sseText('写法是 &lt;shell_exec&gt;{"command":"echo escaped"}&lt;/shell_exec&gt;') + DONE,
          7,
        )),
      );
      expect(toolExecs(sender, 'shell_exec')).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });
});

describe('QD-R12-01 代码块/行内代码里的工具标签被当真执行', () => {
  it('REPRO Markdown 围栏代码块里的示例标签不应执行，且应留在可见文本里', async () => {
    const { handle, sender, chatUI, fetchMock } = installHarness();
    try {
      const reply = '示例（仅展示，不要执行）：\n'
        + '```bash\n'
        + '<shell_exec>{"command":"echo fenced"}</shell_exec>\n'
        + '```\n'
        + '上面就是调用格式。';
      await sendViaFetch(fetchMock, '给我一个调用示例', makeStreamResponse(toChunks(sseText(reply) + DONE, 13)));

      expect.soft(toolExecs(sender, 'shell_exec'), '围栏代码块里的示例被真实执行').toHaveLength(0);
      expect.soft(visibleText(chatUI), '围栏内容被从可见文本里剥掉，代码块变空').toContain('</shell_exec>');
    } finally {
      handle.stop();
    }
  });

  it('REPRO 行内反引号里的示例标签不应执行', async () => {
    const { handle, sender, chatUI, fetchMock } = installHarness();
    try {
      const reply = '你可以在正文里写 `<local_file_read>{"path":"package.json"}</local_file_read>` 来读取文件。';
      await sendViaFetch(fetchMock, '这个工具怎么用？', makeStreamResponse(toChunks(sseText(reply) + DONE, 11)));

      expect.soft(toolExecs(sender, 'local_file_read'), '行内代码里的示例触发了真实文件读取').toHaveLength(0);
      expect.soft(visibleText(chatUI), '行内代码内容被剥掉').toContain('</local_file_read>');
    } finally {
      handle.stop();
    }
  });
});

describe('QD-R12-02 auto-continue 的 loopDepth 双计数', () => {
  it('REPRO 第一次续跑应记为 loop=1（实际 2：每轮 +2，25 步预算只剩约 12 轮）', async () => {
    const { handle, sender, fetchMock, diags } = installHarness();
    try {
      await sendViaFetch(
        fetchMock,
        '执行一下',
        makeStreamResponse(toChunks(
          sseText('<shell_exec>{"command":"echo step"}</shell_exec>') + DONE,
          9,
        )),
      );
      expect(toolExecs(sender, 'shell_exec')).toHaveLength(1);

      // 工具结果回来 → onStreamEnd 排 1s 续跑定时器 → autoContinueWithPow 打印 loop=N。
      await waitFor(() => diags.some((d) => d.includes('computing PoW')));
      const first = diags.find((d) => d.includes('computing PoW')) ?? '';
      const m = first.match(/auto-continue loop=(\d+)/);
      expect(m, `未捕获续跑诊断；trace=${JSON.stringify(interceptorTraceSnapshot().slice(-6))}`).not.toBeNull();
      expect(Number(m![1]), `首次续跑 loopDepth 应为 1，实际 ${m![1]}`).toBe(1);
    } finally {
      handle.stop();
    }
  });
});

describe('QD-R12-03 fetch 路径推理尾段只进步骤笔记、不进聊天 think 块', () => {
  it('REPRO 流末尾未换行的 THINK 片段应出现在 appendReasoning 里', async () => {
    const { handle, chatUI, fetchMock } = installHarness();
    try {
      // 完成哨兵先到，最后一个 THINK 事件没有结尾换行 → 只能由 sse.flush() 解析。
      const stream = sseText('答案正文') + DONE
        + 'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"尾推理"}]}}}';
      await sendViaFetch(fetchMock, '想一想', makeStreamResponse(toChunks(stream, 17)));

      const reasonings = chatUI.appendReasoning.mock.calls.map((c) => String(c[0])).join('\n');
      expect(reasonings, 'fetch 路径的 flush 推理尾段没有推给聊天 think 块').toContain('尾推理');
    } finally {
      handle.stop();
    }
  });
});
