/**
 * 续跑 / nudge prompt 构建器（v1.6，纯模块，无 DOM / 运行时依赖）
 *
 * 移植自 deepseek-pp `core/inline-agent/prompt.ts`，适配 studio 的扁平
 * `PendingResult`（宿主原始返回：shell 的 `{stdout,stderr,exitCode}` / 文件内容 / MCP 结果）。
 *
 * DeepSeek 网页协议是扁平 `prompt` 字符串 + `parent_message_id`，本模块只产出
 * prompt 文本字符串，不碰协议、不碰 DOM。便于单测。
 *
 * 与 main-world-interceptor.ts 的 formatToolResultBlock（旧式纯文本回注，兼容
 * 页面首次请求）并存：本模块用于 auto-continue 续跑轮，带原始任务 + 窗口化
 * 历史 + 工具目录，让多步任务不丢上下文。
 */

// ---------------------------------------------------------------- 类型

/**
 * 一次工具执行的待处理/已完成结果（页端 forward 累积）。
 * 与 main-world-interceptor.ts 的 PendingResult 同构；在此导出为单一真相源，
 * 拦截器 import 本接口，消除重复声明。
 */
export interface PendingResult {
  invocationName: string;
  ok: boolean;
  /** 宿主原始返回：shell={stdout,stderr,exitCode}；file.read=字符串内容；MCP=对象。 */
  result?: unknown;
  /** 失败时的错误文案。 */
  error?: string;
}

interface NormalizedToolResult {
  tool: string;
  ok: boolean;
  summary: string;
  detail?: string;
  output?: string;
  error?: { code?: string; message: string; retryable: boolean };
  truncated?: boolean;
  windowed?: boolean;
}

// ---------------------------------------------------------------- 常量

/** 一个用户消息最多续跑步数（对齐 deepseek-pp INLINE_AGENT_MAX_STEPS）。 */
export const MAX_LOOP = 25;
/** 单回合最多 nudge 次数（防无限 nudge 死循环，对齐 deepseek-pp MAX_NUDGES）。 */
export const MAX_NUDGES = 8;
/**
 * R0-R2：独立的错误重试预算。原实现把 429/网络错误/200 空回复与「应续跑」混在同一个
 * MAX_LOOP=25 里，一次服务器错误能消耗整轮预算并叠加 nudge，形成 25 续跑 + 8 nudge = 33
 * 连发。错误重试单独封顶 3 次，与工具续跑步数、nudge 次数互不占用。
 */
export const MAX_ERROR_RETRIES = 3;
/** 续跑 prompt 里带完整 detail/output 的最近结果条数；更早的压缩为 summary。 */
export const FULL_TOOL_RESULT_WINDOW = 4;

const ORIGINAL_TASK_MAX_CHARS = 8000;
const PREVIOUS_TEXT_MAX_CHARS = 4000;
const NUDGE_DECISION_TAIL_MAX_CHARS = 600;
const PENDING_ACTION_AFTER_MAX_CHARS = 80;
const SUMMARY_MAX_CHARS = 400;
const DETAIL_MAX_CHARS = 4000;
const OUTPUT_MAX_CHARS = 8000;

// ---------------------------------------------------------------- 正则

/**
 * "承诺做事但还没做"的短语。移植自 deepseek-pp prompt.ts PENDING_ACTION_RE。
 * 覆盖中英文「我接下来要调用 / I will create / let me read」类意向。
 */
const PENDING_ACTION_RE =
  /(?:我(?:将|会|想|要|先|让|再|直接|现在|继续|尝试|开始|需要|还需要|仍需|打算|计划|马上|随后|稍后|先去|先来|接下来).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:接下来|下一步|然后|让我|先让我).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:(?:现在|这就|马上|随后|稍后|立即|立刻|先|直接))?(?:为|帮)(?:你|您)(?:创建|生成|制作|输出|编写|绘制|渲染)(?!了|好|完|成|过|的)|(?:i(?:'ll| will|'m| am|'d| would| want to| should| have to| (?:still\s+)?need to|'m going to| am going to|'m about to| am about to|'ve got to| have got to)|let me|let's|next,? (?:i|we)|we(?:'ll| will| need to| can)|(?:my|the) next step is to).{0,64}(?:call|create|edit|inspect|validate|generate|save|try|search|fetch|open|run|browse|read|check|look|use|verify|test|download|write|update|review|analyze|extract|query|send|post|investigate|monitor|compare|install|start|stop|convert|parse|list|collect|request|retry|scroll|click|type|navigate))/gi;

/** 完成标记（过去式、总结、交付物呈现）——出现则不该 nudge。 */
const COMPLETION_MARKER_RE =
  /(?:已经|已为|已完成|完毕|创建了|生成了|制作了|编写了|保存了|写好了|完成了|总结一下|总结如下|总结|结论是|综上所述|总的来看|这是|报告如下|如下所示|final answer|in summary|to summarize|summarize|here is|here's|the answer is|as you can see|i'?ve already|we'?ve already|created|generated|saved|completed|done)/i;

/** 句末终止标点（。！？.!?…）。结尾有则视为完整回答，不 nudge。 */
const ENDS_WITH_SENTENCE_TERMINAL_RE = /[。！？.!?…]\s*$/;

const TASK_COMPLETE_RE = /<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/;

// ---------------------------------------------------------------- prompt 文案

const CONTINUATION_INTRO =
  '以下是工具续跑任务刚刚执行的工具结果。请像真正的 Agent 一样，基于原始任务和这些工具结果继续推进。';
const CONTINUATION_ENOUGH =
  '如果结果已经足够，请输出最终结论；只有确实需要更多信息、验证或文件修改时才继续调用工具。';
const CONTINUATION_NO_PSEUDO =
  '不要要求用户点击继续，也不要输出伪工具调用 JSON；需要继续操作时只输出可执行 XML 工具标签。文件、HTML 页面与图表等交付物请直接用 Markdown 围栏代码块输出（如 ```html、```mermaid），不要使用 artifact XML 标签。';
const FAILURE_RECOVERY =
  '至少一个工具执行失败。不要因为可恢复错误就停止；先阅读 summary/detail/error，并修正参数或改用合适的下一步继续完成任务。';

const NUDGE_NO_TOOLS =
  '上一轮回复没有包含任何可执行工具 XML，因此自动化续跑无法继续执行。';
const NUDGE_CHOICE = '请根据原始任务和工具结果二选一：';
const NUDGE_NEXT_TOOL = '1. 如果任务仍未完成，本轮必须直接输出下一步可执行工具 XML。';
const NUDGE_COMPLETE =
  '2. 如果任务已经完成，输出 <task_complete>{"summary":"..."}</task_complete>。文件、HTML 页面与图表等交付物用 Markdown 围栏代码块输出。';

// ---------------------------------------------------------------- task_complete

/**
 * 解析 <task_complete>{"summary":"..."}</task_complete> 信号。
 * body 是合法 JSON 且含 summary 字符串 → 取 summary；否则取 trim 后的原文。
 * 无标签 → null。
 */
export function extractTaskCompleteSignal(text: string): { summary: string; artifacts: string[] } | null {
  const match = TASK_COMPLETE_RE.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : match[1].trim(),
      artifacts: Array.isArray(parsed.artifacts)
        ? parsed.artifacts.filter((a: unknown) => typeof a === 'string')
        : [],
    };
  } catch {
    return { summary: match[1].trim(), artifacts: [] };
  }
}

// ---------------------------------------------------------------- shouldNudge

/**
 * 判断模型本轮（无工具调用）是否需要 nudge 续一轮。
 *
 * true 的情况：
 *   - 回复为空；
 *   - 回复末尾有「承诺做事」短语（"我接下来要调用..."）但后面没跟交付物；
 *   - 回复末尾没有句末标点（半句截断 / 被打断）。
 * false 的情况：
 *   - 含 <task_complete>；
 *   - 末尾有 fenced 代码块（交付物）；
 *   - 末尾有完成标记（过去式、总结）；
 *   - 末尾有句末标点（完整句）。
 */
export function shouldNudge(visibleText: string): boolean {
  if (extractTaskCompleteSignal(visibleText)) return false;
  if (!visibleText) return true;
  const tail = getNudgeDecisionText(visibleText);
  if (tail.includes('```')) return false;
  if (hasPendingActionAtTail(tail)) return true;
  if (COMPLETION_MARKER_RE.test(tail)) return false;
  if (ENDS_WITH_SENTENCE_TERMINAL_RE.test(tail)) return false;
  return true;
}

function getNudgeDecisionText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > NUDGE_DECISION_TAIL_MAX_CHARS
    ? trimmed.slice(-NUDGE_DECISION_TAIL_MAX_CHARS)
    : trimmed;
}

function hasPendingActionAtTail(text: string): boolean {
  const matches = [...text.matchAll(PENDING_ACTION_RE)];
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch || lastMatch.index === undefined) return false;
  const afterPendingAction = text.slice(lastMatch.index + lastMatch[0].length).trim();
  if (afterPendingAction.length > PENDING_ACTION_AFTER_MAX_CHARS) return false;
  if (afterPendingAction.includes('```')) return false;
  return true;
}

// ---------------------------------------------------------------- 渲染工具结果

/**
 * 把 studio 扁平 PendingResult 映射成 deepseek-pp 规范化的 NormalizedToolResult，
 * 供 <tool_results> JSON 序列化。detail = 完整可见文本，output = JSON.stringify(result)。
 */
function renderToolResult(p: PendingResult): NormalizedToolResult {
  const detail = clampText(resultToDetailText(p), DETAIL_MAX_CHARS);
  const output =
    p.result === undefined
      ? undefined
      : clampText(JSON.stringify(p.result), OUTPUT_MAX_CHARS);
  return {
    tool: p.invocationName,
    ok: p.ok,
    summary: clampText(resultToSummary(p), SUMMARY_MAX_CHARS) ?? '',
    detail,
    output,
    error: !p.ok
      ? { code: undefined, message: p.error ?? 'unknown', retryable: false }
      : undefined,
  };
}

/** 压缩视图：只留 tool/ok/summary/error，无 detail/output，标 windowed。 */
function renderCompressedToolResult(p: PendingResult): NormalizedToolResult {
  return {
    tool: p.invocationName,
    ok: p.ok,
    summary: clampText(resultToSummary(p), SUMMARY_MAX_CHARS) ?? '',
    error: !p.ok
      ? { code: undefined, message: p.error ?? 'unknown', retryable: false }
      : undefined,
    windowed: true,
  };
}

/**
 * 窗口化：最近 N 条完整、更早的压缩，保持上下文近似常量不随步数线性增长。
 */
export function renderWindowedToolResults(executions: readonly PendingResult[]): NormalizedToolResult[] {
  if (executions.length <= FULL_TOOL_RESULT_WINDOW) {
    return executions.map(renderToolResult);
  }
  const older = executions.slice(0, -FULL_TOOL_RESULT_WINDOW);
  const recent = executions.slice(-FULL_TOOL_RESULT_WINDOW);
  return [...older.map(renderCompressedToolResult), ...recent.map(renderToolResult)];
}

/**
 * 从 PendingResult 提取给模型看的「概要」文本（summary 字段）。
 * 成功：stdout 首行 / result 字符串首行；失败：error 首段。
 */
function resultToSummary(p: PendingResult): string {
  if (!p.ok) {
    return (p.error ?? 'execution failed').slice(0, SUMMARY_MAX_CHARS);
  }
  if (p.result && typeof p.result === 'object' && 'stdout' in p.result) {
    const r = p.result as Record<string, unknown>;
    const stdout = typeof r.stdout === 'string' ? r.stdout : '';
    return firstLine(stdout) || '(empty output)';
  }
  if (typeof p.result === 'string') {
    return firstLine(p.result) || '(empty output)';
  }
  return '(completed)';
}

/**
 * 从 PendingResult 提取完整可见文本（detail 字段）。
 * 复用 main-world-interceptor.formatToolResultBlock 的 stdout/stderr/data 逻辑，
 * 但这里是纯函数、不拼 [tool-result:xxx] 头。
 */
function resultToDetailText(p: PendingResult): string {
  if (!p.ok) {
    return p.error ?? 'execution failed';
  }
  if (p.result && typeof p.result === 'object' && 'stdout' in p.result) {
    const r = p.result as Record<string, unknown>;
    const stdout = typeof r.stdout === 'string' ? r.stdout : '';
    const stderr = typeof r.stderr === 'string' ? r.stderr : '';
    const exitCode = r.exitCode;
    const parts: string[] = [];
    if (stdout.trim()) parts.push(stdout.trimEnd());
    if (stderr.trim()) parts.push(`<stderr>\n${stderr.trimEnd()}\n</stderr>`);
    if (exitCode !== undefined && exitCode !== 0 && exitCode !== '') {
      parts.push(`<exit-code>${exitCode}</exit-code>`);
    }
    return parts.join('\n\n') || '(empty output)';
  }
  if (typeof p.result === 'string') return p.result;
  if (p.result === undefined || p.result === null) return '(empty output)';
  try {
    return JSON.stringify(p.result, null, 2);
  } catch {
    return String(p.result);
  }
}

function firstLine(s: string): string {
  const t = s.trim();
  const nl = t.indexOf('\n');
  return (nl === -1 ? t : t.slice(0, nl)).slice(0, SUMMARY_MAX_CHARS);
}

// ---------------------------------------------------------------- prompt 构建

/**
 * 续跑 prompt：工具执行完后，发给模型让它基于结果继续。
 * 含原始任务、窗口化全部历史结果、失败恢复提示、工具目录。
 */
export function buildContinuationPrompt(
  originalTask: string,
  executions: readonly PendingResult[],
  toolCatalog?: string,
): string {
  const hasFailures = executions.some((e) => !e.ok);
  const results = renderWindowedToolResults(executions);

  return [
    CONTINUATION_INTRO,
    CONTINUATION_ENOUGH,
    CONTINUATION_NO_PSEUDO,
    '',
    '<original_task>',
    clampText(originalTask, ORIGINAL_TASK_MAX_CHARS) ?? '',
    '</original_task>',
    ...(hasFailures ? ['', FAILURE_RECOVERY] : []),
    '',
    '<tool_results>',
    JSON.stringify(results, null, 2),
    '</tool_results>',
    ...(toolCatalog ? ['', '### Available Tools', toolCatalog] : []),
  ].join('\n');
}

/**
 * Nudge prompt：模型本轮没调工具、也没 task_complete 时，逼它二选一。
 * 含原始任务、上一轮可见文本、窗口化历史结果。
 */
export function buildNudgePrompt(
  originalTask: string,
  previousText: string,
  executions: readonly PendingResult[],
  nudgeCount: number,
): string {
  const results = renderWindowedToolResults(executions);
  return [
    NUDGE_NO_TOOLS,
    NUDGE_CHOICE,
    NUDGE_NEXT_TOOL,
    NUDGE_COMPLETE,
    `这是第 ${nudgeCount} 次无工具调用纠偏。`,
    '',
    '<original_task>',
    clampText(originalTask, ORIGINAL_TASK_MAX_CHARS) ?? '',
    '</original_task>',
    '',
    '<previous_assistant_text>',
    clampText(previousText, PREVIOUS_TEXT_MAX_CHARS) ?? '',
    '</previous_assistant_text>',
    '',
    '<tool_results_so_far>',
    JSON.stringify(results, null, 2),
    '</tool_results_so_far>',
  ].join('\n');
}

// ---------------------------------------------------------------- 截断

/** 字符级截断：超限加 `...[truncated]`，未超原样；undefined 透传。 */
export function clampText(value: string | undefined, maxLen: number): string | undefined {
  if (!value) return value;
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}
