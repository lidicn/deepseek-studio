/**
 * 薄 MAIN-world 拦截控制器（v0.6，自包容）
 *
 * 在页面 main world（document_start）挂上 fetch/XHR 拦截：
 *   - 响应侧：流式响应里出现 `<shell_exec>` / `<local_file_read>` 等工具调用标签时，
 *     解析出调用并经宿主 ws 客户端投递给常驻宿主真实执行（复用 v0.5 授权链 + 同意闸门），
 *     同时把可见 XML 标签从流中剥离，避免用户看到原始标签。
 *   - 请求侧：模型拿到工具结果后，下一次对话请求把执行结果回填进 prompt，形成
 *     「模型发起 → 宿主执行 → 结果回注」闭环。
 *
 * 解析核心为 src/inject/streaming-tool-parser.ts（上游算法等价移植，无浏览器扩展耦合）。
 */

import { StreamingToolCallParser, type ParsedToolCall } from './streaming-tool-parser';
import { SseTextStreamExtractor } from './sse-text-extractor';
import { isSupportedUpstreamTool, SUPPORTED_INVOCATION_NAMES } from '../shared/tool-contract';
import type { ExecuteResult } from '../capabilities/types';

/** 页端 → 宿主 的工具调用投递请求（与 host-client.sendToolCall 入参同构）。 */
export interface ToolCallRequest {
  readonly callId: string;
  readonly invocationName: string;
  readonly params: Record<string, unknown>;
}

/** 投递回调：把一次工具调用发给宿主并等回结果（由 entry.ts 接到 host-client）。 */
export type ToolCallSender = (req: ToolCallRequest) => Promise<ExecuteResult>;

export interface MainWorldInterceptorHandle {
  stop(): void;
}

interface PendingResult {
  invocationName: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 诊断回调（临时）：把 hook 拦到的对话请求信息上报宿主日志。 */
export type InterceptorDiag = (message: string) => void;

/** 自动工具循环的跨 hook 共享状态（fetch / XHR 两条路径共用同一实例）。 */
interface LoopState {
  /** 最近一次 chat 请求 body，作为自动续跑模板。 */
  lastChatBody: string | null;
  /** 当前响应流是否仍在进行（用于判断工具结果回填时机）。 */
  streamActive: boolean;
  /** 最近一次响应的 response_message_id。 */
  lastResponseMsgId: number | null;
}

function formatToolResultBlock(results: readonly PendingResult[]): string {
  const lines = results.map((p) => {
    const head = `[tool-result:${p.invocationName}]`;
    if (!p.ok) return `${head}\n<error>${p.error ?? 'unknown'}</error>`;
    const data = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? null);
    return `${head}\n${data}`;
  });
  return `【工具执行结果】\n${lines.join('\n\n')}`;
}

/** 把待回填的工具结果拼进下一次请求的 prompt。纯函数，便于单测。 */
export function reinjectIntoPrompt(prompt: string, results: readonly PendingResult[]): string {
  if (results.length === 0) return prompt;
  return `${prompt}\n\n${formatToolResultBlock(results)}`;
}

function isDeepSeekChatEndpoint(url: string, method: string): boolean {
  try {
    const base = globalThis.location?.href;
    const u = base ? new URL(url, base) : new URL(url);
    return u.hostname.endsWith('deepseek.com')
      && method.toUpperCase() === 'POST'
      && u.pathname === '/api/v0/chat/completion';
  } catch {
    return false;
  }
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit | undefined): string {
  if (init?.method) return String(init.method);
  if (typeof input !== 'string' && !(input instanceof URL) && input.method) return input.method;
  return 'GET';
}

/**
 * 工具能力说明（注入到对话，使网页模型「工具感知」）。
 * 仅当用户消息涉及文件/命令时才注入，避免污染普通闲聊。
 */
const TOOL_CAPABILITY_MARKER = '[studio-tool-capability]';
const TOOL_CAPABILITY_PROMPT = `${TOOL_CAPABILITY_MARKER}
你是 DeepSeek Studio 的本地工具代理。当用户要求读取、写入、列出文件或执行命令时，通过输出直接 XML 标签来调用工具，标签体内必须是合法 JSON：

<local_file_read>{"path":"/绝对路径/文件.txt"}</local_file_read>
<local_file_write>{"path":"/绝对路径/文件.txt","content":"要写入的文本"}</local_file_write>
<local_file_stat>{"path":"/绝对路径"}</local_file_stat>
<shell_exec>{"command":"要执行的命令行"}</shell_exec>

规则：标签名必须是上面列出的工具名之一；JSON body 必须是合法 JSON（字符串用双引号，Windows 路径用正斜杠如 C:/Users/...）；工具调用放在最终回答正文里（不要放在思考/推理区域）。
禁止：使用 <invoke name="...">、<tool_call> 等包装标签；把工具调用写在 Markdown 代码块里；输出 {"tool":"...","arguments":{...}} 这种 JSON 格式；或者声称自己无法调用这些工具。
系统会真实执行并把结果返回给你，据此继续。不要臆造路径，不要编造工具结果。`;

function hasToolIntent(text: string): boolean {
  if (!text) return false;
  // 「Studio Agent」是 AgentLoop 发消息的固定哨兵前缀（面板消息与续跑/纠偏指令都带），
  // 必须无条件触发工具能力注入；「工作区」覆盖面板场景里的常规说法。
  return /(Studio Agent|工作区|智能体|读|写|读取|写入|查看|列出|打开|文件|目录|文件夹|执行|运行|命令|路径|file|read|write|list|cat|ls|dir|command|shell|run|execute|path)/i.test(text);
}

function computeIntent(parsed: Record<string, unknown>): boolean {
  if (typeof parsed.prompt === 'string') return hasToolIntent(parsed.prompt);
  if (Array.isArray(parsed.messages)) {
    for (let i = parsed.messages.length - 1; i >= 0; i--) {
      const m = parsed.messages[i] as { role?: string; content?: unknown };
      if (m.role === 'user' && typeof m.content === 'string') return hasToolIntent(m.content);
    }
  }
  return false;
}

function injectInstructionIntoMessages(messages: unknown[]): unknown[] {
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (first && first.role === 'system' && typeof first.content === 'string' && first.content.includes(TOOL_CAPABILITY_MARKER)) {
    return messages;
  }
  return [{ role: 'system', content: TOOL_CAPABILITY_PROMPT }, ...messages];
}

function appendResultsToMessages(messages: unknown[], block: string): unknown[] {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string };
    if (m.role === 'user') { idx = i; break; }
  }
  if (idx < 0) {
    messages.push({ role: 'user', content: block });
  } else {
    const m = messages[idx] as { role: 'user'; content?: unknown };
    m.content = (typeof m.content === 'string' ? m.content : '') + '\n\n' + block;
  }
  return messages;
}

/**
 * 准备发出的请求体：按需注入工具能力说明 + 回填上一轮工具结果。
 * 同时兼容 DeepSeek 的 `messages` 数组与 `prompt` 字符串两种形态。
 * 返回新的 JSON 字符串；无改动返回 null。
 */
function prepareOutgoingBody(rawBody: string, pending: PendingResult[]): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }
  const intent = computeIntent(parsed);
  const hasResults = pending.length > 0;
  if (!intent && !hasResults) return null;
  const block = hasResults ? formatToolResultBlock(pending.slice()) : '';
  if (Array.isArray(parsed.messages)) {
    let msgs: unknown[] = parsed.messages as unknown[];
    if (intent) msgs = injectInstructionIntoMessages(msgs);
    if (hasResults) msgs = appendResultsToMessages(msgs, block);
    parsed.messages = msgs;
  } else if (typeof parsed.prompt === 'string') {
    let prompt: string = parsed.prompt;
    if (intent && !prompt.includes(TOOL_CAPABILITY_MARKER)) {
      prompt = `${TOOL_CAPABILITY_PROMPT}\n\n${prompt}`;
    }
    if (hasResults) prompt = reinjectIntoPrompt(prompt, pending.slice());
    parsed.prompt = prompt;
  } else {
    return null;
  }
  pending.length = 0;
  return JSON.stringify(parsed);
}

function augmentInit(init: RequestInit | undefined, pending: PendingResult[]): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init;
  const newBody = prepareOutgoingBody(init.body, pending);
  if (newBody === null) return init;
  return { ...init, body: newBody };
}

function installFetchHook(
  origFetch: typeof window.fetch,
  forward: (call: ParsedToolCall) => void,
  pending: PendingResult[],
  diag: InterceptorDiag = () => {},
  loopState?: LoopState,
): () => void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input);
    const method = methodOf(input, init);
    diag(`fetch ${method} ${url} bodyType=${typeof init?.body}`);

    // 请求侧回填：把累积的工具结果写进下一次对话请求的 prompt
    if (pending.length > 0 && isDeepSeekChatEndpoint(url, method)) {
      init = augmentInit(init, pending);
    }

    // 非对话响应不拦截（直接放行，避免影响其它请求）
    if (!isDeepSeekChatEndpoint(url, method)) {
      return origFetch(input, init);
    }

    diag(`chat-endpoint matched, bodyLen=${typeof init?.body === 'string' ? init.body.length : 'n/a'}`);
    if (loopState) { loopState.streamActive = true; if (typeof init?.body === 'string') loopState.lastChatBody = init.body; }
    const response = await origFetch(input, init);
    if (!response.body) return response;

    const parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
    const sse = new SseTextStreamExtractor();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // v0.7：先把原始 SSE 提取成可见纯文本（跨 chunk 不丢事件），再解析工具标签
            const rawSse = decoder.decode(value, { stream: true });
            const text = sse.feed(rawSse);
            const { calls, clean } = parser.feed(text);
            for (const c of calls) forward(c);
            if (clean) controller.enqueue(encoder.encode(clean));
          }
          // 流结束：先刷出 SSE 缓冲区最后一个事件，再刷工具解析器尾部
          const sseTail = sse.flush();
          if (sseTail) {
            const tailParsed = parser.feed(sseTail);
            for (const c of tailParsed.calls) forward(c);
            if (tailParsed.clean) controller.enqueue(encoder.encode(tailParsed.clean));
          }
          const fin = parser.flush();
          for (const c of fin.calls) forward(c);
          if (fin.clean) controller.enqueue(encoder.encode(fin.clean));
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
        if (loopState) loopState.streamActive = false;
      },
    });
    return new Response(stream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
  return () => {
    window.fetch = origFetch;
  };
}

/**
 * 从 DeepSeek SSE 流的增量 chunk 里提取可见文本。
 * 响应格式是逐 token 的 data: {"v":"<char>"} delta；直接喂 parser 找不到标签，
 * 必须先把 v 字段拼成纯文本流。
 *
 * v0.7：提取逻辑迁移到 sse-text-extractor.ts 的有状态 SseTextStreamExtractor，
 * 修复 fragment APPEND 事件（携带工具标签首字符 `<`）跨网络分片被整段丢弃的 bug。
 * fetch/XHR 两条路径都必须持有各自的 SseTextStreamExtractor 实例逐 chunk 喂入。
 */

function installXhrHooks(
  forward: (call: ParsedToolCall) => void,
  pending: PendingResult[],
  diag: InterceptorDiag = () => {},
  loopState?: LoopState,
): () => void {
  if (typeof XMLHttpRequest === 'undefined') return () => {};
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;

  proto.open = function (this: XMLHttpRequest & Record<string, unknown>, method: string, url: string | URL, ...rest: unknown[]) {
    this.__dsMethod = method;
    this.__dsUrl = String(url);
    return (origOpen as (...a: unknown[]) => unknown).apply(this, [method, url, ...rest]);
  } as typeof proto.open;

  proto.send = function (this: XMLHttpRequest & Record<string, unknown>, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = String(this.__dsUrl ?? '');
    const method = String(this.__dsMethod ?? 'GET');
    const isChat = isDeepSeekChatEndpoint(url, method);
    diag(`xhr ${method} ${url} isChat=${isChat} bodyType=${typeof body}`);
    // 请求侧：无论 pending 是否为空，命中对话端点就尝试注入工具提示/回填结果。
    if (isChat && typeof body === 'string') {
      diag(`xhr chat body len=${body.length} head=${body.slice(0, 200)}`);
      const next = prepareOutgoingBody(body, pending);
      if (next !== null) {
        body = next;
        diag(`xhr chat body injected len=${next.length}`);
      }
      // v0.8：记住最近一次 chat 请求 body 作为自动续跑模板。
      if (loopState) { loopState.lastChatBody = body; loopState.streamActive = true; }
    }
    const xhr = this;
    (xhr as Record<string, unknown>).__dsIsChat = isChat;
    const prev = xhr.onreadystatechange;
    xhr.onreadystatechange = (...args: unknown[]) => {
      if (xhr.readyState === 4 && loopState) {
        loopState.streamActive = false;
      }
      if (xhr.readyState >= 3) {
        const text = xhr.responseText;
        const scanned = (xhr.__dsScanned ?? 0) as number;
        const part = text.slice(scanned);
        xhr.__dsScanned = text.length;
        if (part && (xhr as Record<string, unknown>).__dsIsChat) {
          diag(`xhr resp[${part.length}]: ${part.slice(0, 400).replace(/\s+/g, ' ')}`);
          // 提取 response_message_id（event: ready data: {"request_message_id":1,"response_message_id":2}）
          const m = part.match(/"response_message_id"\s*:\s*(\d+)/);
          if (m && loopState) loopState.lastResponseMsgId = parseInt(m[1], 10);
        }
        if (part) {
          // v0.7：每个 XHR 持有有状态 SSE 提取器，跨 readystatechange 保留不完整行，
          // 避免携带工具标签首字符 `<` 的 fragment APPEND 事件被字节边界切开后整段丢失。
          let sse = xhr.__dsSse as SseTextStreamExtractor | undefined;
          let parser = xhr.__dsParser as StreamingToolCallParser | undefined;
          if (!sse || !parser) {
            sse = new SseTextStreamExtractor();
            parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
            xhr.__dsSse = sse;
            xhr.__dsParser = parser;
          }
          let visible = sse.feed(part);
          // readyState===4：流结束，刷出 SSE 缓冲区里最后一个不带换行的残留事件
          if (xhr.readyState === 4) visible += sse.flush();
          if (visible) {
            diag(`xhr extracted[${visible.length}]: ${visible.slice(0, 300).replace(/\s+/g, ' ')}`);
            const { calls } = parser.feed(visible);
            for (const c of calls) forward(c);
          }
        }
      }
      if (typeof prev === 'function') (prev as (...a: unknown[]) => unknown).apply(xhr, args);
    };
    return (origSend as (...a: unknown[]) => unknown).call(this, body);
  } as typeof proto.send;

  return () => {
    proto.open = origOpen;
    proto.send = origSend;
  };
}

/**
 * 挂载薄 MAIN-world 拦截器。
 * @param sender 把工具调用投递给宿主并取回结果的回调（由 entry.ts 接到 host-client）。
 */
export function installMainWorldInterceptor(sender: ToolCallSender, diag?: InterceptorDiag): MainWorldInterceptorHandle {
  const pending: PendingResult[] = [];
  const d: InterceptorDiag = diag ?? (() => {});
  // v0.8：自动工具循环——记住最近一次 chat 请求的 body 模板 + 当前流是否结束。
  const loopState = { lastChatBody: null as string | null, streamActive: false, lastResponseMsgId: null as number | null };
  let autoContinueTimer: ReturnType<typeof setTimeout> | null = null;
  let loopDepth = 0;
  const MAX_LOOP = 8;

  const forward = (call: ParsedToolCall): void => {
    d(`forward: ${call.invocationName} params=${JSON.stringify(call.params).slice(0, 200)}`);
    if (!isSupportedUpstreamTool(call.invocationName)) {
      d(`forward: unsupported, skipping`);
      return;
    }
    const callId = call.id || crypto.randomUUID();
    void sender({ callId, invocationName: call.invocationName, params: call.params })
      .then((r: ExecuteResult) => {
        d(`forward: done ok=${r.ok} err=${r.error ?? ''}`);
        pending.push({ invocationName: call.invocationName, ok: r.ok, result: r.data, error: r.error });
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      })
      .catch((e: unknown) => {
        d(`forward: failed ${e instanceof Error ? e.message : String(e)}`);
        pending.push({ invocationName: call.invocationName, ok: false, error: e instanceof Error ? e.message : String(e) });
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      });
  };

  function scheduleAutoContinue(): void {
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
    autoContinueTimer = setTimeout(() => {
      autoContinueTimer = null;
      fillInputWithToolResults();
    }, 1000);
  }

  function fillInputWithToolResults(): void {
    if (pending.length === 0) return;
    const toolResults = pending.map((p) => {
      const result = p.ok ? JSON.stringify(p.result, null, 2) : `ERROR: ${p.error}`;
      return `## ${p.invocationName}\n${result}`;
    }).join('\n\n');
    const text = `[TOOL_RESULTS]\n${toolResults}\n[/TOOL_RESULTS]\n\n请根据上述工具执行结果继续回答。`;

    // 找 DeepSeek 输入框（contenteditable div 或 textarea）
    const input = document.querySelector('div[role="textbox"]') as HTMLElement | null
      ?? document.querySelector('textarea') as HTMLElement | null
      ?? document.querySelector('div[contenteditable="true"]') as HTMLElement | null;
    if (!input) {
      d('fillInput: no textbox found');
      return;
    }

    // 用 execCommand 插入文本，让 React 感知
    input.focus();
    // 清空现有内容
    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand('delete');
    // 插入新文本
    document.execCommand('insertText', false, text);

    d(`fillInput: inserted ${text.length} chars`);

    // 自动点发送按钮
    setTimeout(() => {
      const sendBtn =
        document.querySelector('button[aria-label="发送"]')
        ?? document.querySelector('button[type="submit"]')
        ?? document.querySelector('div[role="textbox"]')?.closest('form')?.querySelector('button')
        ?? document.querySelector('textarea')?.closest('form')?.querySelector('button')
        ?? Array.from(document.querySelectorAll('button')).find(b => {
          const label = b.getAttribute('aria-label') || b.textContent || '';
          return label.includes('发送') || label.includes('send') || label.includes('Send');
        });
      if (sendBtn) {
        (sendBtn as HTMLButtonElement).click();
        d('fillInput: clicked send');
      } else {
        input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        d('fillInput: pressed Enter');
      }
    }, 500);
  }

  const origFetch = window.fetch ? window.fetch.bind(window) : undefined;
  const stopFetch = origFetch ? installFetchHook(origFetch, forward, pending, d, loopState) : undefined;
  const stopXhr = installXhrHooks(forward, pending, d, loopState);

  return {
    stop() {
      try {
        stopFetch?.();
      } catch {
        /* ignore */
      }
      try {
        stopXhr?.();
      } catch {
        /* ignore */
      }
    },
  };
}
