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
import { SseTextStreamExtractor, snapshotFragments } from './sse-text-extractor';
import { DeepSeekSseFrameDecoder } from './deepseek-sse-frame-decoder';
import { isSupportedUpstreamTool, SUPPORTED_INVOCATION_NAMES } from '../shared/tool-contract';
import { shouldSkipAutoContinue } from '../shared/tool-result-format';
import {
  buildContinuationPrompt,
  buildNudgePrompt,
  shouldNudge,
  extractTaskCompleteSignal,
  MAX_LOOP,
  MAX_NUDGES,
  type PendingResult,
} from '../shared/continuation-prompt';
import type { ExecuteResult } from '../capabilities/types';
import { createPowHeaders } from './pow';
import { createToolCard, updateToolCardByCallId, stripRawToolTagsFromMessage } from './tool-card-ui';
import { createStepFlowContainer, type StepFlowHandle } from './step-flow-ui';
import { hydrateCodeBlocks, type CodeRunner } from './render-code-runner';
import type { StudioChatUIHandle } from '../ui/studio-chat-ui';

/**
 * 从文本里剔除原始工具调用标签（<shell_exec>…</shell_exec> 等），返回纯散文。
 *
 * 与 streaming-tool-parser 的 clean 路径不同——这是无状态的字符串级正则，
 * 用于在把 autoReplyText 推给宿主前清除残留的原始标签文本。
 *
 * 真机根因：auto-continue 的 XHR 路径把 `visible`（SSE 提取的纯文本，**仍含工具标签**）
 * 累积到 loopState.autoReplyText；若直接 onAssistantReply(autoReplyText) 推给宿主，
 * 宿主的 AgentLoop 见到 content 里含 `<shell_exec>` 且 toolCalls=0 → 判定「未解析工具标签」
 * → 格式纠偏循环 → 永不 emit assistant → 聊天室收不到回复。
 * 这里在推送前剥标签，让 AgentLoop 只看到干净的散文。
 */
const RAW_TOOL_TAG_GLOBAL_RE =
  /<(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>[\s\S]*?<\/(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>/g;

function stripRawToolTags(text: string): string {
  return text.replace(RAW_TOOL_TAG_GLOBAL_RE, '');
}

/** 页端 → 宿主 的工具调用投递请求（与 host-client.sendToolCall 入参同构）。 */
export interface ToolCallRequest {
  readonly callId: string;
  readonly invocationName: string;
  readonly params: Record<string, unknown>;
}

/** 投递回调：把一次工具调用发给宿主并等回结果（由 entry.ts 接到 host-client）。 */
export type ToolCallSender = (req: ToolCallRequest) => Promise<ExecuteResult>;

export interface MainWorldInterceptorOptions {
  /** 投递回调：把一次工具调用发给宿主并等回结果（由 entry.ts 接到 host-client）。 */
  sender: ToolCallSender;
  /** 诊断日志回调。 */
  diag?: InterceptorDiag;
  /** v0.9：auto-continue 收到模型最终回复时的回调（推送给宿主）。 */
  onAssistantReply?: (text: string, loop: number) => void;
  /** v1.0：宿主推送记忆列表更新时的回调。 */
  onMemoriesUpdate?: (memories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }>) => void;
  /** v0.19：自建聊天 UI overlay。SSE 文本推送到此 UI，不再写入 DeepSeek DOM。 */
  chatUI?: StudioChatUIHandle;
}

export interface MainWorldInterceptorHandle {
  stop(): void;
}

// PendingResult 类型已提升到 src/shared/continuation-prompt.ts（单一真相源），
// 本模块 import 它，消除重复声明。

// v1.0：记忆列表缓存（由宿主推送，用于注入系统提示词的 "Existing Memories" 部分）
let currentMemories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }> = [];

// v1.0：MCP 工具列表缓存（启动时从宿主拉取，用于动态注入提示词，让 agent 知道有哪些 MCP 工具可用）
let currentMcpTools: Array<{ serverId: string; name: string; description: string }> = [];

// v1.3：步骤流 UI 句柄（分布思考状态栏 + 工具分组）
let stepFlow: StepFlowHandle | null = null;
let stepFlowStep = 0;
let stepFlowToolCount = 0;
let stepFlowStartTime = 0;
let stepReasoningAccum = '';

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
  /** v0.9：auto-continue XHR 的累积回复文本（SSE extracted）。 */
  autoReplyText: string;
  /** v0.9：当前是否在处理 auto-continue 的 XHR 响应。 */
  inAutoContinue: boolean;
  /** v1.6：本轮 auto-continue 回复里是否出现了工具调用（由 forward 在 inAutoContinue 时置位）。
   *  readyState===4 时据此判断「模型没调工具」→ 走 nudge 判定，避免 pending 异步未到位的误判。 */
  autoReplyHadTools: boolean;
  /** v1.6：用户原始任务（首轮请求 prompt 字段，augmentation 前）。XHR/fetch hook 在首条消息时写入，
   *  autoContinueWithPow / autoContinueNudge 读它拼续跑 prompt。 */
  originalTask: string;
  /** v0.19：检测到新用户消息时，把用户原始 prompt 传回给闭包（用于推送给 chat UI）。 */
  newUserPrompt?: string;
  /** v0.19：自建聊天 UI（由 installMainWorldInterceptor 传入，fetch/XHR hook 共用）。 */
  chatUI?: StudioChatUIHandle;
  /** v1.6：检测到新用户消息（parent_message_id === null）时触发，让 installMainWorldInterceptor
   *  重置 collectedExecutions/nudgeCount/loopDepth（闭包状态，hook 函数访问不到）。 */
  onNewUserMessage?: () => void;
  /** 竞态修复：流结束时回调，检查 pending 并触发续跑（由 installMainWorldInterceptor 设置） */
  onStreamEnd?: () => void;
}

function formatToolResultBlock(results: readonly PendingResult[]): string {
  const lines = results.map((p) => {
    const head = `[tool-result:${p.invocationName}]`;
    if (!p.ok) return `${head}\n<error>${p.error ?? 'unknown'}</error>`;

    // shell.exec / 类似工具：result 是包含 stdout 的对象，直接输出 stdout 文本
    // 避免 JSON.stringify 把换行符转义成字面量 \r\n
    if (p.result && typeof p.result === 'object' && 'stdout' in p.result) {
      const r = p.result as Record<string, unknown>;
      const stdout = typeof r.stdout === 'string' ? r.stdout : '';
      const stderr = typeof r.stderr === 'string' ? r.stderr : '';
      const exitCode = r.exitCode ?? '';
      const parts: string[] = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (stderr.trim()) parts.push(`<stderr>\n${stderr.trimEnd()}\n</stderr>`);
      if (exitCode !== '' && exitCode !== 0) parts.push(`<exit-code>${exitCode}</exit-code>`);
      return `${head}\n${parts.join('\n\n') || '(empty output)'}`;
    }

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
## 角色
你是 DeepSeek Studio 的本地工具代理，可以操作用户电脑上的文件、执行命令、保存长期记忆。

## 工具调用
你可以通过输出直接 XML 标签来调用工具，标签体内必须是合法 JSON：

<local_file_read>{"path":"E:/Users/name/file.txt"}</local_file_read>
<local_file_write>{"path":"E:/Users/name/file.txt","content":"要写入的文本"}</local_file_write>
<local_file_stat>{"path":"E:/Users/name"}</local_file_stat>
<shell_exec>{"command":"powershell -NoProfile -Command \"Get-ChildItem -LiteralPath 'E:/Users/name' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 10\""}</shell_exec>
<memory_save>{"type":"user","name":"用户角色","content":"前端开发者，主要使用 React 和 TypeScript","tags":["frontend","React"]}</memory_save>
<python_exec>{"code":"print('hello')"}</python_exec>

## 规则
- 标签名必须匹配可用工具；JSON body 必须是合法 JSON（字符串用双引号，不要有多余逗号或注释）
- 工具调用放在最终回答正文里，不要放在思考/推理区域，不要放在 Markdown 代码块里
- 工具标签必须独立成行，标签前后不要有任何额外文字（不要在标签后写"。不要 Markdown"之类的话）
- Windows 路径一律用正斜杠（如 E:/Users/name），不要用反斜杠，不要写四反斜杠
- 列出文件/目录优先用 PowerShell 的 Get-ChildItem，不要用 cmd 的 dir（dir 对正斜杠路径会报错）
- 一次只调用一个工具，等结果返回后再决定下一步
- **思考过程放 THINK 段，最终回答直接给结论，不要在回答开头写英文总结或"user asked... I got... Now output..."这类话**
- **全程用中文回答，除非用户明确要求其他语言**

## 禁止
- 使用 <invoke name="...">、<tool_call> 等包装标签
- 输出 {"tool":"...","arguments":{...}} 这种 JSON 格式
- 声称自己无法调用这些工具
- 在工具标签前后添加解释性文字

## 扩展能力
以下能力已启用，你可以主动使用来完成用户任务，无需先询问：
- 本地命令执行（运行 CLI 工具、脚本、文件操作）
- 本地文件读写（读取、写入、查看文件信息）
- 长期记忆（保存用户身份、偏好、技术栈、项目决策等跨会话信息）

## 记忆保存规则
当对话中出现以下情况时，你必须调用 memory_save 工具：
- 用户提到自己的身份、职业或角色
- 用户表达偏好、习惯或工作风格
- 用户纠正你的回答风格或行为
- 出现重要的技术决策或架构选择
- 用户明确说"记住"、"记一下"、"别忘了"等

## 可用工具
- local_file_read — 读取文件内容，参数：path（绝对路径，正斜杠）
- local_file_write — 写入文件，参数：path、content
- local_file_stat — 查看文件/目录信息，参数：path
- shell_exec — 执行命令行，参数：command（优先用 PowerShell，路径用正斜杠）
- memory_save — 保存长期记忆，参数：type（user/project）、name、content、tags（可选）
- python_exec — 执行 Python 代码，参数：code（Python 源代码字符串）
- mcp_list — 列出已配置的 MCP 服务器及其工具（无参数）
- mcp_call — 调用 MCP 工具，参数：serverId、tool、args（参数对象）

系统会真实执行并把结果返回给你，据此继续。不要臆造路径，不要编造工具结果。`;

/**
 * v1.6：续跑 prompt 引用的工具目录（静态文本，摘自 TOOL_CAPABILITY_PROMPT 的「## 可用工具」段）。
 * studio 工具集固定，无需 deepseek-pp 的 dynamic provider schema。
 */
const TOOL_CATALOG_TEXT = `## 可用工具
- local_file_read — 读取文件内容，参数：path（绝对路径，正斜杠）
- local_file_write — 写入文件，参数：path、content
- local_file_stat — 查看文件/目录信息，参数：path
- shell_exec — 执行命令行，参数：command（优先用 PowerShell，路径用正斜杠）
- memory_save — 保存长期记忆，参数：type（user/project）、name、content、tags（可选）
- python_exec — 执行 Python 代码，参数：code（Python 源代码字符串）
- mcp_list — 列出已配置的 MCP 服务器及其工具（无参数）
- mcp_call — 调用 MCP 工具，参数：serverId、tool、args（参数对象）

调用方式：直接输出 XML 标签，标签体内为合法 JSON，如 <shell_exec>{"command":"..."}</shell_exec>`;

// v1.7：hasToolIntent / computeIntent 已删除。之前用正则猜「要不要用工具」会漏掉
// 「审计」「bug」「代码」等关键词，导致模型不知道有工具而只聊天。修复：无条件注入
// 工具能力提示词，由模型自己判断。判重由 injectInstructionIntoMessages 的 MARKER 负责。

function formatMcpToolsBlock(): string {
  if (currentMcpTools.length === 0) return '';
  const byServer = new Map<string, Array<{ name: string; description: string }>>();
  for (const t of currentMcpTools) {
    if (!byServer.has(t.serverId)) byServer.set(t.serverId, []);
    byServer.get(t.serverId)!.push({ name: t.name, description: t.description });
  }
  const lines: string[] = ['## 已配置的 MCP 工具（可直接通过 mcp_call 调用）'];
  for (const [serverId, tools] of byServer) {
    lines.push(`### 服务器：${serverId}`);
    for (const t of tools) {
      lines.push(`- ${t.name} — ${t.description}`);
    }
  }
  lines.push('调用方式：<mcp_call>{"serverId":"服务器名","tool":"工具名","args":{...}}</mcp_call>');
  return lines.join('\n');
}

/**
 * v0.19：extractThinkingPreface 已删除——auto-continue 的 DeepSeek DOM 渲染分支已改为 chat UI。
 * 若后续 chat UI 需要"已思考"折叠卡片，可从 git 历史恢复。
 */
/* function extractThinkingPreface(reply: string): { thinking: string; answer: string } {
   -- v0.19 deleted, see comment above */

function buildCapabilityPrompt(): string {
  const mcpBlock = formatMcpToolsBlock();
  return mcpBlock ? `${TOOL_CAPABILITY_PROMPT}\n\n${mcpBlock}` : TOOL_CAPABILITY_PROMPT;
}

function injectInstructionIntoMessages(messages: unknown[]): unknown[] {
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (first && first.role === 'system' && typeof first.content === 'string' && first.content.includes(TOOL_CAPABILITY_MARKER)) {
    return messages;
  }
  return [{ role: 'system', content: buildCapabilityPrompt() }, ...messages];
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
function formatMemoriesBlock(): string {
  if (currentMemories.length === 0) return '';
  const lines = currentMemories.slice(0, 50).map((m) => {
    const scope = m.type === 'project' ? 'project ' : '';
    return `- #${m.id} [${scope}${m.type}] ${m.name}: ${m.content}`;
  });
  return `\n\n## 已有记忆\n${lines.join('\n')}`;
}

function prepareOutgoingBody(rawBody: string, pending: PendingResult[]): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }
  // v1.7：无条件注入工具能力提示词。要不要用工具由模型自己判断，前提是模型
  // 始终知道有工具可用。之前用正则猜意图（hasToolIntent）会漏掉「审计」「bug」
  // 「代码」等关键词，导致模型不知道有工具而只聊天。修复：不再猜，直接注入。
  // hasToolIntent 仅用于避免重复注入（已注入则跳过），不再用于决定「是否注入」。
  const hasResults = pending.length > 0;
  const block = hasResults ? formatToolResultBlock(pending.slice()) : '';
  const memoriesBlock = formatMemoriesBlock();
  if (Array.isArray(parsed.messages)) {
    let msgs: unknown[] = parsed.messages as unknown[];
    // 无条件注入：injectInstructionIntoMessages 内部已判重（含 MARKER 则跳过）
    msgs = injectInstructionIntoMessages(msgs);
    // 系统提示词后追加已有记忆
    if (memoriesBlock) {
      const first = msgs[0] as { role?: string; content?: unknown };
      if (first && first.role === 'system' && typeof first.content === 'string') {
        first.content = first.content + memoriesBlock;
      }
    }
    if (hasResults) msgs = appendResultsToMessages(msgs, block);
    parsed.messages = msgs;
  } else if (typeof parsed.prompt === 'string') {
    let prompt: string = parsed.prompt;
    if (!prompt.includes(TOOL_CAPABILITY_MARKER)) {
      prompt = `${buildCapabilityPrompt()}${memoriesBlock}\n\n${prompt}`;
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
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // v0.7：先把原始 SSE 提取成可见纯文本（跨 chunk 不丢事件），再解析工具标签
            const rawSse = decoder.decode(value, { stream: true });
            const text = sse.feed(rawSse);
            // v0.19：推送可见文本给自建聊天 UI（80ms 节流 + markdown 实时渲染 + 光标）
            if (loopState?.chatUI && text) loopState.chatUI.appendToAssistantMessage(text);
            // v0.18：抽取推理文本到步骤笔记 + chat UI think 块（传累积全量快照）
            const rsn = sse.consumeReasoning();
            if (rsn) {
              stepReasoningAccum += rsn;
              stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
              if (loopState?.chatUI) loopState.chatUI.appendReasoning(stepReasoningAccum);
            }
            const { calls } = parser.feed(text);
            for (const c of calls) forward(c);
            // 原样转发原始 SSE chunk，不修改内容（避免编码破坏 + SSE 解析器崩溃）
            controller.enqueue(value);
          }
          // 流结束：先刷出 SSE 缓冲区最后一个事件，再刷工具解析器尾部
          const sseTail = sse.flush();
          const rsnTail = sse.consumeReasoning();
          if (rsnTail) {
            stepReasoningAccum += rsnTail;
            stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
          }
          if (sseTail) {
            // v0.19：尾部可见文本也推送给 chat UI
            if (loopState?.chatUI) loopState.chatUI.appendToAssistantMessage(sseTail);
            const tailParsed = parser.feed(sseTail);
            for (const c of tailParsed.calls) forward(c);
            // 尾部也原样转发
          }
          const fin = parser.flush();
          for (const c of fin.calls) forward(c);
          // 尾部 flush 不发内容（原始 chunk 已转发）
        } catch (err) {
          controller.error(err);
          return;
        }
        controller.close();
        if (loopState) {
          loopState.streamActive = false;
          // 竞态修复：同 XHR 路径，工具结果先于流结束返回时通过 onStreamEnd 补触发
          if (typeof loopState.onStreamEnd === 'function') {
            try { loopState.onStreamEnd(); } catch { /* ignore */ }
          }
        }
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
  capturedHeaders?: Record<string, string>,
): () => void {
  if (typeof XMLHttpRequest === 'undefined') return () => {};
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const origSetRequestHeader = proto.setRequestHeader;

  proto.setRequestHeader = function (this: XMLHttpRequest & Record<string, unknown>, name: string, value: string) {
    const url = String(this.__dsUrl ?? '');
    if (url.includes('/api/v0/chat/') && capturedHeaders) {
      capturedHeaders[name] = value;
    }
    return (origSetRequestHeader as (...a: unknown[]) => unknown).apply(this, [name, value]);
  } as typeof proto.setRequestHeader;

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
    // 诊断：捕获页面正常发的 create_pow_challenge body
    if (url.includes('/create_pow_challenge') && typeof body === 'string') {
      diag(`xhr pow_challenge body=${body.slice(0, 500)}`);
    }
    // 请求侧：无论 pending 是否为空，命中对话端点就尝试注入工具提示/回填结果。
    if (isChat && typeof body === 'string') {
      diag(`xhr chat body len=${body.length} head=${body.slice(0, 200)}`);
      // v1.6：捕获原始任务、重置循环累积状态。
      // 判定「新用户消息」的信号：prompt 不含续跑标签（<original_task> / <tool_results>）。
      // 只靠 parent_message_id===null 不够 —— 同一会话连续发任务时它永远非 null，导致 originalTask
      // 跨任务泄漏（上个任务的上下文污染当前任务）。续跑/nudge prompt 都带这些标签，用户消息不带。
      // 必须在 prepareOutgoingBody 之前抓原始 prompt（augmentation 会改写它）。
      if (loopState) {
        try {
          const parsedBody = JSON.parse(body) as { prompt?: unknown };
          if (typeof parsedBody.prompt === 'string' && parsedBody.prompt.trim()
              && !parsedBody.prompt.includes('<original_task>')
              && !parsedBody.prompt.includes('<tool_results')
              && !parsedBody.prompt.includes('[TOOL_RESULTS]')) {
            loopState.originalTask = parsedBody.prompt;
            // v0.19：把用户原始 prompt 传回闭包，onNewUserMessage 会推送给 chat UI
            loopState.newUserPrompt = parsedBody.prompt;
            diag(`originalTask captured len=${loopState.originalTask.length}`);
            if (typeof loopState.onNewUserMessage === 'function') {
              try { loopState.onNewUserMessage(); } catch { /* ignore */ }
            }
          }
        } catch { /* not json, ignore */ }
      }
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
        // 竞态修复：工具结果可能在 XHR 结束前就返回了，
        // 此时 streamActive=true 导致 scheduleAutoContinue 未触发；
        // XHR 结束后通过 onStreamEnd 回调补查 pending。
        if (typeof loopState.onStreamEnd === 'function') {
          try { loopState.onStreamEnd(); } catch { /* ignore */ }
        }
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
          let frameDec = xhr.__dsFrameDec as DeepSeekSseFrameDecoder | undefined;
          if (!sse || !parser || !frameDec) {
            sse = new SseTextStreamExtractor();
            parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
            frameDec = new DeepSeekSseFrameDecoder();
            xhr.__dsSse = sse;
            xhr.__dsParser = parser;
            xhr.__dsFrameDec = frameDec;
          }
          // v1.5：用 frame decoder 从原始 SSE chunk 提取 data 文本（不经过显示用改写）
          const frames = frameDec.push(part);
          let rawDataText = '';
          for (const frame of frames) {
            // 从 frame.parsed 里提取原始 content（未 JSON 转义的文本）
            if (frame.parsed && typeof frame.parsed === 'object') {
              const obj = frame.parsed as {
                p?: string;
                v?: Array<{ type?: string; content?: string }> | string;
              };
              // v1.6：同时提取 fragment APPEND 的 content 数组 + 单字符 delta（v 是字符串）。
              // 单字符 delta 是 DeepSeek 逐 token 下发工具标签字符的主要形式，漏掉它会导致
              // 工具标签（<local_file_read> 等）的字符丢失，解析器收不到完整标签。
              if (Array.isArray(obj.v)) {
                for (const frag of obj.v) {
                  if (typeof frag.content === 'string') {
                    rawDataText += frag.content;
                  }
                }
              } else if (typeof obj.v === 'string') {
                // 只取 RESPONSE 内容路径的 delta（过滤 status/elapsed_secs 等控制字段、
                // 以及 THINK 段的逐字 delta —— 后者由 activeFragmentType 判断，但
                // rawDataText 是给工具解析用的原始流，THINK 段不含工具标签，可全收，
                // 因为 parser 只认工具标签名，THINK 文本不会误匹配）。
                const p = String(obj.p ?? '');
                if (!p || /^response(\/|$)/.test(p)) {
                  rawDataText += obj.v;
                }
              } else {
                // 全量 response 快照：{"v":{"response":{...,"fragments":[{type,content}]}}}。
                // 无 p 字段，既不是 string 也不是数组，旧实现三个分支全落空 → 快照里的
                // content 被静默丢弃。真机后果：模型直接以工具标签开头时，标签首字符 `<`
                // 就是这个初始 content，丢了它整条工具调用永远解析不出来（rawDataText 是
                // 喂给 StreamingToolCallParser 的唯一来源，比 visible 更关键）。
                // 快照累积重发，只取首次（frameDec 每 XHR 一个实例，用 __dsSnapSeen 记）。
                const snap = snapshotFragments(frame.parsed);
                if (snap) {
                  if (!(xhr as Record<string, unknown>).__dsSnapSeen) {
                    (xhr as Record<string, unknown>).__dsSnapSeen = true;
                    for (const f of snap) {
                      const c = (f as { content?: unknown })?.content;
                      if (typeof c === 'string') rawDataText += c;
                    }
                  }
                }
              }
            }
          }
          let visible = sse.feed(part);
          // readyState===4：流结束，刷出 SSE 缓冲区里最后一个不带换行的残留事件
          if (xhr.readyState === 4) visible += sse.flush();
          // v0.18：抽取推理文本到步骤笔记 + chat UI think 块
          const rsnX = sse.consumeReasoning();
          if (rsnX) {
            stepReasoningAccum += rsnX;
            stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
            if (loopState?.chatUI) loopState.chatUI.appendReasoning(stepReasoningAccum);
          }
          if (visible) {
            diag(`xhr extracted[${visible.length}]: ${visible.slice(0, 300).replace(/\s+/g, ' ')}`);
            // v0.9：auto-continue 的 XHR 回复不渲染到 DOM，累积到 autoReplyText
            if (loopState && loopState.inAutoContinue) {
              loopState.autoReplyText += visible;
            }
            // v0.19：推送可见文本给自建聊天 UI（原始请求和 auto-continue 两条路径都推送）
            if (loopState?.chatUI) {
              loopState.chatUI.appendToAssistantMessage(visible);
            }
            // v1.5：工具解析走原始 data 文本（不经过显示用改写），保住转义引号
            const { calls } = parser.feed(rawDataText || visible);
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
export function installMainWorldInterceptor(options: MainWorldInterceptorOptions): MainWorldInterceptorHandle {
  console.log('[interceptor] installed, fetch hook + XHR hook ready');
  const { sender, diag, onAssistantReply, onMemoriesUpdate, chatUI } = options;
  const pending: PendingResult[] = [];
  const d: InterceptorDiag = diag ?? (() => {});
  // v1.0：从全局变量读取初始记忆（entry.ts 在连接建立时设置）
  {
    const g = globalThis as { __studioMemories?: Array<{ id: string; type: string; name: string; content: string; tags: string[] }> };
    if (g.__studioMemories) currentMemories = g.__studioMemories;
  }
  // v0.8：自动工具循环——记住最近一次 chat 请求的 body 模板 + 当前流是否结束。
  const loopState: LoopState = { lastChatBody: null as string | null, streamActive: false, lastResponseMsgId: null as number | null, autoReplyText: '', inAutoContinue: false, autoReplyHadTools: false, originalTask: '', chatUI };
  let autoContinueTimer: ReturnType<typeof setTimeout> | null = null;
  let loopDepth = 0;
  // v1.6：跨整个循环累积的工具执行结果（对标 deepseek-pp collectedExecutions）。
  // pending 每轮清空（防 XHR hook 重复注入），collectedExecutions 保留到循环结束，
  // 让续跑 prompt 带完整历史，模型不会从第 2 步起忘了之前做了什么。
  // originalTask 存在 loopState.originalTask（XHR/fetch hook 要写入，在闭包外访问）。
  const collectedExecutions: PendingResult[] = [];
  // v1.6：nudge 计数（无工具断流纠偏次数上限 MAX_NUDGES）。
  let nudgeCount = 0;
  // v0.9 POW：捕获页面正常请求的 headers（Authorization / X-App-Version 等）
  const capturedHeaders: Record<string, string> = {};

  const forward = (call: ParsedToolCall): void => {
    console.log('[interceptor] forward:', call.invocationName, JSON.stringify(call.params).slice(0, 150));
    d(`forward: ${call.invocationName} params=${JSON.stringify(call.params).slice(0, 200)}`);
    if (!isSupportedUpstreamTool(call.invocationName)) {
      d(`forward: unsupported, skipping`);
      return;
    }
    const callId = call.id || crypto.randomUUID();
    const startedAt = Date.now();
    // v1.6：auto-continue 期间检测到工具调用 → 标记，readyState===4 时据此走续跑而非 nudge。
    if (loopState.inAutoContinue) loopState.autoReplyHadTools = true;

    // v0.9：在页面上创建工具调用卡片（替代原始 XML 标签展示）
    try {
      stripRawToolTagsFromMessage();
      createToolCard({ toolName: call.invocationName, params: call.params as Record<string, unknown> }, callId);
    } catch (e) {
      d(`forward: createToolCard failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // v1.3：步骤流 UI —— 第一次工具调用时创建状态栏（固定在输入框上方，不随对话滚动）
    if (!stepFlow) {
      // 清掉残留的旧状态栏
      document.querySelectorAll('.ds-sf-container').forEach((n) => n.remove());
      // v0.19：不再搜索 DeepSeek composer 选择器（obfuscated class 名太脆弱）。
      // step-flow 是 position:fixed 悬浮容器，直接挂到 body，居中底部定位。
      stepFlow = createStepFlowContainer();
      stepFlowStartTime = Date.now();
      document.body.appendChild(stepFlow.container);
      stepFlow.setPhase('running', stepFlowStep, stepFlowToolCount);
      const sf = stepFlow.container;
      sf.style.left = '50%';
      sf.style.transform = 'translateX(-50%)';
      sf.style.bottom = '210px'; // 在 DeepSeek 输入框上方（overlay 底部 200px 之上）
    }
    if (stepFlow) {
      stepFlowToolCount++;
      stepFlow.addToolEntry(stepFlowStep, call.invocationName, call.params);
      stepFlow.setPhase('running', stepFlowStep, stepFlowToolCount);
    }
    const cardData = { toolName: call.invocationName, params: call.params as Record<string, unknown> };
    // F3 修复：JSON 解析失败的工具调用，直接回填错误，不投递宿主
    if (call.params && call.params.__invalid_json) {
      d(`forward: invalid JSON for ${call.invocationName}, err=${call.params.__error}`);
      const r: PendingResult = {
        invocationName: call.invocationName,
        ok: false,
        error: `invalid-tool-json: ${call.params.__error}. Raw body: ${String(call.params.__raw ?? '').slice(0, 300)}`,
      };
      pending.push(r);
      collectedExecutions.push(r);
      try { updateToolCardByCallId(callId, cardData, { ok: false, error: `invalid-tool-json: ${call.params.__error}` }, Date.now() - startedAt); } catch { /* ignore */ }
      if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
        scheduleAutoContinue();
      }
      return;
    }
    void sender({ callId, invocationName: call.invocationName, params: call.params })
      .then((r: ExecuteResult) => {
        d(`forward: done ok=${r.ok} err=${r.error ?? ''}`);
        const pr: PendingResult = { invocationName: call.invocationName, ok: r.ok, result: r.data, error: r.error };
        pending.push(pr);
        collectedExecutions.push(pr);
        // v1.3：更新步骤流工具条目
        if (stepFlow) {
          const detail = r.error ?? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '').slice(0, 500));
          stepFlow.resolveToolEntry(stepFlowStep, r.ok, detail);
        }
        try {
          updateToolCardByCallId(
            callId,
            cardData,
            {
              ok: r.ok,
              data: r.data,
              error: r.error,
              content: r.content,
              details: r.details,
              isError: r.isError,
              terminate: r.terminate,
            },
            Date.now() - startedAt,
          );
        } catch { /* ignore */ }
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      })
      .catch((e: unknown) => {
        d(`forward: failed ${e instanceof Error ? e.message : String(e)}`);
        const pr: PendingResult = { invocationName: call.invocationName, ok: false, error: e instanceof Error ? e.message : String(e) };
        pending.push(pr);
        collectedExecutions.push(pr);
        // v1.3：更新步骤流工具条目
        if (stepFlow) {
          stepFlow.resolveToolEntry(stepFlowStep, false, e instanceof Error ? e.message : String(e));
        }
        try { updateToolCardByCallId(callId, cardData, { ok: false, error: e instanceof Error ? e.message : String(e) }, Date.now() - startedAt); } catch { /* ignore */ }
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      });
  };

  function scheduleAutoContinue(): void {
    // v1.2：terminate 闸门 —— 只有批次内所有工具结果都 terminate===true 才跳过续跑
    // 语义对齐 Pi Agent：terminate 是提示不是强制，混合批次照常续跑，空批次 fail-open
    const pendingResults = pending.map((p) => p.result as { terminate?: boolean } | undefined);
    if (shouldSkipAutoContinue(pendingResults)) {
      console.log('[autoContinue] skipped by terminate');
      return;
    }
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
    autoContinueTimer = setTimeout(() => {
      autoContinueTimer = null;
      autoContinueWithPow();
    }, 1000);
  }

  // 竞态修复：流结束时补查 pending，工具结果先于流结束返回时触发续跑
  loopState.onStreamEnd = () => {
    if (pending.length > 0 && loopState.lastChatBody && loopDepth < MAX_LOOP) {
      scheduleAutoContinue();
    } else if (stepFlow && loopDepth === 0) {
      // v1.8：只有 loopDepth===0（连第一次续跑都没进入）才说明循环真正结束。
      // 之前无此守卫，fetch+XHR 两条 SSE 路径各触发一次 onStreamEnd，
      // 第二次触发时 pending 已被 scheduleAutoContinue 清空 → 误判循环结束
      // → finish+destroy stepFlow → 下次工具结果回来又重建 → 反复创建销毁 = 闪烁。
      // loopDepth>0 时循环在进行中，stepFlow 的销毁交给 auto-continue 结束逻辑负责。
      stepFlow.finish(stepFlowStep + 1, stepFlowToolCount, Math.round((Date.now() - stepFlowStartTime) / 1000));
      const sf = stepFlow;
      stepFlow = null;
      stepFlowStep = 0;
      stepFlowToolCount = 0;
      setTimeout(() => sf.destroy(), 3000);
    }
  };

  // v1.6：新用户消息到达 → 重置循环累积状态（hook 函数在闭包外，只能经此回调通知）。
  // v0.19：同时把用户消息推送给 chat UI，并创建新的助手回复流式容器。
  loopState.onNewUserMessage = () => {
    collectedExecutions.length = 0;
    nudgeCount = 0;
    loopDepth = 0;
    loopState.autoReplyHadTools = false;
    d('new user message: reset collectedExecutions/nudgeCount/loopDepth');
    if (chatUI) {
      if (loopState.newUserPrompt) {
        chatUI.addUserMessage(loopState.newUserPrompt);
      }
      chatUI.startAssistantMessage();
      chatUI.setBusy(true);
    }
  };

  async function autoContinueWithPow(): Promise<void> {
    if (!loopState.lastChatBody || pending.length === 0 || loopDepth >= MAX_LOOP) return;
    loopDepth += 1;
    // v0.18：步骤编号随续跑递增，工具归到对应步骤
    stepFlowStep = loopDepth;
    stepReasoningAccum = '';
    loopState.streamActive = true;
    loopState.autoReplyHadTools = false;
    try {
      // v1.6：续跑 prompt 带原始任务 + 窗口化全部历史 + 工具目录（移植自 deepseek-pp
      // buildContinuationPrompt）。collectedExecutions 跨循环累积，pending 只是本轮回填缓冲。
      // 模型从此知道：用户要什么（originalTask）、之前做了什么（collectedExecutions）、还能用什么工具。
      const continuationPrompt = buildContinuationPrompt(loopState.originalTask, collectedExecutions, TOOL_CATALOG_TEXT);

      // F8 修复：清空 pending，避免 XHR hook 的 prepareOutgoingBody 再追加一份工具结果。
      // collectedExecutions 不清，续跑 prompt 要用完整历史。
      pending.length = 0;

      let bodyStr = loopState.lastChatBody;
      try {
        const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
        parsed.prompt = continuationPrompt;
        if (loopState.lastResponseMsgId != null) {
          parsed.parent_message_id = loopState.lastResponseMsgId;
        }
        bodyStr = JSON.stringify(parsed);
      } catch { /* keep original */ }

      d(`auto-continue loop=${loopDepth} computing PoW... capturedHeaders=${JSON.stringify(Object.keys(capturedHeaders))}`);

      // 过滤 capturedHeaders：移除会干扰请求的头
      // - content-type：我们自己设置 application/json
      // - content-length：fetch 自动计算
      // - x-ds-pow-response：上一次请求的 POW 响应，不能复用
      const filteredHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(capturedHeaders)) {
        const lower = k.toLowerCase();
        if (lower === 'content-type' || lower === 'content-length' || lower === 'x-ds-pow-response') continue;
        filteredHeaders[k] = v;
      }

      // 算 POW headers
      const powHeaders = await createPowHeaders(filteredHeaders);
      d(`auto-continue loop=${loopDepth} PoW done, sending...`);

      // 用 XHR 发（和页面正常请求一样），带 captured headers + POW
      // v0.9：标记 auto-continue 模式，让 XHR hook 累积回复文本（不渲染到 DOM）
      loopState.inAutoContinue = true;
      loopState.autoReplyText = '';
      await new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/v0/chat/completion', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        for (const [k, v] of Object.entries(filteredHeaders)) {
          try { xhr.setRequestHeader(k, v); } catch { /* ignore */ }
        }
        for (const [k, v] of Object.entries(powHeaders)) {
          try { xhr.setRequestHeader(k, v); } catch { /* ignore */ }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            d(`auto-continue loop=${loopDepth} status=${xhr.status} autoReplyLen=${loopState.autoReplyText.length} inAuto=${loopState.inAutoContinue}`);
            loopState.inAutoContinue = false;
            // 正常完成后必须重置 streamActive，否则后续工具结果无法触发续跑
            loopState.streamActive = false;
            // v0.9：把 auto-continue 收到的模型回复推送给宿主（不渲染到 DOM）
            const reply = loopState.autoReplyText.trim();
            const hadTools = loopState.autoReplyHadTools;
            d(`auto-continue reply len=${reply.length} hadTools=${hadTools} hasCallback=${typeof onAssistantReply}`);
            if (reply) {
              // v0.32 修复：只在「本轮无工具调用」时把回复推给宿主。
              // 有工具的回合是中间态——页端拦截器已 forward 工具 + 自动续跑，宿主此时
              // 不该拿到回复（拿到也是带 <shell_exec> 标签的半截文本）。旧实现无条件推，
              // 导致宿主 AgentLoop 抓到中间回合（toolCalls=0 + content 含原始标签）→
              // 格式纠偏循环 → 永不 emit assistant → 聊天室收不到任何回复。
              // 无工具回合 = 循环走到最终回答，这时推干净的散文（剥标签）给宿主。
              if (!hadTools) {
                const cleanReply = stripRawToolTags(reply).trim();
                if (cleanReply) {
                  try { onAssistantReply?.(cleanReply, loopDepth); } catch (e) { d(`auto-continue push failed: ${(e as Error).message}`); }
                } else {
                  d(`auto-continue reply all-tool-text (stripped to empty), skipping push`);
                }
              } else {
                d(`auto-continue turn had tools, not pushing to host (interceptor will auto-continue)`);
              }
              // v0.19：auto-continue 回复已通过 SSE 拦截推送给了 chat UI（appendToAssistantMessage）。
              // 流结束，通知 chat UI 格式化渲染。不再操作 DeepSeek DOM。
              if (chatUI) {
                try {
                  chatUI.finishAssistantMessage();
                  d(`auto-continue chat UI finished, len=${reply.length}`);
                } catch (e) {
                  d(`auto-continue chat UI finish failed: ${(e as Error).message}`);
                }
              }
            }
            if (xhr.status === 429 && loopDepth < MAX_LOOP) {
              d('auto-continue 429, retrying in 8s');
              loopState.streamActive = false;
              if (autoContinueTimer) clearTimeout(autoContinueTimer);
              autoContinueTimer = setTimeout(() => { autoContinueTimer = null; autoContinueWithPow(); }, 8000);
            } else {
              // v1.6：nudge 机制（移植自 deepseek-pp shouldNudge + buildNudgePrompt）。
              // autoReplyHadTools = forward 在本轮 SSE 里检测到工具调用 → 有工具，走 scheduleAutoContinue
              //   （由工具结果异步回调触发）。无工具且未 task_complete → 看 shouldNudge 决定是否 nudge。
              const replyForNudge = loopState.autoReplyText.trim();
              const hasTaskComplete = !!extractTaskCompleteSignal(replyForNudge);
              if (hadTools) {
                // 本轮有工具调用：续跑结果回来后 scheduleAutoContinue 接管，nudge 预算复位。
                nudgeCount = 0;
              } else if (!hasTaskComplete && replyForNudge
                  && shouldNudge(replyForNudge)
                  && nudgeCount < MAX_NUDGES && loopDepth < MAX_LOOP) {
                nudgeCount += 1;
                d(`auto-continue nudge count=${nudgeCount} loop=${loopDepth}, sending nudge...`);
                autoContinueNudge(replyForNudge);
              } else {
                // v1.8：循环真正结束（无工具、无 nudge、task_complete 或达上限）。
                // 这里负责 stepFlow 的 finish+destroy —— onStreamEnd 在 loopDepth>0 时不销毁，
                // 交给本分支。避免之前 stepFlow 反复创建销毁的闪烁。
                d(`auto-continue loop end: hadTools=${hadTools} taskComplete=${hasTaskComplete} shouldNudge=${replyForNudge ? shouldNudge(replyForNudge) : false} nudgeCount=${nudgeCount}/${MAX_NUDGES}`);
                if (stepFlow) {
                  stepFlow.finish(stepFlowStep + 1, stepFlowToolCount, Math.round((Date.now() - stepFlowStartTime) / 1000));
                  const sf = stepFlow;
                  stepFlow = null;
                  stepFlowStep = 0;
                  stepFlowToolCount = 0;
                  setTimeout(() => sf.destroy(), 3000);
                }
                // v0.19：循环结束，chat UI 切换到完成状态
                chatUI?.setBusy(false);
                // 循环结束：重置 loopDepth，让下次用户消息的 onStreamEnd 能正常销毁
                loopDepth = 0;
              }
            }
            resolve();
          }
        };
        xhr.send(bodyStr);
      });
    } catch (e) {
      d(`auto-continue failed: ${(e as Error).message}`);
      loopState.streamActive = false;
    }
  }

  /**
   * v1.6：nudge 续跑（移植自 deepseek-pp getSteeringMessages + buildNudgePrompt）。
   * 模型本轮没调工具、也没 task_complete，但 shouldNudge 判定它"该继续"时触发。
   * 复用与 autoContinueWithPow 相同的 POW + XHR 链路，只是 prompt 换成 buildNudgePrompt。
   * 与 autoContinueWithPow 的区分：nudge 是「逼模型在『再调一个工具』和『输出 task_complete』之间二选一」，
   * 正常续跑是「工具已执行完毕，基于结果继续」。
   */
  async function autoContinueNudge(previousReplyText: string): Promise<void> {
    if (!loopState.lastChatBody || loopDepth >= MAX_LOOP) return;
    loopDepth += 1;
    loopState.streamActive = true;
    loopState.autoReplyHadTools = false;
    try {
      const nudgePrompt = buildNudgePrompt(loopState.originalTask, previousReplyText, collectedExecutions, nudgeCount);

      let bodyStr = loopState.lastChatBody;
      try {
        const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
        parsed.prompt = nudgePrompt;
        if (loopState.lastResponseMsgId != null) {
          parsed.parent_message_id = loopState.lastResponseMsgId;
        }
        bodyStr = JSON.stringify(parsed);
      } catch { /* keep original */ }

      d(`auto-continue nudge loop=${loopDepth} count=${nudgeCount} computing PoW...`);
      const filteredHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(capturedHeaders)) {
        const lower = k.toLowerCase();
        if (lower === 'content-type' || lower === 'content-length' || lower === 'x-ds-pow-response') continue;
        filteredHeaders[k] = v;
      }
      const powHeaders = await createPowHeaders(filteredHeaders);

      loopState.inAutoContinue = true;
      loopState.autoReplyText = '';
      await new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/v0/chat/completion', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        for (const [k, v] of Object.entries(filteredHeaders)) {
          try { xhr.setRequestHeader(k, v); } catch { /* ignore */ }
        }
        for (const [k, v] of Object.entries(powHeaders)) {
          try { xhr.setRequestHeader(k, v); } catch { /* ignore */ }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            d(`auto-continue nudge loop=${loopDepth} status=${xhr.status} autoReplyLen=${loopState.autoReplyText.length}`);
            loopState.inAutoContinue = false;
            loopState.streamActive = false;
            const reply = loopState.autoReplyText.trim();
            const hadTools = loopState.autoReplyHadTools;
            if (reply) {
              // v0.32 修复：同 autoContinueWithPow——只在无工具回合推回复给宿主，
              // 且推送前剥原始工具标签，避免宿主 AgentLoop 误判「未解析工具标签」。
              if (!hadTools) {
                const cleanReply = stripRawToolTags(reply).trim();
                if (cleanReply) {
                  try { onAssistantReply?.(cleanReply, loopDepth); } catch (e) { d(`nudge push failed: ${(e as Error).message}`); }
                } else {
                  d(`nudge reply all-tool-text (stripped to empty), skipping push`);
                }
              } else {
                d(`nudge turn had tools, not pushing to host`);
              }
              // nudge 回复不重复渲染到 DOM（autoContinueWithPow 的渲染分支只在正常续跑触发，
              // nudge 走同一 .ds-assistant-message-main-content 覆盖会混淆；面板经 onAssistantReply 已收到）。
            }
            if (xhr.status === 429 && loopDepth < MAX_LOOP) {
              d('auto-continue nudge 429, retrying in 8s');
              loopState.streamActive = false;
              if (autoContinueTimer) clearTimeout(autoContinueTimer);
              autoContinueTimer = setTimeout(() => { autoContinueTimer = null; autoContinueNudge(previousReplyText); }, 8000);
            } else {
              // nudge 回复后再次判定：有工具调用 → 走正常续跑；无工具 + 无 task_complete → 再 nudge（受 MAX_NUDGES 限）
              const replyForNudge = loopState.autoReplyText.trim();
              const hasTaskComplete = !!extractTaskCompleteSignal(replyForNudge);
              if (hadTools) {
                // nudge 后模型终于调了工具：续跑结果回来后 scheduleAutoContinue 接管，nudge 预算复位。
                nudgeCount = 0;
                d('auto-continue nudge end: tools detected, handing to scheduleAutoContinue');
              } else if (!hasTaskComplete && replyForNudge
                  && shouldNudge(replyForNudge)
                  && nudgeCount < MAX_NUDGES && loopDepth < MAX_LOOP) {
                nudgeCount += 1;
                d(`auto-continue nudge again count=${nudgeCount} loop=${loopDepth}`);
                autoContinueNudge(replyForNudge);
              } else {
                d(`auto-continue nudge end: hadTools=${hadTools} taskComplete=${hasTaskComplete} shouldNudge=${replyForNudge ? shouldNudge(replyForNudge) : false} nudgeCount=${nudgeCount}/${MAX_NUDGES}`);
              }
            }
            resolve();
          }
        };
        xhr.send(bodyStr);
      });
    } catch (e) {
      d(`auto-continue nudge failed: ${(e as Error).message}`);
      loopState.streamActive = false;
    }
  }

  const origFetch = window.fetch ? window.fetch.bind(window) : undefined;
  const stopFetch = origFetch ? installFetchHook(origFetch, forward, pending, d, loopState) : undefined;
  const stopXhr = installXhrHooks(forward, pending, d, loopState, capturedHeaders);

  // v1.0：设置记忆更新回调
  if (onMemoriesUpdate) {
    const originalCallback = onMemoriesUpdate;
    (options as { onMemoriesUpdate?: typeof onMemoriesUpdate }).onMemoriesUpdate = (memories) => {
      currentMemories = memories;
      originalCallback(memories);
    };
  }

  // v0.18：代码块运行器（python→python_exec；JS/TS→临时文件 + node）
  const codeRunner: CodeRunner = async (code, language) => {
    try {
      if (language === 'python') {
        const r = await sender({ callId: crypto.randomUUID(), invocationName: 'python_exec', params: { code } });
        if (!r.ok) return { ok: false, error: r.error };
        const dd = r.data as { stdout?: string; output?: string; result?: unknown } | undefined;
        const text = dd ? (dd.stdout ?? dd.output ?? (dd.result != null ? String(dd.result) : JSON.stringify(dd))) : '';
        return { ok: true, stdout: text || '(无输出)' };
      }
      const ext = language === 'typescript' ? 'ts' : 'mjs';
      const tmp = `C:/Users/lidicn/AppData/Local/Temp/studio-run-${Date.now()}.${ext}`;
      const w = await sender({ callId: crypto.randomUUID(), invocationName: 'local_file_write', params: { path: tmp, content: code } });
      if (!w.ok) return { ok: false, error: w.error };
      const nodeCmd = language === 'typescript'
        ? `node --experimental-strip-types "${tmp}"`
        : `node "${tmp}"`;
      const r = await sender({ callId: crypto.randomUUID(), invocationName: 'shell_exec', params: { command: nodeCmd } });
      if (!r.ok) return { ok: false, error: r.error };
      const dd = r.data as { stdout?: string; stderr?: string } | undefined;
      return { ok: true, stdout: dd?.stdout ?? '', stderr: dd?.stderr };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // v0.18：监听 DOM，给助手消息里新增的代码块加“运行”按钮
  let codeObserver: MutationObserver | null = null;
  let hydrateTimer: ReturnType<typeof setTimeout> | null = null;
  const setupCodeObserver = (): void => {
    if (!document.body || codeObserver) return;
    codeObserver = new MutationObserver(() => {
      if (hydrateTimer) clearTimeout(hydrateTimer);
      hydrateTimer = setTimeout(() => {
        hydrateTimer = null;
        const sels = ['.ds-assistant-message-main-content', '[class*="assistant-message"]'];
        for (const sel of sels) {
          document.querySelectorAll<HTMLElement>(sel).forEach((m) => hydrateCodeBlocks(m, codeRunner));
        }
      }, 400);
    });
    codeObserver.observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) setupCodeObserver();
  else document.addEventListener('DOMContentLoaded', setupCodeObserver, { once: true });

  // v1.0：启动时异步加载 MCP 工具列表，注入提示词让 agent 知道有哪些 MCP 工具可用
  // 注意：installMainWorldInterceptor 可能在 WebSocket 连接建立前被调用，
  // sender 会立即返回 no-host。需要重试直到成功或达到最大次数。
  (async () => {
    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const r = await sender({ callId: 'mcp-tools-init', invocationName: 'mcp.list', params: {} });
        if (r.ok && r.data && Array.isArray((r.data as { tools?: unknown[] }).tools) && (r.data as { tools: unknown[] }).tools.length > 0) {
          currentMcpTools = (r.data as { tools: Array<{ serverId: string; name: string; description: string }> }).tools;
          d(`loaded ${currentMcpTools.length} MCP tools for prompt injection (attempt ${attempt + 1})`);
          return;
        }
        d(`mcp tools load attempt ${attempt + 1} failed: ok=${r.ok} error=${r.error ?? 'none'} tools=${r.data ? (r.data as { tools?: unknown[] }).tools?.length ?? 0 : 0}`);
      } catch (e) {
        d(`mcp tools load attempt ${attempt + 1} error: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    d(`mcp tools load failed after ${maxRetries} attempts, agent will not see MCP tools in prompt`);
  })();

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
      try {
        if (hydrateTimer) clearTimeout(hydrateTimer);
        codeObserver?.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}
