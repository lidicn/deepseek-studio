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
import { DeepSeekSseFrameDecoder, framesSignalStreamCompletion } from './deepseek-sse-frame-decoder';
import { isSupportedUpstreamTool, SUPPORTED_INVOCATION_NAMES } from '../shared/tool-contract';
import { shouldSkipAutoContinue } from '../shared/tool-result-format';
import {
  buildContinuationPrompt,
  buildProtocolRepairPrompt,
  shouldAttemptProtocolRepair,
  extractTaskCompleteSignal,
  MAX_LOOP,
  MAX_ERROR_RETRIES,
  MAX_AUTO_CONTINUE,
  type PendingResult,
} from '../shared/continuation-prompt';
import {
  classifyResponse,
  classifySseFrame,
  errorBackoffMs,
  filterReplayableHeaders,
  recordVerdict,
  type ClassifiedResponse,
} from './response-classifier';
import type { ExecuteResult } from '../capabilities/types';
import { createPowHeaders } from './pow';
import { createStepFlowContainer, type StepFlowHandle } from './step-flow-ui';
import { hydrateCodeBlocks, type CodeRunner } from './render-code-runner';
import type { StudioChatUIHandle } from '../ui/studio-chat-ui';
import { normalizeChatSessionKey } from '../shared/studio-execution';
import {
  createStudioTraceCollector,
  renderStudioTraceReport,
  type StudioTraceCollector,
  type StudioTraceEvent,
} from '../shared/studio-trace';
import {
  describeStudioBudget,
  evaluateStudioBudgetForMessages,
} from '../shared/studio-context-budget';
import { createToolCallDedupe } from '../shared/tool-call-dedupe';
import { formatUntrustedMemoriesBlock } from './untrusted-memory';

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
  /<(?:local_file_(?:read|write|stat)|file_edit|search_files|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>[\s\S]*?<\/(?:local_file_(?:read|write|stat)|file_edit|search_files|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>/g;

function stripRawToolTags(text: string): string {
  return text.replace(RAW_TOOL_TAG_GLOBAL_RE, '');
}

/** 页端 → 宿主 的工具调用投递请求（与 host-client.sendToolCall 入参同构）。 */
export interface ToolCallRequest {
  readonly callId: string;
  readonly invocationName: string;
  readonly params: Record<string, unknown>;
  /** 对话标识（会话 key）：宿主据此实现「一个对话审批一次」。 */
  readonly conversationId?: string;
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
  /** M9：流式 delta 推送——每收到一段可见文本就推给宿主（用于 web-engine onDelta）。 */
  onStreamDelta?: (text: string) => void;
}

/** 断流取证入口：把当前缓冲的轨迹渲染成纯文本报告（空缓冲返回空串）。 */
export function renderInterceptorTraceReport(): string {
  return renderStudioTraceReport(interceptorTrace.snapshot());
}

/** 供测试直接取采集器快照（不经过渲染）。 */
export function interceptorTraceSnapshot(): readonly StudioTraceEvent[] {
  return interceptorTrace.snapshot();
}

/**
 * 把断流取证出口挂到 window.__studioTraceReport。
 * 没有调用方时 esbuild 会 tree-shake 掉整套 trace 采集（实测：导出未引用即被剔除），
 * 那样「用户报断流」时依然只能人肉翻 storage.json 时间戳。
 * 挂 global 的代价是一个函数引用，换取控制台一行 `__studioTraceReport()` 即可取证。
 */
export function installTraceReportHandle(): void {
  (globalThis as { __studioTraceReport?: () => string }).__studioTraceReport = renderInterceptorTraceReport;
}

export interface MainWorldInterceptorHandle {
  stop(): void;
}

// PendingResult 类型已提升到 src/shared/continuation-prompt.ts（单一真相源），
// 本模块 import 它，消除重复声明。

// v1.0：记忆列表缓存（由宿主推送，用于注入系统提示词的 "Existing Memories" 部分）
let currentMemories: Array<{ id: string; type: string; name: string; content: string; tags: string[] }> = [];

/** M10-8B（B1）：按任务预取记忆的有界等待状态。feature flag 默认关。
 *  C1-F1 修复：enabled 不再是安装时一次性固化的 boolean，支持运行期动态读取——
 *  真机注入时 flag 可能为 null，之后页端设置后要能生效。 */
const memorySelectState: {
  enabled: boolean | (() => boolean);
  pending: Promise<Array<{ id: string; type: string; name: string; content: string; tags: string[] }>> | null;
  lastTask: string;
  invoke: ((taskText: string) => Promise<{ ok: boolean; data?: { memories?: unknown } }>) | null;
} = { enabled: false, pending: null, lastTask: '', invoke: null };

/** 运行期求值 enabled：支持静态 boolean 或 getter 函数。 */
function isMemorySelectEnabled(): boolean {
  const v = memorySelectState.enabled;
  return typeof v === 'function' ? Boolean(v()) : Boolean(v);
}

export function configureMemorySelect(opts: {
  enabled: boolean | (() => boolean);
  invoke?: (taskText: string) => Promise<{ ok: boolean; data?: { memories?: unknown } }>;
}): void {
  memorySelectState.enabled = opts.enabled;
  memorySelectState.invoke = opts.invoke ?? null;
}

/** 启动一次新的预取（若 taskText 与上次相同则复用 in-flight）。 */
function kickMemorySelect(taskText: string): void {
  if (!isMemorySelectEnabled() || !memorySelectState.invoke) return;
  const trimmed = taskText.trim();
  if (!trimmed) return;
  if (memorySelectState.pending && memorySelectState.lastTask === trimmed) return;
  memorySelectState.lastTask = trimmed;
  memorySelectState.pending = memorySelectState.invoke(trimmed).then((r) => {
    const rows = r.ok && Array.isArray(r.data?.memories) ? r.data!.memories as Array<{ id: string; type: string; name: string; content: string; tags: string[] }> : [];
    return rows;
  }).catch(() => []);
}

/** 有界等待预取结果；超时/失败保持上一帧 currentMemories，不阻塞请求。 */
async function awaitMemorySelectBudget(limitMs = 120): Promise<void> {
  if (!memorySelectState.pending) return;
  const budget = new Promise<null>((resolve) => setTimeout(() => resolve(null), limitMs));
  const rows = await Promise.race([memorySelectState.pending, budget]);
  if (rows) {
    currentMemories = rows;
  }
  memorySelectState.pending = null;
}

// v1.0：MCP 工具列表缓存（启动时从宿主拉取，用于动态注入提示词，让 agent 知道有哪些 MCP 工具可用）
let currentMcpTools: Array<{ serverId: string; name: string; description: string }> = [];

export interface StudioSkillDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly skillMdPath: string;
}

// v1.9：技能列表缓存（启动时从宿主 skill.list 拉取，注入提示词，让 agent 知道有哪些技能、SKILL.md 在哪）。
let currentSkills: StudioSkillDescriptor[] = [];

// v1.3：步骤流 UI 句柄（分布思考状态栏 + 工具分组）
let stepFlow: StepFlowHandle | null = null;
let stepFlowStep = 0;
let stepFlowToolCount = 0;
let stepFlowStartTime = 0;
let stepReasoningAccum = '';

// v2.0 断流取证：模块级有界轨迹缓冲（环形，2000 条上限）。
// 纯内存、不落盘；页端 iframe 与 Node 测试两端可运行，刻意不依赖 studio-execution 的 kv 通道。
//
// QD-R7-01（F12）：内存环之外再加一条「每轮一行 JSONL」落盘通道。
// 内存环随页面刷新即丢；落盘由宿主侧完成（页端只把这行发过去，见 page-runtime 的
// 'trace' 分支 → logs/trace/trace-<日期>.jsonl）。这样断流现场重启后仍在，
// 可以直接 diff「哪一轮开始没有哨兵」，不必再靠 storage.json 的副产品时间戳反推。
const traceCollector: StudioTraceCollector = createStudioTraceCollector();
let traceLineSink: ((line: string) => void) | null = null;

/** 设置 JSONL 落盘通道（entry.ts 接到 host.trace）；传 null 关闭。 */
export function setInterceptorTraceSink(sink: ((line: string) => void) | null): void {
  traceLineSink = sink;
}

const interceptorTrace: StudioTraceCollector = {
  record(event) {
    traceCollector.record(event);
    // 只在「一轮真正收尾」时落一行：turn.end 是所有退出路径（完成 / 截断 / 放弃 /
    // 用户中止）的公共汇聚点，正好一轮一行。
    if (event.t === 'turn.end' && traceLineSink) {
      try {
        traceLineSink(JSON.stringify({ ...(event as Record<string, unknown>), ts: Date.now() }));
      } catch {
        // 取证落盘失败不影响主链路。
      }
    }
  },
  snapshot: () => traceCollector.snapshot(),
  clear: () => traceCollector.clear(),
  size: () => traceCollector.size(),
};
// UTF-8 字节数，不是 .length（中文请求体两者差 3 倍，直接影响「prompt 多大」的读数）。
function byteLengthOf(text: string): number {
  try {
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return text.length;
  }
}

/**
 * QD-R4-01：续跑重试的标志位。
 *
 * 根因：`autoContinueWithPow` 首行守卫要求 `pending.length > 0`，而续跑请求发出前
 * `pending.length = 0`（F8 修复，防 XHR hook 重复注入）。429/5xx/断网后退避定时器回调
 * 重新进入该函数，第一行守卫直接 return → MAX_ERROR_RETRIES=3 的预算一次都花不出去，
 * 表现为「工具卡片转完，回复停了」且状态栏永停在「执行中…」。
 *
 * 修复：让守卫显式豁免重试入口。重试只重发上一份 body，不依赖 pending。
 */
let continuationRetryPending = false;
// QD-R5-01: first-attempt (non-continuation) stream break auto-retry budget.
// Why a separate counter: the continuation path already has errorRetryCount + exponential
// backoff (see the retryable branch of autoContinueWithPow), but a first-attempt failure
// used to only appendError and stop - so one network blip forced a manual resend every round.
// Cap is 2: enough to cover a single blip, without making the user wait through three
// backoff cycles when the upstream is genuinely down.
/**
 * QD-R7-01（断流定案报告 F9/F10）：首轮重试预算必须「按轮次」存，并且「只有真发出才算」。
 *
 * 修复前是一个模块级数字，两个问题叠加：
 *   1) 被同一时刻并发的所有轮次共享 —— 结算读到的不是这一轮的账；
 *   2) 在「计划重发」时就 +1，而不是在请求真的发出去时。
 * 实测表现：243 毫秒内三次结算把预算烧穿，报出「已自动重试 2 次仍失败」，
 * 而退避从 2s 起，一次重试请求都不可能真的发出（storage.json 同一 turn 只有
 * 用户消息 + 重试 1/2 + 重试 2/2 + 放弃四条事件，间隔 141ms/99ms/4ms）。
 */
interface FirstAttemptBudget {
  /** 「重试请求」实际发出的次数（首轮那次不算）。 */
  sent: number;
  /** 已排进退避队列的重发次数（防「发不出去却无限排队」）。 */
  scheduled: number;
}
const firstAttemptBudgets = new Map<string, FirstAttemptBudget>();
function firstAttemptBudget(turnId: string): FirstAttemptBudget {
  let b = firstAttemptBudgets.get(turnId);
  if (!b) {
    b = { sent: 0, scheduled: 0 };
    firstAttemptBudgets.set(turnId, b);
    // 粗暴截断：只保留最近 32 轮，避免长会话里无限累积。
    while (firstAttemptBudgets.size > 32) {
      const oldest = firstAttemptBudgets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      firstAttemptBudgets.delete(oldest);
    }
  }
  return b;
}
/** QD-R5-01：首轮断流自动重试上限。 */
const FIRST_ATTEMPT_MAX_RETRIES = 2;
/** QD-R5-01：当前是否处于「首轮重发链」中（首轮失败后的原样重发，不是工具续跑）。
 *  用途有两点：让 autoContinueWithPow 知道要原样重发而不是套续跑 prompt；
 *  让执行器里的 retryable 分支走首轮预算，不去消耗续跑的 errorRetryCount。 */
let firstAttemptResendActive = false;
/** QD-R5-01：下一次 autoContinueWithPow 原样重发 lastChatBody（不套 <original_task>）。 */
let firstAttemptResendPending = false;

/**
 * QD-R7-01（断流定案报告 F4）：完成哨兵必须归属到「某一条流」。
 *
 * 修复前 streamSawDone 是挂在共享 loopState 上的一个全局布尔：写入口只有一个、
 * 重置点有五个，而结算点读的都是这个全局值。这套架构里并发是常态——页面自己的
 * completion、Studio 的首轮重发、上一轮没跑完的流、页面 auto_resume 可以同时存在。
 * 于是任何一条流看到 FINISHED 都会把「别人的」哨兵算到当前轮头上；反过来，当前轮
 * 真断流时结算读到的又可能是另一条流刚重置的 false。同一份代码有时对、有时错。
 *
 * 修法：每条 chat 流领一个序号，只有「当前被认领的那条流」才允许写哨兵/截断标记/
 * 字节计数，结算前也先确认「要结算的这条流就是被认领的那条」，否则整条跳过。
 */
const STREAM_UNCLAIMED = 0;
let streamSeq = STREAM_UNCLAIMED;

/** 认领一条新的 chat 流：返回它的 streamId，并把这条流的哨兵/字节计数清零。 */
function beginStream(loopState: LoopState): number {
  const id = ++streamSeq;
  loopState.activeStreamId = id;
  loopState.streamSawDone = false;
  loopState.streamTruncatedTag = false;
  loopState.streamBytes = 0;
  loopState.streamHadVisibleText = false;
  loopState.onStreamBegin?.();
  return id;
}

/** 该 streamId 是否仍是当前被认领的流（不是被更晚的请求挤掉的旧流）。 */
function isActiveStream(loopState: LoopState | undefined, streamId: number): boolean {
  return !!loopState && streamId !== STREAM_UNCLAIMED && loopState.activeStreamId === streamId;
}

/**
 * QD-R4-04：用户主动 abort 的标记。
 *
 * `xhr.abort()` 与「网络断开」在回调层完全同构（readyState=4, status=0），
 * classifyResponse(0) 一律 retryable/network-error。若本轮工具结果已回到 pending，
 * onStreamEnd 照常调度续跑 → 用户按下停止后仍发出新请求、模型继续输出并继续触发工具，
 * 这是用户控制面被绕过，不只是多发一次请求。
 *
 * 修复：包装 proto.abort 给该 xhr 打 __dsAborted，readyState===4 分类前先看它，
 * 命中则不分类、不重试、不续跑，清 pending/定时器并复位 UI。
 */
const DS_ABORTED_FLAG = '__dsAborted';

/**
 * QD-R4-03：本轮流是否收到完成哨兵。
 *
 * 此前 onStreamEnd 只看 pending 与 stepFlow，没有「流是否真的结束」这一维：
 * 模型吐到一半网络断掉（无工具）→ 走 else 分支 → 被当成正常完成收尾，
 * 用户只能自己发现「回答没说完」。
 *
 * DeepSeek 的完成哨兵不是通用 SSE 的 `data: [DONE]`（实测 20 份真实抓包
 * 全部 DONE=False），而是 `response/status = FINISHED` 或 `event: close`。
 * 判定在 deepseek-sse-frame-decoder.framesSignalStreamCompletion 里按 frame 做，
 * 不在原始 chunk 上做子串匹配（字节边界会把 frame 切开导致漏判）。
 */
// 当前轮次的 trace id。与 studio-execution 的 turnId 同源（同一轮 = 同 id），
// 但两套缓冲独立：trace 只回答「这轮发生了什么」，execution 记录回答「给用户看什么」。
let traceTurnId = '';
/** 空转续轮计数：流截断且本轮无工具时的独立封顶（受 MAX_AUTO_CONTINUE 约束）。 */
let idleContinueCount = 0;

/** 诊断回调（临时）：把 hook 拦到的对话请求信息上报宿主日志。 */
export type InterceptorDiag = (message: string) => void;

/** 自动工具循环的跨 hook 共享状态（fetch / XHR 两条路径共用同一实例）。 */
interface LoopState {
  /** 最近一次 chat 请求 body，作为自动续跑模板。 */
  lastChatBody: string | null;
  /** 当前响应流是否仍在进行（用于判断工具结果回填时机）。 */
  streamActive: boolean;
  /** QD-R4-03：本轮流是否见到 `data: [DONE]` 完成哨兵。 */
  streamSawDone?: boolean;
  /** QD-R7-01（F4）：当前被认领的流序号；只有它对应的流能改哨兵/截断/字节计数。 */
  activeStreamId?: number;
  /** QD-R7-01（F2）：本条流累计收到的原始字节数（0 = 根本没有流，不是截断）。 */
  streamBytes?: number;
  /** QD-R4-02：流结束时解析器尾部残留未闭合工具标签（工具调用被截断）。 */
  streamTruncatedTag?: boolean;
  /** QD-R4-04：当前请求是否由用户主动 abort（与网络断开不可区分，需显式区分）。 */
  abortedByUser?: boolean;
  /** QD-R5-01：首轮失败后的原样重发进行中（captureChatRequest 据此不当新用户消息）。 */
  inFirstAttemptResend?: boolean;
  /** QD-R4-04：在飞续跑定时器句柄（由 installMainWorldInterceptor 写入），
   *  供 settleStreamEnd / XHR hook 取消——定时器属于外层闭包，hook 内访问不到。 */
  autoContinueTimerRef?: ReturnType<typeof setTimeout> | null;
  /** 最近一次响应的 response_message_id。 */
  lastResponseMsgId: number | null;
  /** v0.9：auto-continue XHR 的累积回复文本（SSE extracted）。 */
  autoReplyText: string;
  /** v0.9：当前是否在处理 auto-continue 的 XHR 响应。 */
  inAutoContinue: boolean;
  /** v1.6：本轮 auto-continue 回复里是否出现了工具调用（由 forward 在 inAutoContinue 时置位）。
   *  readyState===4 时据此判断「模型没调工具」→ 走 nudge 判定，避免 pending 异步未到位的误判。 */
  autoReplyHadTools: boolean;
  /** 当前普通请求是否已解析到工具调用，即使执行结果尚未返回。 */
  streamHadTools: boolean;
  /** QD-R8-01：本条流是否推送过可见正文（用于区分「真的没话说」与「回复被吞」）。 */
  streamHadVisibleText?: boolean;
  /** R0-R5：本轮流里检测到的 SSE 错误帧（200 内嵌错误），readyState===4 时据此分类。 */
  sseErrorSeen?: ClassifiedResponse | null;
  /** v1.6：用户原始任务（首轮请求 prompt 字段，augmentation 前）。XHR/fetch hook 在首条消息时写入，
   *  autoContinueWithPow 读它拼续跑 prompt。 */
  originalTask: string;
  /** v0.19：检测到新用户消息时，把用户原始 prompt 传回给闭包（用于推送给 chat UI）。 */
  newUserPrompt?: string;
  /** 对话请求体中的稳定会话 id；缺省时由 UI 使用规范化路由兜底。 */
  newChatSessionId?: string;
  /** v0.19：自建聊天 UI（由 installMainWorldInterceptor 传入，fetch/XHR hook 共用）。 */
  chatUI?: StudioChatUIHandle;
  /** v1.6：检测到新用户消息（parent_message_id === null）时触发，让 installMainWorldInterceptor
   *  重置 collectedExecutions/loopDepth（闭包状态，hook 函数访问不到）。 */
  onNewUserMessage?: () => void;
  /** 竞态修复：流结束时回调，检查 pending 并触发续跑（由 installMainWorldInterceptor 设置） */
  onStreamEnd?: () => void;
  /** 每条新流开始时触发；用于清空单流工具签名去重集，保留 callId 去重集。 */
  onStreamBegin?: () => void;
  /** 本用户回合是否已经发起过协议修复轮。 */
  protocolRepairUsed?: boolean;
  /** 下一轮 auto-continue 是否应使用协议修复 prompt。 */
  protocolRepairPending?: boolean;
  /** QD-R4-04：取消在飞的续跑定时器 / 重试计划（由 installMainWorldInterceptor 设置，
   *  XHR hook 在用户 abort 分支调用——定时器属于外层闭包，hook 内访问不到）。 */
  cancelAutoContinue?: () => void;
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
const TOOL_CAPABILITY_END_MARKER = '[studio-tool-capability-end]';
const TOOL_CAPABILITY_PROMPT = `${TOOL_CAPABILITY_MARKER}
## 角色
你是 DeepSeek Studio 的本地工具代理，可以操作用户电脑上的文件、执行命令、保存长期记忆。

## 工具调用
你可以通过输出直接 XML 标签来调用工具，标签体内必须是合法 JSON：

<local_file_read>{"path":"E:/Users/name/file.txt"}</local_file_read>
<local_file_write>{"path":"E:/Users/name/file.txt","content":"要写入的文本"}</local_file_write>
<local_file_stat>{"path":"E:/Users/name"}</local_file_stat>
<shell_exec>{"command":"Get-ChildItem -LiteralPath 'E:/Users/name' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 10"}</shell_exec>
<memory_save>{"type":"user","name":"用户角色","content":"前端开发者，主要使用 React 和 TypeScript","tags":["frontend","React"]}</memory_save>
<python_exec>{"code":"print('hello')"}</python_exec>

## 规则
- 标签名必须匹配可用工具；JSON body 必须是合法 JSON（字符串用双引号，不要有多余逗号或注释）
- 工具调用放在最终回答正文里，不要放在思考/推理区域，不要放在 Markdown 代码块里
- 工具标签必须独立成行，标签前后不要有任何额外文字（不要在标签后写"。不要 Markdown"之类的话）
- Windows 路径一律用正斜杠（如 E:/Users/name），不要用反斜杠，不要写四反斜杠
- 列出文件/目录优先用 search_files 的 operation=list；检索文件内容优先用 operation=grep
- 只有在确实需要执行命令行工具时才用 shell_exec。不要用 Get-ChildItem -Recurse 扫描盘根、node_modules 或大型仓库
- 不要假设目录是 git 仓库；需要 git 信息前先用 local_file_stat 或 search_files 确认 .git 存在
- 一次只调用一个工具，等结果返回后再决定下一步；同一轮不要输出多个工具标签
- 不要重复输出工具名和参数都相同的调用；已有结果时直接基于结果继续
- 局部改写文件优先用 file_edit，只有创建文件或必须整文件替换时才用 local_file_write
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
只有用户明确要求"记住"、"记一下"、"别忘了"，或明确要求保存某条长期偏好/项目决策时，才调用 memory_save。
不要因为用户只是自我介绍、讨论技术方案或纠正本轮回答就自动保存记忆。
以下情况可作为候选，但除非用户明确要求，否则只在本轮使用：
- 用户提到自己的身份、职业或角色
- 用户表达偏好、习惯或工作风格
- 用户纠正你的回答风格或行为
- 出现重要的技术决策或架构选择

## 可用工具
- local_file_read — 读取文件内容，参数：path（绝对路径，正斜杠）
- local_file_write — 写入文件，参数：path、content
- local_file_stat — 查看文件/目录信息，参数：path
- file_edit — 局部改写文件（优先于整文件覆写），参数：path、edits（[{oldString,newString}]）、expectedSha256（可选）、dryRun（可选）
- search_files — 检索文件/内容，参数：operation（list/grep）、root、query、pattern、regex（可选）、glob（可选）、limit（可选）
- shell_exec — 执行命令行，参数：command（优先用 PowerShell，路径用正斜杠）
- memory_save — 保存长期记忆，参数：type（user/project）、name、content、tags（可选）、pinned（可选，布尔）
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
- file_edit — 局部改写文件（优先于整文件覆写），参数：path、edits（[{oldString,newString}]）、expectedSha256（可选）、dryRun（可选）
- search_files — 检索文件/内容，参数：operation（list/grep）、root、query、pattern、regex（可选）、glob（可选）、limit（可选）
- shell_exec — 执行命令行，参数：command（优先用 PowerShell，路径用正斜杠）
- memory_save — 保存长期记忆，参数：type（user/project）、name、content、tags（可选）、pinned（可选，布尔）
- python_exec — 执行 Python 代码，参数：code（Python 源代码字符串）
- mcp_list — 列出已配置的 MCP 服务器及其工具（无参数）
- mcp_call — 调用 MCP 工具，参数：serverId、tool、args（参数对象）

调用方式：直接输出 XML 标签，标签体内为合法 JSON，如 <shell_exec>{"command":"..."}</shell_exec>`;

/**
 * 从目录文本里提取「- <name> — 」形式的工具名，供测试断言目录与模型表一致。
 * 只读解析，不改变 prompt 本体。GAP-1 的教训：两份手工文本必然脱节，
 * 必须有测试盯着，否则加了映射不声明 = 模型看不到。
 */
export function toolCatalogNames(text: string): string[] {
  const names: string[] = [];
  const re = /(?:^|\r?\n)- ([a-zA-Z_][\w]*) \u2014 /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) names.push(m[1]);
  return names;
}

/** 首轮能力提示词里声明的工具名。 */
export function capabilityPromptToolNames(): string[] {
  return toolCatalogNames(TOOL_CAPABILITY_PROMPT);
}

/** 续跑 prompt 里引用的目录工具名。 */
export function catalogTextToolNames(): string[] {
  return toolCatalogNames(TOOL_CATALOG_TEXT);
}

/** D-5：续跑目录原文，供测试校验参数声明（例如 memory_save 必须列出 pinned）。 */
export function catalogText(): string {
  return TOOL_CATALOG_TEXT;
}

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function explicitSkillTokenRe(token: string): RegExp {
  // 前后不允许是路径分隔符、文件扩展名或标识符字符。这样 E:/NAS/deepseek-pp、
  // .../deepseek-pp-audit/SKILL.md 不会被误判成“用户点名了技能”。
  const before = String.raw`(^|[^A-Za-z0-9_.:/\\-])`;
  const after = String.raw`(?=$|[^A-Za-z0-9_.:/\\-])`;
  return new RegExp(`${before}${escapeRegExp(token)}${after}`, 'u');
}

function explicitSlashSkillRe(id: string): RegExp {
  // /skill-id 只接受行首、空白、引号/标点或中文前的斜杠命令；
  // 排除 C:/...、E:/... 这类路径中的斜杠。
  const before = String.raw`(^|[\s"'“”‘’「」【】,，;；!?！？\u4e00-\u9fff])`;
  const after = String.raw`(?=$|[^A-Za-z0-9_.:/\\-])`;
  return new RegExp(`${before}/${escapeRegExp(id)}${after}`, 'u');
}

/**
 * 只选择用户在任务里明确点名的技能。
 *
 * 明确点名 = `/skill-id`，或完整 skill id / name 作为独立词出现。项目路径、
 * 项目名和技能 description 里的关键词都不触发。修复现场：用户只问
 * `E:/NAS/deepseek-pp`，模型却自行读取 deepseek-pp-audit/SKILL.md。
 */
export function selectExplicitSkills(
  taskText: string,
  skills: readonly StudioSkillDescriptor[],
): StudioSkillDescriptor[] {
  const text = taskText.trim();
  if (!text) return [];
  return skills.filter((skill) => {
    if (explicitSlashSkillRe(skill.id).test(text)) return true;
    const terms = [...new Set([skill.id, skill.name].filter((term) => term.trim().length > 0))];
    return terms.some((term) => explicitSkillTokenRe(term).test(text));
  });
}

/** 生成“仅显式技能”提示块。没有明确点名时返回空串，不向模型列出技能清单。 */
export function formatExplicitSkillsBlock(
  taskText: string,
  skills: readonly StudioSkillDescriptor[],
): string {
  const selected = selectExplicitSkills(taskText, skills);
  if (selected.length === 0) return '';
  const lines = [
    '## 技能（仅限用户明确点名）',
    '本轮用户明确点名了以下技能，才读取对应 SKILL.md：',
    '1. 先用 local_file_read 读取对应 SKILL.md；',
    '2. 严格按 SKILL.md 里的 SOP / 约束 / 依赖执行；',
    '3. 不要因为项目路径、项目名或技能描述关键词相似，就读取未被点名的其他技能。',
    '',
    '本轮明确点名的技能：',
  ];
  for (const sk of selected) {
    lines.push(`- ${sk.id}（${sk.name}）— ${sk.description}｜SKILL.md: ${sk.skillMdPath}`);
  }
  return lines.join('\n');
}

function formatSkillsBlock(taskText: string): string {
  return formatExplicitSkillsBlock(taskText, currentSkills);
}

/** 导出静态提示模板，供回归测试逐条验证示例标签里的 JSON 可解析。 */
export function capabilityPromptText(): string {
  return TOOL_CAPABILITY_PROMPT;
}

export function buildCapabilityPrompt(taskText = ''): string {
  const blocks = [TOOL_CAPABILITY_PROMPT];
  const mcpBlock = formatMcpToolsBlock();
  if (mcpBlock) blocks.push(mcpBlock);
  const skillsBlock = formatSkillsBlock(taskText);
  if (skillsBlock) blocks.push(skillsBlock);
  blocks.push(TOOL_CAPABILITY_END_MARKER);
  return blocks.join('\n\n');
}

function isCapabilitySystemMessage(message: unknown): boolean {
  const m = message as { role?: string; content?: unknown } | undefined;
  return m?.role === 'system'
    && typeof m.content === 'string'
    && m.content.includes(TOOL_CAPABILITY_MARKER);
}

/**
 * 每次发送都重建能力提示，而不是看到 marker 就原样返回。
 * 原实现会把首轮的全量技能块永久留在 system prompt 中，导致后续无关任务继续被误导。
 */
function injectInstructionIntoMessages(messages: unknown[], taskText: string): unknown[] {
  const rest = messages.filter((message) => !isCapabilitySystemMessage(message));
  return [{ role: 'system', content: buildCapabilityPrompt(taskText) }, ...rest];
}

function stripCapabilityPromptFromText(text: string): string {
  const start = text.indexOf(TOOL_CAPABILITY_MARKER);
  if (start < 0) return text;
  const end = text.indexOf(TOOL_CAPABILITY_END_MARKER, start);
  if (end < 0) return text;
  // capability block 与用户 prompt 之间原本固定隔着两个换行；重建时这一对换行
  // 会由 `${buildCapabilityPrompt}...\\n\\n${cleanPrompt}` 重新补上，若这里不剥掉
  // 会让首轮重发体多出空行，破坏 F8 的逐字节幂等。
  const tail = text.slice(end + TOOL_CAPABILITY_END_MARKER.length).replace(/^(?:\r?\n){2}/, '');
  return `${text.slice(0, start)}${tail}`;
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
  // STUDIO_UNTRUSTED_MEMORY_* markers are neutralized by the formatter wrapper.
  return formatUntrustedMemoriesBlock(currentMemories);
}

/**
 * R-W2：从 outgoing body 里取 chat_session_id 的唯一真源（返回原始值，不归一化）。
 * 与 captureChatRequest 同一组候选键。调用方需要比对时自行 normalizeChatSessionKey。
 */
function extractChatSessionIdFromBody(rawBody: string): string | undefined {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const raw = parsed.chat_session_id ?? parsed.chatSessionId ?? parsed.session_id ?? parsed.conversation_id;
    if (typeof raw === 'string' || typeof raw === 'number') {
      const value = String(raw).trim();
      return value || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function prepareOutgoingBody(rawBody: string, pending: PendingResult[], taskText = ''): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }
  // R-W2：续跑注入路径（XHR hook :1157 / fetch 侧同构）也走这里。
  // 先按当前请求 body 的 chat_session_id 过滤跨会话迟到结果，再注入。
  // currentSession 未知时（undefined）按现网行为保留全部 pending 并记 trace，不误杀。
  const rawCurrentSession = extractChatSessionIdFromBody(rawBody);
  const currentSession = rawCurrentSession ? normalizeChatSessionKey(rawCurrentSession) : undefined;
  let effectivePending = pending;
  if (currentSession) {
    // PendingResult.sessionId 由 captureChatRequest 写入时已 normalize，这里直接比对。
    const dropped = pending.filter((p) => {
      if (!p.sessionId) return false;
      return p.sessionId !== currentSession;
    });
    if (dropped.length > 0) {
      interceptorTrace.record({
        t: 'pending.cross-session',
        turnId: traceTurnId,
        current: currentSession,
        droppedCount: dropped.length,
        droppedNames: dropped.map((d) => d.invocationName),
      });
      effectivePending = pending.filter((p) => !p.sessionId || normalizeChatSessionKey(p.sessionId) === currentSession);
    }
  }
  // v1.7：无条件注入工具能力提示词。要不要用工具由模型自己判断，前提是模型
  // 始终知道有工具可用。之前用正则猜意图（hasToolIntent）会漏掉「审计」「bug」
  // 「代码」等关键词，导致模型不知道有工具而只聊天。修复：不再猜，直接注入。
  // hasToolIntent 仅用于避免重复注入（已注入则跳过），不再用于决定「是否注入」。
  const hasResults = effectivePending.length > 0;
  const block = hasResults ? formatToolResultBlock(effectivePending.slice()) : '';
  const memoriesBlock = formatMemoriesBlock();
  if (Array.isArray(parsed.messages)) {
    let msgs: unknown[] = parsed.messages as unknown[];
    // 每次发送都重建：技能选择必须跟随当前用户任务，不能沿用上一轮的全量技能块。
    msgs = injectInstructionIntoMessages(msgs, taskText);
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
    // 旧请求体可能已经带过能力提示；先剔除带结束标记的旧块，再按当前任务重建。
    const cleanPrompt = stripCapabilityPromptFromText(prompt);
    prompt = `${buildCapabilityPrompt(taskText)}${memoriesBlock}\n\n${cleanPrompt}`;
    if (hasResults) prompt = reinjectIntoPrompt(prompt, effectivePending.slice());
    parsed.prompt = prompt;
  } else {
    return null;
  }
  pending.length = 0;
  return JSON.stringify(parsed);
}

function augmentInit(
  init: RequestInit | undefined,
  pending: PendingResult[],
  taskText = '',
): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init;
  // R-W2：跨会话过滤已下沉到 prepareOutgoingBody（续跑注入路径共用）。
  // 这里只做首轮防御，不再重复过滤。
  const newBody = prepareOutgoingBody(init.body, pending, taskText);
  if (newBody === null) return init;
  return { ...init, body: newBody };
}

/**
 * 估算 outgoing 请求体的上下文占用，把三档提示送到 Studio 状态栏。
 * 只提示不截断：截断由 continuation-prompt 的字符预算负责，本函数不参与裁剪。
 * 纯 UI 副作用，失败不影响请求本身。
 */
function reportContextBudget(rawBody: string, chatUI?: StudioChatUIHandle): void {
  if (!chatUI) return;
  try {
    const parsed = JSON.parse(rawBody) as { messages?: unknown };
    if (!Array.isArray(parsed.messages)) return;
    const state = evaluateStudioBudgetForMessages(parsed.messages);
    const notice = describeStudioBudget(state);
    // ok 档 notice 为空串 → 清除上一条提示，避免旧告警长期挂在状态栏。
    chatUI.setContextNotice(notice);
  } catch { /* 非 JSON 或 UI 未就绪：跳过提示 */ }
}

function captureChatRequest(body: string, loopState: LoopState, diag: InterceptorDiag): void {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    loopState.newChatSessionId = undefined;
    const rawSessionId = extractChatSessionIdFromBody(body);
    if (rawSessionId) loopState.newChatSessionId = normalizeChatSessionKey(rawSessionId);
    let userText = typeof parsed.prompt === 'string' ? parsed.prompt : '';
    if (!userText && Array.isArray(parsed.messages)) {
      for (let i = parsed.messages.length - 1; i >= 0; i--) {
        const message = parsed.messages[i] as { role?: string; content?: unknown };
        if (message?.role !== 'user') continue;
        if (typeof message.content === 'string') {
          userText = message.content;
        } else if (Array.isArray(message.content)) {
          userText = message.content
            .map((part) => {
              if (typeof part === 'string') return part;
              const p = part as { type?: string; text?: string };
              return p.type === 'text' && typeof p.text === 'string' ? p.text : '';
            })
            .join('');
        }
        break;
      }
    }
    // QD-R5-01：首轮重发不是新任务。重发体会带注入的能力前缀，
    // 不排除它就会被判成新一轮 → 重试预算被重置、prompt 漂移。
    if (
      userText.trim()
      && !loopState.inFirstAttemptResend
      && !userText.includes('<original_task>')
      && !userText.includes('<tool_results')
      && !userText.includes('[TOOL_RESULTS]')
    ) {
      loopState.originalTask = userText;
      loopState.newUserPrompt = userText;
      diag(`originalTask captured len=${loopState.originalTask.length}`);
      // 新用户消息 = 新一轮 trace。id 与 execution turnId 同源同值。
      traceTurnId = `t${Date.now().toString(36)}`;
      idleContinueCount = 0;
      interceptorTrace.record({ t: 'turn.start', turnId: traceTurnId });
      loopState.onNewUserMessage?.();
      // M10-8B（B1）：feature flag 开时，按任务文本预取记忆候选。
      kickMemorySelect(userText);
    }
  } catch {
    // 非 JSON 请求体不参与会话识别。
  }
}

function installFetchHook(
  origFetch: typeof window.fetch,
  forward: (call: ParsedToolCall) => void,
  pending: PendingResult[],
  diag: InterceptorDiag = () => {},
  loopState?: LoopState,
  settleStreamEnd?: (
    loopState: LoopState,
    pending: PendingResult[],
    httpStatus?: number,
    streamId?: number,
  ) => boolean,
  escalateFirstAttemptFailure?: (code: string, why: string) => void,
): () => void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input);
    const method = methodOf(input, init);
    diag(`fetch ${method} ${url} bodyType=${typeof init?.body}`);
    if (isDeepSeekChatEndpoint(url, method) && loopState && typeof init?.body === 'string') {
      captureChatRequest(init.body, loopState, diag);
    }

    // M10-8B（B1）：首轮发送前有界等待 memory.select 结果（≤120ms）；超时回落上一帧。
    // C1-F1 修复：enabled 运行期动态求值，注入时 flag=null 之后变 true 也能生效。
    if (isMemorySelectEnabled() && isDeepSeekChatEndpoint(url, method) && !loopState?.inFirstAttemptResend) {
      await awaitMemorySelectBudget(120);
    }

    // 请求侧回填：把累积的工具结果写进下一次对话请求的 prompt
    if (pending.length > 0 && isDeepSeekChatEndpoint(url, method) && !loopState?.inFirstAttemptResend) {
      init = augmentInit(init, pending, loopState?.originalTask ?? '');
    }

    // 非对话响应不拦截（直接放行，避免影响其它请求）
    if (!isDeepSeekChatEndpoint(url, method)) {
      return origFetch(input, init);
    }

    diag(`chat-endpoint matched, bodyLen=${typeof init?.body === 'string' ? init.body.length : 'n/a'}`);
    if (loopState) {
      loopState.streamActive = true;
      loopState.sseErrorSeen = null;
      if (typeof init?.body === 'string') loopState.lastChatBody = init.body;
    }
    // QD-R7-01（F4/F9/F10）：认领这条流；若它是首轮重发，记一次「真实发出」。
    // beginStream 顺带把本轮哨兵/截断/字节计数清零（原来的三行重置收进这里）。
    const streamId = loopState ? beginStream(loopState) : STREAM_UNCLAIMED;
    if (loopState?.inFirstAttemptResend) firstAttemptBudget(traceTurnId).sent += 1;
    if (loopState && typeof init?.body === 'string') {
      interceptorTrace.record({ t: 'request.sent', turnId: traceTurnId, bytes: byteLengthOf(init.body) });
      reportContextBudget(init.body, loopState.chatUI);
    }
    const response = await origFetch(input, init);
    if (loopState && !response.ok) {
      const verdict = classifyResponse(response.status, null);
      loopState.chatUI?.finishAssistantMessage({ recordFinal: false });
      // QD-R5-01：首轮 retryable 失败先原样重发，封顶 2 次；预算耗尽才上报。
      // 与 XHR 路径共用 escalateFirstAttemptFailure，避免两条路径各写一套重试语义。
      if (verdict.verdict === 'retryable') {
        loopState.streamActive = false;
        escalateFirstAttemptFailure?.(verdict.reason, '服务器暂时无法访问');
        return response;
      }
      loopState.chatUI?.appendError(
        verdict.reason,
        firstAttemptBudget(traceTurnId).sent > 0
          ? `服务器暂时无法访问，已自动重试 ${firstAttemptBudget(traceTurnId).sent} 次仍失败。请检查网络后手动重试。`
          : `请求失败（${verdict.reason}），本轮消息不会自动重发。`,
      );
      loopState.chatUI?.setBusy(false);
      return response;
    }
    if (!response.body) return response;

    const parser = new StreamingToolCallParser(SUPPORTED_INVOCATION_NAMES);
    const sse = new SseTextStreamExtractor();
    // QD-R4-03：fetch 路径此前完全没有 frame decoder，无法判定完成哨兵。
    const frameDec = new DeepSeekSseFrameDecoder();
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
            // QD-R7-01（F2）：累计本条流的字节数，供「0 字节 vs 有字节无哨兵」三态判定。
            if (loopState) loopState.streamBytes = (loopState.streamBytes ?? 0) + rawSse.length;
            // QD-R4-03：fetch 路径同样要判定完成哨兵（按 frame 判定，见 framesSignalStreamCompletion）。
            // QD-R7-01（F4）：只有当前被认领的那条流才能写哨兵。
            if (loopState && isActiveStream(loopState, streamId) && framesSignalStreamCompletion(frameDec.push(rawSse))) {
              loopState.streamSawDone = true;
            }
            const text = sse.feed(rawSse);
            const { calls, clean } = parser.feed(text);
            if (clean) interceptorTrace.record({ t: 'sse.frame', turnId: traceTurnId, kind: 'text', count: clean.length });
            if (clean && loopState && isActiveStream(loopState, streamId)) loopState.streamHadVisibleText = true;
            if (calls.length > 0) interceptorTrace.record({ t: 'sse.frame', turnId: traceTurnId, kind: 'tool', count: calls.length });
            // v0.19：推送可见文本给自建聊天 UI（80ms 节流 + markdown 实时渲染 + 光标）
            if (loopState?.chatUI && clean) loopState.chatUI.appendToAssistantMessage(clean);
            // v0.18：抽取推理文本到步骤笔记 + chat UI think 块（传累积全量快照）
            const rsn = sse.consumeReasoning();
            if (rsn) {
              stepReasoningAccum += rsn;
              stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
              if (loopState?.chatUI) loopState.chatUI.appendReasoning(stepReasoningAccum);
              interceptorTrace.record({ t: 'sse.frame', turnId: traceTurnId, kind: 'think', count: rsn.length });
            }
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
            const tailParsed = parser.feed(sseTail);
            if (loopState?.chatUI && tailParsed.clean) {
              loopState.chatUI.appendToAssistantMessage(tailParsed.clean);
            }
            if (tailParsed.clean && loopState && isActiveStream(loopState, streamId)) loopState.streamHadVisibleText = true;
            for (const c of tailParsed.calls) forward(c);
            // 尾部也原样转发
          }
          // QD-R7-01（F1）：EOF 必须 flush frame 缓冲并重跑哨兵判定。
          // 解码器只在空行上切 frame，而实测流尾那一段（event: close / FINISHED）
          // 常常不带结尾空行 → 永远吐不出来 → 正常完成的流被判成截断。
          // finish() 此前全项目零调用，XHR 与 fetch 两条路径都只往缓冲里 push。
          const tailFrames = frameDec.finish();
          if (loopState && isActiveStream(loopState, streamId) && framesSignalStreamCompletion(tailFrames)) {
            loopState.streamSawDone = true;
          }
          const fin = parser.flush();
          for (const c of fin.calls) forward(c);
          // QD-R4-02：fetch 路径此前只取 fin.calls，flush 的残留 tail 被丢弃。
          // 残留含 '<' 即代表有未闭合工具标签，必须标记为截断。
          if (fin.hasUnclosedToolTag && loopState && isActiveStream(loopState, streamId)) {
            loopState.streamTruncatedTag = true;
          }
        } catch (err) {
          // QD-R4-06：此前 catch 里直接 return，streamActive 永远停在 true，
          // onStreamEnd 不执行 → forward 的 .then 里 scheduleAutoContinue 的
          // `!streamActive` 条件永不成立，工具循环卡死且 UI 无收尾。
          if (loopState) {
            loopState.streamActive = false;
            interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'stream-error' });
            try { loopState.chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
            loopState.chatUI?.appendError(
              'stream-error',
              '读取模型回复时连接中断，本轮不会自动重试。请重新发送该请求。',
            );
            loopState.chatUI?.setBusy(false);
            if (typeof loopState.onStreamEnd === 'function') {
              try { loopState.onStreamEnd(); } catch { /* ignore */ }
            }
          }
          controller.error(err);
          return;
        }
        controller.close();
        if (loopState) {
          loopState.streamActive = false;
          // QD-R4-02/03：fetch 路径此前完全没有断流判定。XHR 一侧的 isDone 分支
          // 只挂在 XHR 上，fetch 拉流时工具标签被截断 / 无完成哨兵依旧静默无反馈。
          // W6：fetch 路径把 response.status 传入 settleStreamEnd，与 XHR 路径同语义
          // （此前传 undefined → httpVerdict=null → 一律误报 stream-incomplete）。
          settleStreamEnd?.(loopState, pending, response.status, streamId);
          // 竞态修复：同 XHR 路径，工具结果先于流结束返回时通过 onStreamEnd 补触发
          // QD-R7-01（F6）：结算命中不再吞掉收尾——此前 settle 返回 true 时这里
          // 整段被跳过，页面侧那条助手消息永远不收尾，污染下一轮父节点。
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
  onStreamDelta?: (text: string) => void,
  settleStreamEnd?: (
    loopState: LoopState,
    pending: PendingResult[],
    httpStatus?: number,
    streamId?: number,
  ) => boolean,
  escalateFirstAttemptFailure?: (code: string, why: string) => void,
): () => void {
  if (typeof XMLHttpRequest === 'undefined') return () => {};
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  const origSetRequestHeader = proto.setRequestHeader;
  // QD-R4-04：包装 abort，让「用户主动停止」与「网络断开」在回调层可区分。
  const origAbort = proto.abort;
  proto.abort = function (this: XMLHttpRequest & Record<string, unknown>) {
    (this as Record<string, unknown>)[DS_ABORTED_FLAG] = true;
    if (loopState) {
      loopState.abortedByUser = true;
      loopState.protocolRepairUsed = false;
      loopState.protocolRepairPending = false;
    }
    // C1-F1: 如果 proto.send 因 memory.select 有界等待被延迟，
    // 用户此时 abort → 立即触发延迟 send（doSend 里会检测已 abort 并立即 origAbort），
    // 保证 readyState=4 回调链正常触发，不留下悬挂 XHR。
    const delayedSend = (this as Record<string, unknown>).__dsDelayedSend as ((body?: Document | XMLHttpRequestBodyInit | null) => void) | undefined;
    if (typeof delayedSend === 'function') {
      (this as Record<string, unknown>).__dsDelayedSend = undefined;
      delayedSend();
      return undefined;
    }
    return (origAbort as (...a: unknown[]) => unknown).apply(this, []);
  } as typeof proto.abort;

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
    // QD-R7-01（F4）：本条 XHR 的流序号，在下面的 chat 分支里认领；
    // 回调闭包按它判断「这条流还是不是当前被认领的那条」。
    let streamId = STREAM_UNCLAIMED;
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
      if (loopState) captureChatRequest(body, loopState, diag);
      // F8：首轮原样重发时，body 已经是上一份已注入的原文；再跑一次注入会把
      // JSON 重新序列化并改变字节，重试就不再幂等。
      const next = loopState?.inFirstAttemptResend
        ? body
        : prepareOutgoingBody(body, pending, loopState?.originalTask ?? '');
      if (next !== null) {
        body = next;
        diag(`xhr chat body injected len=${next.length}`);
      }
      // v0.8：记住最近一次 chat 请求 body 作为自动续跑模板。
      if (loopState) {
        loopState.lastChatBody = body;
        loopState.streamActive = true;
        loopState.sseErrorSeen = null;
      }
      // QD-R7-01（F4/F9/F10）：认领这条流（并清零本轮哨兵/截断/字节计数）；
      // 若它是首轮重发，记一次「真实发出」——预算只认真发出去的请求。
      streamId = loopState ? beginStream(loopState) : STREAM_UNCLAIMED;
      if (loopState?.inFirstAttemptResend) firstAttemptBudget(traceTurnId).sent += 1;
      interceptorTrace.record({ t: 'request.sent', turnId: traceTurnId, bytes: byteLengthOf(body) });
      reportContextBudget(body, loopState?.chatUI);
    }
    const xhr = this;
    const sendNow = () => (origSend as (...a: unknown[]) => unknown).call(xhr, body);
    // C1-F1 修复：XHR 路径也要获得与 fetch 等价的 memory.select 有界等待。
    // proto.send 必须同步返回 void，所以采用「延迟 origSend」模式：
    // kickMemorySelect 已在 captureChatRequest 里同步触发；若有 pending，
    // 用 120ms 预算等结果，超时立即发。发送被延迟时 proto.send 先同步 return。
    // 非聊天 XHR / 首轮重发 / feature flag 关 → 不延迟，直接走原路径。
    const NEED_MEM_SELECT_WAIT = isChat
      && isMemorySelectEnabled()
      && !!memorySelectState.pending
      && !loopState?.inFirstAttemptResend;
    if (NEED_MEM_SELECT_WAIT) {
      const pendingSel = memorySelectState.pending!;
      let settled = false;
      // 延迟执行真正的 origSend；检测到 abort 时先发再 origAbort，保证 readyState=4。
      const doDelayedSend = () => {
        if (settled) return;
        settled = true;
        (this as Record<string, unknown>).__dsDelayedSend = undefined;
        // 消费 pending 结果（若此时 fetch 路径还没消费）
        if (memorySelectState.pending === pendingSel) {
          void pendingSel.then((rows) => {
            if (rows && rows.length > 0) currentMemories = rows;
          });
          memorySelectState.pending = null;
        }
        const wasAborted = Boolean((this as Record<string, unknown>)[DS_ABORTED_FLAG]);
        try {
          // 延迟发送也必须先挂响应钩子，否则工具解析、哨兵和断流结算全部失效。
          installResponseHookAndSend();
        } catch (e) {
          // 延迟 send 的异常走 setTimeout 回调；这里让 onreadystatechange 链自然处理。
          // eslint-disable-next-line no-console
          console.error('[interceptor] delayed xhr origSend threw:', e);
          return;
        }
        if (wasAborted) {
          (origAbort as (...a: unknown[]) => unknown).call(this);
        }
      };
      // 暴露给 proto.abort 包装：延迟期间用户 abort → 立即触发 send 再 abort。
      (this as Record<string, unknown>).__dsDelayedSend = doDelayedSend;
      // 120ms 预算：pending 完成或超时谁先到就触发 send。
      const budget = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 120);
      });
      Promise.race([pendingSel, budget]).then(() => doDelayedSend());
      // proto.send 同步返回 void；origSend 将在 budget 到期后或 pending 完成后执行。
      return void 0;
    }
    function installResponseHookAndSend() {
      (xhr as Record<string, unknown>).__dsIsChat = isChat;
      const prev = xhr.onreadystatechange;
      xhr.onreadystatechange = (...args: unknown[]) => {
      // QD-R6-01：断流结算只对对话端点成立。
      // 此前 isDone / streamActive 重置对**所有** XHR 生效，于是页面启动阶段
      // 那一批非对话请求（/api/v0/client/settings、/api/v0/chat/history_messages、
      // gator.volces.com 埋点…）在 readyState=4 时逐个掉进 settleStreamEnd，
      // 而本轮 streamSawDone 仍是 false → 被判「无完成哨兵」→ 计入首轮重试预算
      // → 预算耗尽后每来一个非对话 XHR 就 append 一张 stream-incomplete 错误卡，
      // 表现为「满屏执行未完成」。门禁补上 isChat 后，只有真正的 completion
      // 流才参与哨兵/截断判定。
      const isDone = xhr.readyState === 4 && !!loopState && isChat;
      // QD-R7-01（F4）：旧流结束不再清 streamActive —— 它已不属于当前轮，
      // 清了会让「当前流还在跑」的状态被误置为 false，提前触发续跑。
      if (xhr.readyState === 4 && loopState && isChat && isActiveStream(loopState, streamId)) {
        loopState.streamActive = false;
      }
      if (xhr.readyState >= 3) {
        const text = xhr.responseText;
        const scanned = (xhr.__dsScanned ?? 0) as number;
        const part = text.slice(scanned);
        xhr.__dsScanned = text.length;
        if (part && (xhr as Record<string, unknown>).__dsIsChat) {
          diag(`xhr resp[${part.length}]: ${part.slice(0, 400).replace(/\s+/g, ' ')}`);
          // QD-R7-01（F2）：累计本条流的字节数，供三态判定用。
          if (loopState) loopState.streamBytes = (loopState.streamBytes ?? 0) + part.length;
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
          for (const frame of frames) {
            // R0-R5：识别流内 SSE 错误帧（event=error / status=0·429·500 载荷），
            // 200 状态码下也记录，供 readyState===4 分类，避免被当空回复 nudge。
            const sseErr = classifySseFrame(frame.event?.type ?? null, frame.parsed);
            if (sseErr && loopState) {
              recordVerdict({ status: xhr.status, verdict: sseErr.verdict, reason: sseErr.reason, attempt: 0 });
              loopState.sseErrorSeen = sseErr;
            }
          }
          let visible = sse.feed(part);
          // readyState===4：流结束，刷出 SSE 缓冲区里最后一个不带换行的残留事件
          if (xhr.readyState === 4) visible += sse.flush();
          // QD-R4-03：完成哨兵。必须按 frame 判定——字节边界可能把 frame
          // 切在两次回调之间，对 part 做子串匹配会漏判 → 把正常流误报成截断。
          // QD-R7-01（F4）：只有当前被认领的那条流才能写哨兵，否则就是「读到别人的结果」。
          if (loopState && isActiveStream(loopState, streamId) && framesSignalStreamCompletion(frames)) {
            loopState.streamSawDone = true;
          }
          // v0.18：抽取推理文本到步骤笔记 + chat UI think 块
          const rsnX = sse.consumeReasoning();
          if (rsnX) {
            stepReasoningAccum += rsnX;
            stepFlow?.addReasoningNote(stepFlowStep, stepReasoningAccum);
            if (loopState?.chatUI) loopState.chatUI.appendReasoning(stepReasoningAccum);
            interceptorTrace.record({ t: 'sse.frame', turnId: traceTurnId, kind: 'think', count: rsnX.length });
          }
          if (visible) {
            diag(`xhr extracted[${visible.length}]: ${visible.slice(0, 300).replace(/\s+/g, ' ')}`);
            // v0.9：auto-continue 的 XHR 回复不渲染到 DOM，累积到 autoReplyText
            if (loopState && loopState.inAutoContinue) {
              loopState.autoReplyText += visible;
            }
            // M9：流式 delta 推给宿主（web-engine onDelta）
            onStreamDelta?.(visible);
            // 统一走 SseTextStreamExtractor 的 RESPONSE 文本：它已过滤 THINK，
            // 且 JSON 解析后保留工具标签参数中的正确转义。此前另建 rawDataText
            // 会把 THINK 文本一起喂给工具解析器，最终被当成可见回答记录。
            const { calls, clean } = parser.feed(visible);
            if (clean) interceptorTrace.record({ t: 'sse.frame', turnId: traceTurnId, kind: 'text', count: clean.length });
            if (clean && loopState && isActiveStream(loopState, streamId)) loopState.streamHadVisibleText = true;
            if (calls.length > 0) interceptorTrace.record({ t: 'sse.frame', turnId: traceTurnId, kind: 'tool', count: calls.length });
            // v0.19：parser.clean 已剔除完整/未完成的工具标签；不要按网络分片正则兜底，
            // 否则跨 chunk 的半个标签仍可能闪过 Studio。
            if (loopState?.chatUI && clean) {
              loopState.chatUI.appendToAssistantMessage(clean);
            }
            for (const c of calls) forward(c);
          }
        }
      }
      if (isDone && loopState) {
        // QD-R7-01（F1）：EOF 必须 flush frame 解码器并重跑哨兵判定。
        // 解码器只在空行上切 frame，而流尾那段（event: close / response/status=FINISHED）
        // 实测常常不带结尾空行 → finish() 之前它永远吐不出来 → 正常完成的流被判截断。
        // finish() 此前全项目零调用（XHR / fetch 两条路径都只 push 不 finish）。
        const tailDecoder = (xhr as Record<string, unknown>).__dsFrameDec as
          | DeepSeekSseFrameDecoder
          | undefined;
        if (tailDecoder) {
          const tailFrames = tailDecoder.finish();
          if (isActiveStream(loopState, streamId) && framesSignalStreamCompletion(tailFrames)) {
            diag('xhr tail frame flushed: completion sentinel found at EOF');
            loopState.streamSawDone = true;
          }
        }
        // QD-R4-02：XHR 路径此前只 feed 不 flush。流在工具标签中间断掉时，
        // StreamingToolCallParser 把未闭合标签留在 tail，flush() 之前它既不会
        // 变成 call 也不会被报错 —— 工具静默不执行、无提示、不续跑，
        // 是「工具调用断流」最典型的失效模式。
        //
        // 必须放在 `if (part)` 之外：readyState=4 的那次回调通常没有新增字节
        // （part 为空、字节偏移已在上一次 3 时消费完），写在 part 分支里等于
        // 永远不执行。parser 挂在 xhr 上，跨回调保留，这里直接取。
        const tailParser = (xhr as Record<string, unknown>).__dsParser as
          | { flush: () => { calls: unknown[]; clean: string; hasUnclosedToolTag: boolean } }
          | undefined;
        if (tailParser && loopState) {
          const tailFlush = tailParser.flush();
          if (tailFlush.clean) {
            diag(`xhr parser tail flushed len=${tailFlush.clean.length} head=${tailFlush.clean.slice(0, 120)}`);
          }
          if (isActiveStream(loopState, streamId) && tailFlush.hasUnclosedToolTag) {
            // 只把已知工具名或其前缀判为未闭合，避免比较符与未知标签误报截断。
            loopState.streamTruncatedTag = true;
          }
        }
        // QD-R4-02/03/04：统一结算判定（与 fetch 路径共用同一函数）。
        // 必须在分类之前：abort 与断网同为 readyState=4/status=0，
        // classifyResponse(0) 一律 retryable/network-error；若本轮工具结果
        // 已回到 pending，onStreamEnd 照常调度续跑 → 用户按下停止后仍发出新请求。
        // QD-R5-01：透传 status，让结算函数能区分「断流」与「401/403 这类确定性失败」。
        // QD-R7-01（F4/F6）：透传本条流的序号（并发时只结算自己的流），
        // 并且结算命中不再 return 掉后面的收尾——此前 return 让 onStreamEnd 永不执行，
        // 页面侧那条助手消息永远不收尾，父节点残留 → 下一轮更容易再判错。
        const settled = settleStreamEnd?.(loopState, pending, xhr.status, streamId) === true;
        if (!settled) {
        // QD-R5-01：首轮重发链（含续跑轮）的失败由 autoContinueWithPow 的执行器
        // 分类并升级，这里不再插手——否则一次失败会被计两次预算。
        if (!loopState.inAutoContinue) {
          const firstVerdict = loopState.sseErrorSeen ?? classifyResponse(xhr.status, xhr.responseText);
          if (firstVerdict.verdict !== 'ok') {
            // QD-R5-01：首轮 retryable 失败（断连 / 5xx / 限流）先自动重试。
            // 重发由外层的 scheduleFirstAttemptResend 完成——hook 作用域里没有请求入口，
            // 也不该在这里再造一条发送路径。这里只做三件事：计预算、提示用户、
            // 把 lastChatBody 交回续跑机制（它在 loopState 上，XHR open 时已存）。
            if (firstVerdict.verdict === 'retryable') {
              // QD-R5-01：预算内原样重发，耗尽由 escalate 统一上报「已自动重试 N 次仍失败」。
              // QD-R7-01（F4）：不再手工清哨兵标记——下一条流 beginStream 时会清，
              // 并发时手工改这里正是在改「别人的」状态。
              loopState.streamActive = false;
              escalateFirstAttemptFailure?.(firstVerdict.reason, '服务器暂时无法访问');
              return;
            }
            try { loopState.chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
            loopState.chatUI?.appendError(
              firstVerdict.reason,
              firstVerdict.reason === 'network-error'
                ? (firstAttemptBudget(traceTurnId).sent > 0
                  ? `服务器暂时无法访问，已自动重试 ${firstAttemptBudget(traceTurnId).sent} 次仍失败。请检查网络后手动重试。`
                  : '服务器暂时无法访问。本轮消息不会自动重发，请检查网络后手动重试。')
                : `请求失败（${firstVerdict.reason}），本轮消息不会自动重发。`,
            );
            loopState.chatUI?.setBusy(false);
          }
        }
        }
        // 竞态修复：工具结果可能在 XHR 结束前就返回了，
        // 此时 streamActive=true 导致 scheduleAutoContinue 未触发；
        // XHR 结束后通过 onStreamEnd 回调补查 pending。
        if (typeof loopState.onStreamEnd === 'function') {
          try { loopState.onStreamEnd(); } catch { /* ignore */ }
        }
      }
      if (typeof prev === 'function') (prev as (...a: unknown[]) => unknown).apply(xhr, args);
      };
      return sendNow();
    }
    return installResponseHookAndSend();
  } as typeof proto.send;

  return () => {
    proto.open = origOpen;
    proto.send = origSend;
    // QD-R4-04 候选 a（报告第 2 节登记）：同步恢复 abort。
    // 不恢复会造成「卸载后页面 abort 行为被改写」的泄漏，属于 hook 卫生问题。
    proto.abort = origAbort;
  };
}

/**
 * 挂载薄 MAIN-world 拦截器。
 * @param sender 把工具调用投递给宿主并取回结果的回调（由 entry.ts 接到 host-client）。
 */
export function installMainWorldInterceptor(options: MainWorldInterceptorOptions): MainWorldInterceptorHandle {
  console.log('[interceptor] installed, fetch hook + XHR hook ready');
  const { sender, diag, onAssistantReply, onMemoriesUpdate, chatUI, onStreamDelta } = options;
  const pending: PendingResult[] = [];
  const d: InterceptorDiag = diag ?? (() => {});
  // v1.0：从全局变量读取初始记忆（entry.ts 在连接建立时设置）
  {
    const g = globalThis as { __studioMemories?: Array<{ id: string; type: string; name: string; content: string; tags: string[] }> };
    if (g.__studioMemories) currentMemories = g.__studioMemories;
  }
  // v0.8：自动工具循环——记住最近一次 chat 请求的 body 模板 + 当前流是否结束。
  const loopState: LoopState = { lastChatBody: null as string | null, streamActive: false, lastResponseMsgId: null as number | null, autoReplyText: '', inAutoContinue: false, autoReplyHadTools: false, streamHadTools: false, originalTask: '', chatUI };
  let autoContinueTimer: ReturnType<typeof setTimeout> | null = null;
  let loopDepth = 0;
  // v1.6：跨整个循环累积的工具执行结果（对标 deepseek-pp collectedExecutions）。
  // pending 每轮清空（防 XHR hook 重复注入），collectedExecutions 保留到循环结束，
  // 让续跑 prompt 带完整历史，模型不会从第 2 步起忘了之前做了什么。
  // originalTask 存在 loopState.originalTask（XHR/fetch hook 要写入，在闭包外访问）。
  const collectedExecutions: PendingResult[] = [];
  // QD-R8：同一条流可能被重复消费；相同 callId 只允许投递一次。
  const toolCallDedupe = createToolCallDedupe();
  loopState.onStreamBegin = () => toolCallDedupe.resetSignatures();
  // R0-R2：独立错误重试计数（429/网络错误/5xx/200 错误体），
  // 封顶 MAX_ERROR_RETRIES，防止服务器错误消耗整轮续跑预算。
  let errorRetryCount = 0;
  // v0.9 POW：捕获页面正常请求的 headers（Authorization / X-App-Version 等）
  const capturedHeaders: Record<string, string> = {};

  // QD-R2-09/10：finishStepFlow 提到外层作用域，pow 与 nudge 共用。
  // 原定义在 autoContinueWithPow 的 xhr executor 里是局部常量，nudge 拿不到 → nudge fatal 时 UI 永不复位。
  const finishStepFlow = (error?: { code: string; message?: string }): void => {
    if (stepFlow) {
      stepFlow.finish(stepFlowStep + 1, stepFlowToolCount, Math.round((Date.now() - stepFlowStartTime) / 1000));
      const sf = stepFlow;
      stepFlow = null;
      stepFlowStep = 0;
      stepFlowToolCount = 0;
      setTimeout(() => sf.destroy(), 3000);
    }
    chatUI?.setBusy(false);
    // QD-R2-09：错误路径上 assistant 气泡收尾，否则上一轮 startAssistantMessage 建的容器
    // 永远挂着闪烁光标（视觉上「还在输出」）。
    try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
    if (error) chatUI?.appendError(error.code, error.message);
  };
/**
 * QD-R4-02/03/04：流结束时的统一结算判定。
 *
 * 三处「断流」缺陷的共性是：XHR 与 fetch 两条路径各自收尾，判定只写在 XHR 一侧
 * （`isDone` 分支），fetch 路径完全没有——工具标签被截断、流无完成哨兵、
 * 用户主动停止，在 fetch 路径上依旧静默无反馈。
 *
 * 抽成共享函数让两条路径走同一套语义；返回 true 表示「本轮已定性，不必再走外层分类」。
 * 注意（QD-R7-01 / F6）：返回 true **不再**表示调用方要跳过收尾——onStreamEnd 必须照常执行，
 * 否则页面侧那条助手消息永远不收尾，父节点残留会污染下一轮判定。
 */
  function settleStreamEnd(
    loopState: LoopState,
    pending: PendingResult[],
    httpStatus?: number,
    streamId?: number,
  ): boolean {
    // QD-R7-01（F4）：只结算「当前被认领的那条流」。并发时晚到的旧流若也结算，
    // 读到的就是别人的 streamSawDone / streamBytes —— 实测 243ms 内三次结算、
    // 零真实重试，就是这条路径。旧流到此为止：不动 UI、不动预算。
    if (streamId !== undefined && streamId !== STREAM_UNCLAIMED && loopState.activeStreamId !== streamId) {
      d(`stream end: stale stream #${streamId} (active=#${String(loopState.activeStreamId)}), skip settle`);
      return true;
    }
    // R4-04：用户主动停止是预期行为，不叠加「截断」提示，也不续跑。
    if (loopState.abortedByUser) {
      d('stream end: aborted by user, stop without retry/continuation');
      if (loopState.cancelAutoContinue) loopState.cancelAutoContinue();
      const timer = loopState.autoContinueTimerRef;
      if (timer) { clearTimeout(timer); loopState.autoContinueTimerRef = null; }
      continuationRetryPending = false;
      pending.length = 0;
      interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'user-aborted', triggered: false });
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'user-aborted' });
      try { loopState.chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
      loopState.chatUI?.setBusy(false);
      return true;
    }
    // R4-02：半截工具标签一定伴随无哨兵（流断了），但反过来不成立。
    // 先报更具体的那个，用户才知道是「模型想调工具但没调成」。
    if (loopState.streamTruncatedTag) {
      d('stream end: truncated tool tag detected, report to user');
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'truncated-tool-tag' });
      try { loopState.chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
      loopState.chatUI?.appendError(
        'tool-call-truncated',
        '模型输出的工具调用被网络中断截断，本轮不会自动重试。请重新发送该请求。',
      );
      loopState.chatUI?.setBusy(false);
      return true;
    }
    // QD-R7-01（F2）：三态判定 —— complete / truncated / no-stream。
    // 0 字节说明这一轮根本没有流（非对话 XHR、被 abort 的空请求、空响应体），
    // 既不是截断、也不该消耗首轮重试预算。此前一律按「无哨兵 = 断流」处理，
    // 于是每个空 XHR 都烧一次预算并 append 一张错误卡 —— 就是「满屏执行未完成」。
    if (!loopState.streamSawDone && (loopState.streamBytes ?? 0) === 0) {
      d('stream end: no bytes received (no-stream), not a truncation');
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'no-stream' });
      // 交回外层：classifyResponse 会给 401/403/5xx 正确文案；200 空响应则静默放行。
      return false;
    }
    // R4-03：无完成哨兵 = 流被截断。此前这种轮次被当成「正常完成」收尾。
    // R4-03: no completion sentinel = stream truncated.
    // QD-R5-01: retry a first-attempt break before surfacing it.
    if (!loopState.streamSawDone) {
      // QD-R5-01 修正：确定性 HTTP 失败不是断流。401/403/402/4xx 重发同一份 body
      // 必然同样失败，还会把「鉴权失败」误报成「连接中断」——此前正是如此。
      // 交回外层 classifyResponse 出正确文案，不占用首轮重试预算。
      const httpVerdict = httpStatus === undefined ? null : classifyResponse(httpStatus, null);
      if (httpVerdict?.verdict === 'fatal') {
        d(`stream end: no sentinel but http ${httpStatus} is ${httpVerdict.reason}, defer to classifier`);
        return false;
      }
      // 续跑轮（含首轮重发链）由 autoContinueWithPow 的执行器分类，
      // 这里只负责首轮原始请求，否则会抢在业务 handler 之前把它吃掉。
      if (loopState.inAutoContinue) return false;
      d(`stream end: no completion sentinel, bytes=${loopState.streamBytes ?? 0}, retries-sent=${firstAttemptBudget(traceTurnId).sent}`);
      // W1 清理：原 1480-1489 的 stream-incomplete appendError 包装在此处不可达——
      // 1469 已对 inAutoContinue 续跑轮 return false，1471 的 !inAutoContinue 恒真并在 1478 return。
      // 首轮流断的 UX 文案由 1474 escalateFirstAttemptFailure 统一上报，不重复 appendError。
      if (!loopState.inAutoContinue) {
        // status=0/429/5xx 与 200 截断在回调层同构，只有原样重发才能区分
        // 「网络抖动」和「模型半句截断」。预算内重发，耗尽由 escalate 统一上报。
        escalateFirstAttemptFailure(
          httpVerdict?.verdict === 'retryable' ? httpVerdict.reason : 'stream-incomplete',
          httpVerdict?.verdict === 'retryable' ? '服务器暂时无法访问' : '模型回复未完整接收（连接中断）',
        );
        return true;
      }
    }
    return false;
  }

  const forward = (call: ParsedToolCall): void => {
    console.log('[interceptor] forward:', call.invocationName, JSON.stringify(call.params).slice(0, 150));
    d(`forward: ${call.invocationName} params=${JSON.stringify(call.params).slice(0, 200)}`);
    if (!isSupportedUpstreamTool(call.invocationName)) {
      d(`forward: unsupported, skipping`);
      return;
    }
    const callId = call.id || crypto.randomUUID();
    if (!toolCallDedupe.claim(callId)) {
      d(`forward: duplicate callId=${callId}, skip (same turn)`);
      return;
    }
    if (!toolCallDedupe.claimSignature(call.invocationName, call.params)) {
      d(`forward: duplicate signature name=${call.invocationName}, skip (same stream)`);
      interceptorTrace.record({
        t: 'continuation.decision',
        turnId: traceTurnId,
        reason: 'duplicate-tool-signature',
        triggered: false,
      });
      return;
    }
    const startedAt = Date.now();
    interceptorTrace.record({
      t: 'tool.parsed',
      turnId: traceTurnId,
      name: call.invocationName,
      status: call.params && call.params.__invalid_json ? 'invalid-json' : 'ok',
    });
    // v1.6：auto-continue 期间检测到工具调用 → 标记，readyState===4 时据此走续跑而非 nudge。
    loopState.streamHadTools = true;
    if (loopState.inAutoContinue) loopState.autoReplyHadTools = true;

    const cardData = { toolName: call.invocationName, params: call.params as Record<string, unknown> };
    // DOM 隔离：只写 Studio 自有助手节点；没有 Studio 根节点时跳过，绝不回退到原生消息 DOM。
    try {
      if (!chatUI?.startToolCard(callId, cardData)) {
        d('forward: no studio assistant root, skip tool card render');
      }
    } catch (e) {
      d(`forward: studio tool card failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // v1.3：步骤流 UI —— 第一次工具调用时创建状态栏（固定在输入框上方，不随对话滚动）
    if (!stepFlow && !chatUI) {
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
    // F3 修复：JSON 解析失败的工具调用，直接回填错误，不投递宿主
    if (call.params && call.params.__invalid_json) {
      d(`forward: invalid JSON for ${call.invocationName}, err=${call.params.__error}`);
      const r: PendingResult = {
        invocationName: call.invocationName,
        ok: false,
        error: `invalid-tool-json: ${call.params.__error}. Raw body: ${String(call.params.__raw ?? '').slice(0, 300)}`,
        sessionId: loopState.newChatSessionId,
      };
      pending.push(r);
      collectedExecutions.push(r);
      try {
        chatUI?.finishToolCard(
          callId,
          cardData,
          { ok: false, error: `invalid-tool-json: ${call.params.__error}` },
          Date.now() - startedAt,
        );
      } catch { /* ignore */ }
      interceptorTrace.record({ t: 'tool.exec', turnId: traceTurnId, name: call.invocationName, ok: false, durationMs: Date.now() - startedAt });
      if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
        scheduleAutoContinue();
      }
      return;
    }
    // R-W2：sender 异步 resolve 时 newChatSessionId 可能已切到别的会话，
    // 必须在调用 sender 那一刻捕获归属会话，否则迟到结果会错挂到当前会话。
    const sessionAtCall = loopState.newChatSessionId;
    void sender({
      callId,
      invocationName: call.invocationName,
      params: call.params,
      // 捕获调用那一刻的会话标识；换对话后宿主不再沿用旧的对话级放行。
      ...(sessionAtCall ? { conversationId: sessionAtCall } : {}),
    })
      .then((r: ExecuteResult) => {
        d(`forward: done ok=${r.ok} err=${r.error ?? ''}`);
        const pr: PendingResult = { invocationName: call.invocationName, ok: r.ok, result: r.data, error: r.error, sessionId: sessionAtCall };
        pending.push(pr);
        collectedExecutions.push(pr);
        // v1.3：更新步骤流工具条目
        if (stepFlow) {
          const detail = r.error ?? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? '').slice(0, 500));
          stepFlow.resolveToolEntry(stepFlowStep, r.ok, detail);
        }
        try {
          chatUI?.finishToolCard(
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
        interceptorTrace.record({ t: 'tool.exec', turnId: traceTurnId, name: call.invocationName, ok: r.ok, durationMs: Date.now() - startedAt });
        if (!loopState.streamActive && loopState.lastChatBody && loopDepth < MAX_LOOP) {
          scheduleAutoContinue();
        }
      })
      .catch((e: unknown) => {
        d(`forward: failed ${e instanceof Error ? e.message : String(e)}`);
        const pr: PendingResult = { invocationName: call.invocationName, ok: false, error: e instanceof Error ? e.message : String(e), sessionId: loopState.newChatSessionId };
        pending.push(pr);
        collectedExecutions.push(pr);
        // v1.3：更新步骤流工具条目
        if (stepFlow) {
          stepFlow.resolveToolEntry(stepFlowStep, false, e instanceof Error ? e.message : String(e));
        }
        try {
          chatUI?.finishToolCard(
            callId,
            cardData,
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            Date.now() - startedAt,
          );
        } catch { /* ignore */ }
        interceptorTrace.record({ t: 'tool.exec', turnId: traceTurnId, name: call.invocationName, ok: false, durationMs: Date.now() - startedAt });
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
      // QD-R8-01：terminate 是「循环正常结束」的第三条退出路径。此前直接 return，
      // 既不复位状态栏也不收尾消息 —— 与普通回合同一种「永停执行中」。
      interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'terminate', triggered: false });
      finishStepFlow();
      loopDepth = 0;
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: true, stopReason: 'terminate' });
      return;
    }
    // MAX_AUTO_CONTINUE（移植 dpp）：空转续轮独立封顶。
    // 本轮无工具结果却仍要续跑 = 模型吐一半断流的空转，最多 3 次；含工具的正式续跑走 MAX_LOOP。
    //
    // QD-R4-03：此前这个分支是死代码 —— 全部调用点都保证 pending>0，
    // 且即便执行，1s 后的定时器回调也会被 autoContinueWithPow 的 pending 守卫 return。
    // R4-01 给守卫加了 continuationRetryPending 豁免，这里显式置位该标志，
    // 让「工具调用被截断、结果还没回来」的空转续跑真正能发出去。
    if (pending.length === 0) {
      idleContinueCount += 1;
      if (idleContinueCount > MAX_AUTO_CONTINUE) {
        d(`auto-continue idle cap reached ${idleContinueCount}/${MAX_AUTO_CONTINUE}, stop`);
        interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'auto-continue-max', triggered: false });
        interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'auto-continue-max' });
        finishStepFlow({
          code: 'stream-cut',
          message: `模型连续 ${MAX_AUTO_CONTINUE} 次输出不完整，已停止自动续跑。可以手动重试或换个说法。`,
        });
        loopDepth = 0;
        return;
      }
      continuationRetryPending = true;
    }
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
    autoContinueTimer = setTimeout(() => {
      autoContinueTimer = null;
      void autoContinueWithPow();
    }, 1000);
  }

  /**
   * QD-R5-01：安排一次「原样重发上一份 chat 请求体」。
   *
   * 与 scheduleAutoContinue 的区别：那条路径发的是「续跑 prompt」（带原始任务 +
   * 窗口化工具历史）。首轮失败时还没有任何工具结果，套续跑 prompt 等于把
   * 「重发同一个问题」变成「拿着空 <tool_results> 的续跑」。
   */
  function scheduleFirstAttemptResend(delayMs?: number): void {
    firstAttemptResendActive = true;
    firstAttemptResendPending = true;
    // 豁免 autoContinueWithPow 的 pending 守卫（重发不依赖 pending）。
    continuationRetryPending = true;
    if (autoContinueTimer) clearTimeout(autoContinueTimer);
    autoContinueTimer = setTimeout(() => {
      autoContinueTimer = null;
      void autoContinueWithPow();
    }, delayMs ?? 1000);
  }

  /**
   * QD-R5-01：首轮（非续跑）失败的统一升级点。
   *
   * 修复前这里只有 appendError + setBusy(false)：一次网络抖动就要用户手动重发，
   * 这正是「满屏 服务器暂时无法访问 / stream-incomplete」的成因。
   *
   * 预算内 → 退避后原样重发；耗尽 → 收尾并明确告知已重试几次（不再假装没试过）。
   * 注意（QD-R7-01 / F10）：预算按「重试请求真实发出的次数」结算（sent），
   * 「已排入队列的次数」（scheduled）只用来防止「发不出去却无限排队」。
   * 修复前是在这里就 +1，于是三次结算就能烧穿 2 次预算、报出从未发生过的重试。
   * @param code UI 错误码
   * @param why  失败原因的中文主语（「服务器暂时无法访问」/「模型回复未完整接收（连接中断）」）
   */
  function escalateFirstAttemptFailure(code: string, why: string): void {
    if (loopState.abortedByUser) {
      d('first-attempt failure suppressed: user aborted this turn');
      firstAttemptResendActive = false;
      firstAttemptResendPending = false;
      return;
    }
    const budget = firstAttemptBudget(traceTurnId);
    if (budget.sent >= FIRST_ATTEMPT_MAX_RETRIES || budget.scheduled >= FIRST_ATTEMPT_MAX_RETRIES + 1) {
      d(`first-attempt retryable: reason=${code} budget out (sent=${budget.sent} scheduled=${budget.scheduled})`);
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'first-attempt-retry-out' });
      loopState.streamActive = false;
      firstAttemptResendActive = false;
      firstAttemptResendPending = false;
      try { loopState.chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
      loopState.chatUI?.appendError(
        code,
        `${why}，已自动重试 ${budget.sent} 次仍失败。请检查网络后手动重试。`,
      );
      loopState.chatUI?.setBusy(false);
      return;
    }
    budget.scheduled += 1;
    const delay = errorBackoffMs(budget.scheduled - 1);
    d(`first-attempt retryable: reason=${code} scheduled retry ${budget.scheduled}/${FIRST_ATTEMPT_MAX_RETRIES} in ${delay}ms (sent so far=${budget.sent})`);
    interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'first-attempt-retry', triggered: true });
    loopState.streamActive = false;
    try { loopState.chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
    loopState.chatUI?.appendError(
      code,
      `${why}，正在自动重试（${budget.scheduled}/${FIRST_ATTEMPT_MAX_RETRIES}）...`,
    );
    scheduleFirstAttemptResend(delay);
  }

  // 竞态修复：流结束时补查 pending，工具结果先于流结束返回时触发续跑
  loopState.onStreamEnd = () => {
    if ((pending.length > 0 || loopState.streamHadTools) && loopState.lastChatBody && loopDepth < MAX_LOOP) {
      if (pending.length > 0) scheduleAutoContinue();
      interceptorTrace.record({
        t: 'continuation.decision',
        turnId: traceTurnId,
        reason: pending.length > 0 ? 'tools-pending' : 'tools-returned',
        triggered: pending.length > 0,
      });
      // 合并回合：工具续跑期间保持同一助手消息打开，过程与正文在同一消息里按叙事流累积；
      // 消息只在循环真正结束（无工具续跑）或错误路径时收尾。
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
      // 注意：stepFlow 只在 `!chatUI` 时创建（见 forward），所以这里没有状态栏可复位；
      // 有 chatUI 的路径一律走下面那条分支。
      interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'no-tools', triggered: false });
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: true, stopReason: 'completed' });
    } else if (chatUI && !loopState.inAutoContinue) {
      // 无工具/无续跑的普通回合，在 XHR 流结束时完成 Markdown 定稿。
      try { chatUI.finishAssistantMessage(); } catch { /* ignore */ }
      // QD-R8-01：现场（2026-10-23 19:06:50）—— 纯问答回合走到这里就结束了，
      // 而这条分支此前只调 finishAssistantMessage，从不调 setBusy(false)。
      // 于是状态栏永远停在「执行中…」，用户以为任务还在跑，实际早已没有请求。
      // 这是「没有调用工具、也没有报错，但 UI 一直转」的直接成因。
      //
      // 但「这一轮真的结束」不能只看走到了这条分支：首轮断流的原样重发、
      // 以及排队的续跑，都会先经过 onStreamEnd 再在定时器里发新请求。
      // 那些情况下 busy 必须保持 true（QD-R4-03 已钉：重试期间不得复位），
      // 否则状态栏在重试退避窗口里闪一下「完成」，用户会以为已经结束。
      const stillRunning = firstAttemptResendActive
        || firstAttemptResendPending
        || continuationRetryPending
        || autoContinueTimer !== null;
      if (!stillRunning) {
        try { chatUI.setBusy(false); } catch { /* ignore */ }
      }
      // 本轮既没有可见正文、也没有工具 → 用户什么都看不到，必须显式告知。
      // QD-R8-01：判据用 streamHadVisibleText（本轮流真正推送过的正文），不能用
      // autoReplyText —— 后者只在 inAutoContinue 时累积，普通回合恒为空，
      // 会把「正常回答」也误判成空回复。
      // 只在「见到了完成哨兵」时才报：0 字节的 no-stream 是另一类（R7-02 要求静默、
      // 不吃重试预算），不能混进来，否则会把「请求根本没通」说成「模型没说话」。
      if (!stillRunning && loopState.streamSawDone && !loopState.streamHadVisibleText && !loopState.streamHadTools) {
        d('stream end: completed with empty reply (no text, no tools)');
        try {
          chatUI.appendError(
            'empty-reply',
            '模型这一轮没有输出任何可见内容（可能只产生了思考，或回复被上游吞掉）。'
            + '本轮已结束，可以直接重新发送。',
          );
        } catch { /* ignore */ }
      }
      interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'no-tools', triggered: false });
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: true, stopReason: 'completed' });
    }
  };

  // v1.6：新用户消息到达 → 重置循环累积状态（hook 函数在闭包外，只能经此回调通知）。
  // v0.19：同时把用户消息推送给 chat UI，并创建新的助手回复流式容器。
  // QD-R4-04：把「取消在飞续跑」暴露给 XHR hook（用户 abort 分支用）。
  loopState.cancelAutoContinue = () => {
    if (autoContinueTimer) { clearTimeout(autoContinueTimer); autoContinueTimer = null; }
    continuationRetryPending = false;
    loopState.protocolRepairUsed = false;
    loopState.protocolRepairPending = false;
    loopState.autoContinueTimerRef = autoContinueTimer;
  };
  loopState.onNewUserMessage = () => {
    // QD-R4-05：新用户消息必须继承一张干净的桌面。
    // 上一回合 pending 里的迟到工具结果会被 prepareOutgoingBody 当成本轮上下文
    // 注入 prompt 尾部（`【工具执行结果】[tool-result:shell_exec] ok`），
    // 模型把 A 的结果当成 B 的前提继续推理；1s 续跑定时器若仍存活，
    // 还会用 B 的 lastChatBody 发出一次「续跑 B」的并发请求。
    // 只靠 onNewUserMessage 触发时机清是不够的——captureChatRequest 识别到
    // 新用户消息时先回本回调，prepareOutgoingBody 才在 XHR/fetch hook 里跑，
    // 所以这里清了，本次请求体就是干净的。
    pending.length = 0;
    if (autoContinueTimer) { clearTimeout(autoContinueTimer); autoContinueTimer = null; }
    continuationRetryPending = false;
    idleContinueCount = 0;
    collectedExecutions.length = 0;
    toolCallDedupe.reset();
    loopDepth = 0;
    errorRetryCount = 0;
    // QD-R7-01（F9）：首轮重试预算随轮次作废，不再是一个全局数字。
    firstAttemptBudgets.delete(traceTurnId);
    firstAttemptResendActive = false;
    firstAttemptResendPending = false;
    loopState.protocolRepairUsed = false;
    loopState.protocolRepairPending = false;
    loopState.sseErrorSeen = null;
    loopState.autoReplyHadTools = false;
    loopState.streamHadTools = false;
    loopState.streamHadVisibleText = false;
    // QD-R7-01（F4）：把上一回合可能仍在飞的流一律作废（unclaim），
    // 它的回调此后再结算就会发现自己是 stale，不会动新回合的 UI/预算。
    loopState.activeStreamId = STREAM_UNCLAIMED;
    loopState.streamBytes = 0;
    loopState.streamSawDone = false;
    loopState.streamTruncatedTag = false;
    loopState.streamHadVisibleText = false;
    loopState.abortedByUser = false;
    // 上一回合的临时桶可能还带着历史事件。新回合开始前显式把 UI 切到干净的
    // route: 会话，否则新对话时上一段结果会残留在消息列表里。
    if (chatUI && chatUI.sessionKey.startsWith('route:')) {
      void chatUI.activateSession(chatUI.sessionKey);
    }
    d('new user message: reset collectedExecutions/loopDepth/errorRetryCount');
    if (chatUI) {
      if (loopState.newChatSessionId) {
        const nextKey = normalizeChatSessionKey(loopState.newChatSessionId);
        const migrateFrom = chatUI.sessionKey.startsWith('route:') ? chatUI.sessionKey : undefined;
        void chatUI.activateSession(nextKey, { migrateFrom });
      }
      if (loopState.newUserPrompt) {
        chatUI.addUserMessage(loopState.newUserPrompt);
      }
      chatUI.startAssistantMessage();
      chatUI.setBusy(true);
    }
  };

  async function autoContinueWithPow(): Promise<void> {
    // QD-R4-01：重试入口豁免 pending 守卫。
    // 续跑发出前 pending 已被清空（F8 修复），若此处仍要求 pending>0，
    // 429/5xx/断网后的退避定时器回调会被第一行守卫挡死，一次重试都发不出去。
    if (!loopState.lastChatBody) return;
    if (pending.length === 0 && !continuationRetryPending && !loopState.protocolRepairPending) return;
    const isProtocolRepair = loopState.protocolRepairPending === true;
    loopState.protocolRepairPending = false;
    // QD-R5-01：首轮重发必须原样重发。套上 <original_task>/<tool_results> 会把
    // 「重发同一个问题」变成「拿着空工具结果的续跑」，模型的回答会漂。
    const resendVerbatim = firstAttemptResendPending;
    firstAttemptResendPending = false;
    if (resendVerbatim) loopState.inFirstAttemptResend = true;
    // QD-R4-04：用户主动停止后，任何续跑（含定时器回调）一律不再发出。
    if (loopState.abortedByUser) {
      d('auto-continue suppressed: user aborted this turn');
      continuationRetryPending = false;
      return;
    }
    // 重试不应消耗 loopDepth：它是「工具续跑」的步数预算，
    // 一次 429 就吃掉一步会让真正的工具轮次被提前耗尽。
    if (!continuationRetryPending && !isProtocolRepair) loopDepth += 1;
    continuationRetryPending = false;
    if (!resendVerbatim && !isProtocolRepair) loopDepth += 1;
    // v0.18：步骤编号随续跑递增，工具归到对应步骤
    stepFlowStep = loopDepth;
    stepReasoningAccum = '';
    loopState.streamActive = true;
    loopState.autoReplyHadTools = false;
    loopState.streamHadTools = false;
    // QD-R7-01（F4）：作废上一条流（如果有），哨兵/截断/字节计数由随后的
    // beginStream 在认领新流时统一清零 —— 这里不再手工写三个共享标记。
    loopState.activeStreamId = STREAM_UNCLAIMED;
    loopState.streamBytes = 0;
    loopState.streamSawDone = false;
    loopState.streamTruncatedTag = false;
    // 合并回合：不再每轮续跑新建"回合 N"气泡；当前消息在 onStreamEnd 保持打开，
    // 若被错误路径提前收尾，appendToAssistantMessage/startToolCard 会自动补开一条。
    try {
      // v1.6：续跑 prompt 带原始任务 + 窗口化全部历史 + 工具目录（移植自 deepseek-pp
      // buildContinuationPrompt）。collectedExecutions 跨循环累积，pending 只是本轮回填缓冲。
      // 模型从此知道：用户要什么（originalTask）、之前做了什么（collectedExecutions）、还能用什么工具。
      // R-W2：按当前请求 body 的 chat_session_id 过滤 collectedExecutions，
      // 丢弃他会话迟到的工具结果（A 的 sender 在切会话后才 resolve，会污染 B 的续跑 prompt）。
      const rawCurrentForExec = extractChatSessionIdFromBody(loopState.lastChatBody ?? '');
      const currentSessionForExec = rawCurrentForExec ? normalizeChatSessionKey(rawCurrentForExec) : undefined;
      const execForThisTurn = currentSessionForExec
        ? collectedExecutions.filter((e) => !e.sessionId || e.sessionId === currentSessionForExec)
        : collectedExecutions;
      if (execForThisTurn.length !== collectedExecutions.length) {
        const dropped = collectedExecutions.filter((e) => e.sessionId && e.sessionId !== currentSessionForExec);
        interceptorTrace.record({
          t: 'pending.cross-session',
          turnId: traceTurnId,
          current: currentSessionForExec ?? '',
          droppedCount: dropped.length,
          droppedNames: dropped.map((d) => d.invocationName),
        });
      }
      const continuationPrompt = isProtocolRepair
        ? buildProtocolRepairPrompt(loopState.originalTask, execForThisTurn, TOOL_CATALOG_TEXT)
        : buildContinuationPrompt(loopState.originalTask, execForThisTurn, TOOL_CATALOG_TEXT);

      // F8 修复：清空 pending，避免 XHR hook 的 prepareOutgoingBody 再追加一份工具结果。
      // collectedExecutions 不清，续跑 prompt 要用完整历史。
      pending.length = 0;

      let bodyStr = loopState.lastChatBody;
      if (resendVerbatim) {
        // QD-R7-01（F8）：重试必须幂等 —— 逐字节重发上一份 body，不做任何改写。
        // 修复前这里会把 parent_message_id 改写成上一轮的 response_message_id（即那条
        // 没写完的消息），于是「重发同一个问题」变成「接在残句后面继续生成」：
        // 重试不是原样重放，失败会自我放大，父节点也被污染。
        // 也不做 JSON 往返 —— JSON.parse→stringify 会丢掉原始空白与键序，不再逐字节相等。
        d(`first-attempt retry: resend lastChatBody verbatim (retry #${firstAttemptBudget(traceTurnId).scheduled}/${FIRST_ATTEMPT_MAX_RETRIES})`);
      } else {
        try {
          const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
          parsed.prompt = continuationPrompt;
          // 续跑路径保留父节点改写：这才是「接着上一条消息继续」，语义正确。
          if (loopState.lastResponseMsgId != null) {
            parsed.parent_message_id = loopState.lastResponseMsgId;
          }
          bodyStr = JSON.stringify(parsed);
        } catch { /* keep original */ }
      }

      interceptorTrace.record({ t: 'request.sent', turnId: traceTurnId, bytes: byteLengthOf(bodyStr) });
      reportContextBudget(bodyStr, loopState.chatUI);
      d(`auto-continue loop=${loopDepth} computing PoW... capturedHeaders=${JSON.stringify(Object.keys(capturedHeaders))}`);

      // 重放头：统一使用白名单，剔除 x-hif-*、Cookie、CSRF、旧 PoW 等一次性凭证。
      const filteredHeaders = filterReplayableHeaders(capturedHeaders);

      // 算 POW headers
      const powHeaders = await createPowHeaders(filteredHeaders);
      d(`auto-continue loop=${loopDepth} PoW done, sending...`);

      // 用 XHR 发（和页面正常请求一样），带 captured headers + POW
      // v0.9：标记 auto-continue 模式，让 XHR hook 累积回复文本（不渲染到 DOM）
      loopState.inAutoContinue = true;
      loopState.autoReplyText = '';
      loopState.sseErrorSeen = null;
      await new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/v0/chat/completion', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        for (const [k, v] of Object.entries(filteredHeaders)) {
          if (k.toLowerCase() === 'content-type') continue;
          try { xhr.setRequestHeader(k, v); } catch { /* ignore */ }
        }
        for (const [k, v] of Object.entries(powHeaders)) {
          // QD-R7-01（F15）：powHeaders 里自带一个 Content-Type（pow.ts:112），
          // 上面已经显式设过一次，这里再设一次会被拼成
          // `Content-Type: application/json, application/json` → 服务端 422
          // → 自动续跑直接掐死。第一条循环早有这个 continue，第二条漏了。
          if (k.toLowerCase() === 'content-type') continue;
          try { xhr.setRequestHeader(k, v); } catch { /* ignore */ }
        }
        // QD-R2-09/10：收尾统一走外层 finishStepFlow（含 finishAssistantMessage）。
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4) {
            d(`auto-continue loop=${loopDepth} status=${xhr.status} autoReplyLen=${loopState.autoReplyText.length} inAuto=${loopState.inAutoContinue}`);
            loopState.inAutoContinue = false;
            // 正常完成后必须重置 streamActive，否则后续工具结果无法触发续跑
            loopState.streamActive = false;
            // W0：续跑轮哨兵观测（纯观测，不改任何返回值/分支/文案）。
            // streamSawDone / streamBytes 由流内 SSE parser 在本轮续跑 XHR 上累积，
            // readyState===4 时反映「续跑响应是否真正带 [DONE] 哨兵」。
            interceptorTrace.record({
              t: 'continuation.stream',
              turnId: traceTurnId,
              sawSentinel: !!loopState.streamSawDone,
              bytes: loopState.streamBytes ?? 0,
              status: xhr.status,
            });
            // v0.9：把 auto-continue 收到的模型回复推送给宿主（不渲染到 DOM）
            const reply = loopState.autoReplyText.trim();
            const hadTools = loopState.autoReplyHadTools;
            d(`auto-continue reply len=${reply.length} hadTools=${hadTools} hasCallback=${typeof onAssistantReply}`);
            // R0-R2：显式分类响应，不再只认 429、其余一律当空回复 nudge。
            const httpVerdict = classifyResponse(xhr.status, xhr.responseText);
            // R0-R5：流内 SSE 错误帧优先于 HTTP 状态分类（200 内嵌错误也按错误处理）。
            const verdict = loopState.sseErrorSeen ?? httpVerdict;
            recordVerdict({ status: xhr.status, verdict: verdict.verdict, reason: verdict.reason, attempt: errorRetryCount });
            // QD-R5-01：首轮重发链的失败归首轮预算管。否则它会掉进续跑的
            // errorRetryCount 分支——不仅预算口径错，prompt 也会被换成续跑版。
            // 只在这里升级一次：settleStreamEnd 对续跑轮一律放行（见 R3），
            // 不会重复计数把 2 次预算一次烧光。
            if (firstAttemptResendActive) {
              firstAttemptResendActive = false;
              loopState.streamActive = false;
              try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
              if (verdict.verdict === 'fatal') {
                // 重发后撞上 401/403/402：再重发必然同样失败，直接停。
                interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'first-attempt-fatal' });
                finishStepFlow({
                  code: verdict.reason,
                  message: `请求失败（${verdict.reason}），已停止重试。`,
                });
                loopDepth = 0;
              } else if (verdict.verdict === 'retryable') {
                escalateFirstAttemptFailure(verdict.reason, '服务器暂时无法访问');
              }
              resolve();
              return;
            }
            // R-W1：截断判定提前算成布尔，便于在封顶判断里与 retryable 同预算口径。
            // 此前截断分支在 verdict 链之后，verdict==='ok' 命不到 :2030 的 retryable 封顶，
            // 导致持续截断时 errorRetryCount 无界自增。
            const isTruncated =
              !loopState.streamSawDone &&
              (loopState.streamBytes ?? 0) > 0 &&
              xhr.status >= 200 && xhr.status < 300;
            const budgetExhausted =
              verdict.verdict === 'fatal' ||
              (verdict.verdict === 'retryable' && errorRetryCount >= MAX_ERROR_RETRIES) ||
              (isTruncated && errorRetryCount >= MAX_ERROR_RETRIES);
            if (budgetExhausted) {
              // 不可重试（401/403/402/400）或错误预算耗尽（含持续截断）→ 停手上报。
              const stopReason = isTruncated ? 'continuation-truncated' : verdict.reason;
              d(`auto-continue ${stopReason}: status=${xhr.status} retries=${errorRetryCount}/${MAX_ERROR_RETRIES}, stop loop`);
              loopState.streamActive = false;
              interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: isTruncated ? 'continuation-truncated-budget-out' : 'error-budget-out', triggered: false });
              interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason });
              finishStepFlow({
                code: stopReason,
                message: isTruncated
                  ? `模型回复持续不完整（${MAX_ERROR_RETRIES} 次重发仍截断），已停止自动续跑。请手动重试。`
                  : verdict.reason === 'network-error'
                    ? '服务器暂时无法访问，已停止自动续跑。请检查网络后手动重试。'
                    : `自动续跑失败（${verdict.reason}），已停止重试。`,
              });
              loopDepth = 0;
            } else if (verdict.verdict === 'retryable') {
              // 429/断连/5xx/200错误体：独立错误预算 + 指数退避，不占用工具续跑/nudge 预算。
              errorRetryCount += 1;
              loopState.streamActive = false;
              try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
              if (autoContinueTimer) clearTimeout(autoContinueTimer);
              const delay = verdict.retryAfterMs ?? errorBackoffMs(errorRetryCount - 1);
              d(`auto-continue retryable: status=${xhr.status} reason=${verdict.reason}, retry ${errorRetryCount}/${MAX_ERROR_RETRIES} in ${delay}ms`);
              // QD-R4-01：标记重试入口，否则定时器回调会被 autoContinueWithPow 的
              // pending 守卫挡死（pending 在发出续跑前已清空）。
              continuationRetryPending = true;
              autoContinueTimer = setTimeout(() => { autoContinueTimer = null; void autoContinueWithPow(); }, delay);
              interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: `error-retry-${verdict.reason}`, triggered: true });
            } else if (isTruncated) {
              // W1/R-W1：续跑轮 2xx 但无完成哨兵 = 流被截断。预算已在上方封顶判断里校验。
              // 走与 retryable 同构的退避重发（continuationRetryPending=true），不记 completed。
              errorRetryCount += 1;
              loopState.streamActive = false;
              try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
              if (autoContinueTimer) clearTimeout(autoContinueTimer);
              const delay = errorBackoffMs(errorRetryCount - 1);
              d(`auto-continue truncated continuation: bytes=${loopState.streamBytes}, retry ${errorRetryCount}/${MAX_ERROR_RETRIES} in ${delay}ms`);
              continuationRetryPending = true;
              autoContinueTimer = setTimeout(() => { autoContinueTimer = null; void autoContinueWithPow(); }, delay);
              interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'continuation-truncated', triggered: true });
            } else if (loopDepth >= MAX_LOOP) {
              // 达工具续跑步数上限：正常结束。
              d('auto-continue reached MAX_LOOP, stop');
              interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'loop-depth-max', triggered: false });
              interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'max-loop' });
              const cleanReply = stripRawToolTags(reply).trim();
              if (!hadTools && cleanReply) {
                try { chatUI?.finishAssistantMessage({ fallbackText: cleanReply, recordFinal: true }); } catch { /* ignore */ }
                try { onAssistantReply?.(cleanReply, loopDepth); } catch (e) { d(`auto-continue max-round push failed: ${(e as Error).message}`); }
              } else {
                try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
              }
              finishStepFlow();
              loopDepth = 0;
            } else {
              // 成功轮次重置错误预算；否则一次历史 429 会让后续正常轮次过早进入 fatal。
              errorRetryCount = 0;
              firstAttemptResendActive = false;
              // M3-1a：nudge 机制已删。无工具调用时不再逼模型再调工具，
              // 直接结束循环——内核 TaskLoop 自驱（M2-3）取代了这个网页侧补丁。
              const replyForNudge = loopState.autoReplyText.trim();
              const hasTaskComplete = !!extractTaskCompleteSignal(replyForNudge);
              if (hadTools) {
                try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
                if (pending.length > 0) {
                  // 工具结果可能早于本轮 readyState=4 返回；此处补一次调度，避免停在中间态。
                  scheduleAutoContinue();
                }
              } else {
                const incompleteReply =
                  !hasTaskComplete
                  && shouldAttemptProtocolRepair(replyForNudge, execForThisTurn, false);
                const canRepair = incompleteReply && !loopState.protocolRepairUsed;
                if (canRepair) {
                  // 半截 XML 不推给宿主，先收掉当前 UI，再用专用 prompt 修复一次协议。
                  try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
                  loopState.protocolRepairUsed = true;
                  loopState.protocolRepairPending = true;
                  d(`auto-continue protocol repair scheduled: replyLen=${replyForNudge.length}`);
                  interceptorTrace.record({
                    t: 'continuation.decision',
                    turnId: traceTurnId,
                    reason: 'protocol-repair',
                    triggered: true,
                  });
                  if (autoContinueTimer) clearTimeout(autoContinueTimer);
                  autoContinueTimer = setTimeout(() => {
                    autoContinueTimer = null;
                    void autoContinueWithPow();
                  }, 200);
                } else if (incompleteReply) {
                  // 修复轮后仍不完整：抑制半截回复，明确以协议修复失败收尾。
                  try { chatUI?.finishAssistantMessage({ recordFinal: false }); } catch { /* ignore */ }
                  d('auto-continue protocol repair failed: suppress incomplete reply');
                  finishStepFlow();
                  interceptorTrace.record({
                    t: 'turn.end',
                    turnId: traceTurnId,
                    finished: false,
                    stopReason: 'protocol-repair-failed',
                  });
                  loopDepth = 0;
                } else {
                  // 循环真正结束（无工具、task_complete 或达上限）。
                  d(`auto-continue loop end: hadTools=${hadTools} taskComplete=${hasTaskComplete}`);
                  interceptorTrace.record({ t: 'continuation.decision', turnId: traceTurnId, reason: 'no-tools', triggered: false });
                  interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: true, stopReason: 'completed' });
                  const cleanReply = stripRawToolTags(reply).trim();
                  if (cleanReply) {
                    try { chatUI?.finishAssistantMessage({ fallbackText: cleanReply, recordFinal: true }); } catch { /* ignore */ }
                    try { onAssistantReply?.(cleanReply, loopDepth); } catch (e) { d(`auto-continue push failed: ${(e as Error).message}`); }
                  } else if (reply) {
                    d('auto-continue reply all-tool-text (stripped to empty), skipping push');
                  }
                  finishStepFlow();
                  loopDepth = 0;
                }
              }
            }
            resolve();
          }
        };
        xhr.send(bodyStr);
      });
      loopState.inFirstAttemptResend = false;
    } catch (e) {
      d(`auto-continue failed: ${(e as Error).message}`);
      loopState.streamActive = false;
      interceptorTrace.record({ t: 'turn.end', turnId: traceTurnId, finished: false, stopReason: 'auto-continue-failed' });
      const message = e instanceof Error ? e.message : String(e);
      finishStepFlow({
        code: message.includes('pow-expired') ? 'pow-expired' : 'auto-continue-failed',
        message: message.includes('pow-expired')
          ? 'PoW 挑战已过期，重新获取后仍失败，已停止自动续跑。'
          : `自动续跑失败：${message}`,
      });
      loopDepth = 0;
    }
  }

  const origFetch = window.fetch ? window.fetch.bind(window) : undefined;
  // QD-R4-02/03/04：把流结束结算函数传给两条 hook，让 XHR 与 fetch 走同一套断流语义。
  const stopFetch = origFetch
    ? installFetchHook(origFetch, forward, pending, d, loopState, settleStreamEnd, escalateFirstAttemptFailure)
    : undefined;
  const stopXhr = installXhrHooks(forward, pending, d, loopState, capturedHeaders, onStreamDelta, settleStreamEnd, escalateFirstAttemptFailure);

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
  if (!chatUI) {
    // Studio 主视图存在时不再给原生 React 消息树插“运行”按钮，避免污染原生 DOM。
    if (document.body) setupCodeObserver();
    else document.addEventListener('DOMContentLoaded', setupCodeObserver, { once: true });
  }

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

  // v1.9：启动时异步加载技能列表，注入提示词让 agent 知道有哪些技能、SKILL.md 在哪。
  // 与 MCP 一样：installMainWorldInterceptor 可能早于 WS 连接建立，sender 会先返回
  // no-host，需要重试直到成功或达到最大次数。
  (async () => {
    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const r = await sender({ callId: 'skills-init', invocationName: 'skill.list', params: {} });
        if (r.ok && r.data && Array.isArray((r.data as { skills?: unknown[] }).skills)) {
          currentSkills = (r.data as { skills: Array<{ id: string; name: string; description: string; skillMdPath: string }> }).skills;
          d(`loaded ${currentSkills.length} skills for prompt injection (attempt ${attempt + 1})`);
          return;
        }
        d(`skills load attempt ${attempt + 1} failed: ok=${r.ok} error=${r.error ?? 'none'}`);
      } catch (e) {
        d(`skills load attempt ${attempt + 1} error: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    d(`skills load failed after ${maxRetries} attempts, agent will not see skills in prompt`);
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
