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
    return u.hostname.endsWith('chat.deepseek.com') && method.toUpperCase() === 'POST';
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
你是 DeepSeek Studio 的本地工具代理。当用户明确要求读取、写入、列出文件或执行命令时，用下面的 XML 标签发起一次工具调用（标签体必须是严格 JSON，键用双引号）：
<local_file_read>{"path":"文件的绝对路径"}</local_file_read>
<local_file_write>{"path":"绝对路径","content":"要写入的文本内容"}</local_file_write>
<local_file_stat>{"path":"绝对路径"}</local_file_stat>
<shell_exec>{"command":"要在本机执行的命令行"}</shell_exec>
仅在用户显式要求时才调用，不要臆造路径。系统会真实执行并把结果放进下一条消息，你据此继续回答，不要自行编造工具结果。`;

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
    const response = await origFetch(input, init);
    if (!response.body) return response;

    const parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const { calls, clean } = parser.feed(text);
            for (const c of calls) forward(c);
            if (clean) controller.enqueue(encoder.encode(clean));
          }
          const fin = parser.flush();
          for (const c of fin.calls) forward(c);
          if (fin.clean) controller.enqueue(encoder.encode(fin.clean));
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
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

function installXhrHooks(
  forward: (call: ParsedToolCall) => void,
  pending: PendingResult[],
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
    if (pending.length > 0 && isDeepSeekChatEndpoint(String(this.__dsUrl ?? ''), String(this.__dsMethod ?? 'GET'))) {
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          if (typeof parsed.prompt === 'string') {
            parsed.prompt = reinjectIntoPrompt(parsed.prompt, pending.slice());
            pending.length = 0;
            body = JSON.stringify(parsed);
          }
        } catch {
          /* ignore malformed body */
        }
      }
    }
    const xhr = this;
    const prev = xhr.onreadystatechange;
    xhr.onreadystatechange = function (...args: unknown[]) {
      if (xhr.readyState >= 3) {
        const text = xhr.responseText;
        const scanned = (xhr.__dsScanned ?? 0) as number;
        const part = text.slice(scanned);
        xhr.__dsScanned = text.length;
        if (part) {
          let parser = xhr.__dsParser as StreamingToolCallParser | undefined;
          if (!parser) {
            parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
            xhr.__dsParser = parser;
          }
          const { calls } = parser.feed(part);
          for (const c of calls) forward(c);
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

  const forward = (call: ParsedToolCall): void => {
    if (!isSupportedUpstreamTool(call.invocationName)) {
      // 未登记的工具：放行原始 XML 文本（不拦截），由页面正常展示。
      return;
    }
    const callId = call.id || crypto.randomUUID();
    void sender({ callId, invocationName: call.invocationName, params: call.params })
      .then((r: ExecuteResult) => {
        pending.push({ invocationName: call.invocationName, ok: r.ok, result: r.data, error: r.error });
      })
      .catch((e: unknown) => {
        pending.push({ invocationName: call.invocationName, ok: false, error: e instanceof Error ? e.message : String(e) });
      });
  };

  const origFetch = window.fetch ? window.fetch.bind(window) : undefined;
  const stopFetch = origFetch ? installFetchHook(origFetch, forward, pending, d) : undefined;
  const stopXhr = installXhrHooks(forward, pending);

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
