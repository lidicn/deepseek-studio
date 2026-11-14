/**
 * 续跑 / nudge prompt 构建器（v1.6，纯模块，无 DOM / 运行时依赖）
 * @upstream-commit 187f6227 @upstream-path src/core/inline-agent/prompt.ts
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

import { failureTextFor } from './tool-result-format';

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
  /** W2：该结果产生时归属的 chat_session_id（captureChatRequest 捕获）。 */
  sessionId?: string;
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
/**
 * R0-R2：独立的错误重试预算。原实现把 429/网络错误/200 空回复与「应续跑」混在同一个
 * MAX_LOOP=25 里，一次服务器错误能消耗整轮预算。错误重试单独封顶 3 次，与工具续跑步数互不占用。
 */
export const MAX_ERROR_RETRIES = 3;
/**
 * 移植 dpp `core/chat/loop-contract.ts` MAX_AUTO_CONTINUE=3。
 * 只封顶「流截断且本轮无工具」的空转续轮：模型吐一半就断、 Studio 反复重发同一 prompt 时，
 * 最多空转 3 次，不与 MAX_LOOP（含工具的正式步数）混用。
 * 缺它时的实测后果：空转轮会一路吃到 MAX_LOOP=25，既烧配额又让用户看到漫长的无进展等待。
 */
export const MAX_AUTO_CONTINUE = 3;
/** 续跑 prompt 里带完整 detail/output 的最近结果条数；更早的压缩为 summary。 */
export const FULL_TOOL_RESULT_WINDOW = 4;

/**
 * 单轮工具结果累计预算（字节，UTF-8）。
 *
 * 现场（`chat:ff7fc62f`）：一轮 11 次工具调用共 **307,682 字节**原始结果进上下文。
 * 单次 16KB（`STUDIO_TOOL_PAYLOAD_LIMIT`）只封顶「一条」，封不住「一轮」——
 * 25 步 × 每次 12KB 的画布就是 300KB，模型注意力被淹、成本也跟着涨。
 *
 * 与单次上限**解耦**：单次上限管「一条结果多大」，本预算管「一轮加起来多大」。
 * 超出后按「**保新弃旧 + 边界截断 + 一句可读提示**」处理，绝不静默丢弃。
 */
export const TURN_TOOL_RESULT_BUDGET_BYTES = 64 * 1024;

const ORIGINAL_TASK_MAX_CHARS = 8000;
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
  /(?:我(?:将|会|想|要|先|让|再|直接|现在|继续|尝试|开始|需要|还需要|仍需|打算|计划|马上|随后|稍后|先去|先来|接下来).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:接下来|下一步|然后|让我|先让我).{0,48}(?:调用|创建|编辑|检查|验证|生成|保存|尝试|搜索|获取|打开|执行|查看|访问|读取|抓取|下载|上传|修改|更新|删除|写入|分析|比对|比较|监控|查询|发送|提交|安装|启动|停止|清理|转换|解析|提取|汇总|整理|核对|核实|扫描|截屏|渲染)|(?:(?:现在|这就|马上|随后|稍后|立即|立刻|先|直接))?(?:为|帮)(?:你|您)(?:创建|生成|制作|输出|编写|绘制|渲染)(?!了|好|完|成|过|的)|(?:i(?:'ll| will|'m| am|'d| would| want to| should| have to| (?:still\s+)?need to|'m going to| am going to|'m about to| am about to|'ve got to| have got to)|let me|let's|next,? (?:i|we)|we(?:'ll| will| need to| can)|(?:my|the) next step is to).{0,64}(?:call|create|edit|inspect|validate|generate|save|try|search|fetch|open|run|browse|read|check|look|use|verify|test|download|write|update|review|analyze|extract|query|send|post|investigate|monitor|compare|install|start|stop|convert|parse|list|collect|request|retry|scroll|click|type|navigate|\bexamine\b|\bexplore\b|\bscan\b|\bfind\b|\bgrep\b|\bcat\b|\bdiff\b|\btrace\b|\bdump\b|\bprint\b|\bview\b|\bsee\b|\bdisplay\b))/gi;

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

// ---------------------------------------------------------------- 失败分性（2026-11-14）
//
// 真机（出资人截图）：记忆硬闸拦住了写入，但 `FAILURE_RECOVERY` 对一个**策略性拒绝**说
// 「修正参数或改用合适的下一步继续」，于是模型在同一轮里把 `memory_save` 原样重发 6 次
// （3–37ms 全 ok=false），一个字节都没落库 —— 用户看到的就是刷屏红字＋空转。
// 同一份 prompt 的结构化字段还写着 `retryable: false`：**字段说不可重试、散文说继续重试**，
// 模型执行散文。这个模块从此按「失败性质」分流，两条必须同向。

/**
 * 终局／策略性拒绝码：**同一调用重复多少次都不会改变结果**。
 *
 * 判据里点名的最小集合：`memory-save-needs-explicit-instruction`、`consent-denied`、
 * `consent-unavailable`、`workspace-unconfigured`、`page-not-ready`；
 * 另收同族（同样是"参数再试也不会变"的策略/装配态），避免下次换个码又漏。
 */
export const TERMINAL_FAILURE_CODES: readonly string[] = [
  'memory-save-needs-explicit-instruction',
  'memory-save-no-user-turn',
  'memory-save-task-snapshot',
  'consent-denied',
  'consent-unavailable',
  'workspace-unconfigured',
  'page-not-ready',
  'unknown-tool',
  'unknown-capability',
  'tool-not-allowed-by-persona',
  'outside-workspace',
  'origin-denied',
  'hard-deny',
  /**
   * 注入层的**折叠回执**（UI 卡 `MAX_SIG_REDELIVERIES=3`）：同流同签名第 2–4 枚不再执行，
   * 直接回 `ok:false` + `duplicate-tool-signature: …`。它同样是"再试也不会变"，
   * 必须走终局文案——否则这边会劝模型"修正参数继续"，把被折叠的重复调用再推一遍。
   * ⚠️ 但它**不计入** `buildRepeatDenialNotice` 的 N（见那里），避免与 UI 的封顶重复计数。
   */
  'duplicate-tool-signature',
];

/** 真可重试的失败特征（网络 / 5xx / 限流 / 断流 / 超时）。命中即"改参数再试有意义"。 */
const RETRYABLE_FAILURE_RE =
  /(timeout|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|rate.?limit|429|50[0-9]|health-timeout|read-no-data|page-timeout|stream|SSE|disconnected)/i;

/** 失败性质：终局（策略拒绝，重试无意义）／可重试（改参数或等待后有意义）。 */
export type ToolFailureKind = 'terminal' | 'retryable';

/**
 * 从失败文本里抽出**规范失败码**（穷举 `TERMINAL_FAILURE_CODES`，取出现位置最靠前的那个）。
 *
 * 为什么必须抽码（2026-11-14 PM 复核指出的真缺陷）：原来把整条 `e.error` 当"码"用，
 * 于是同一签名只要文案里带了不同参数回显或不同耗时 ⇒ **分桶键不相等 ⇒ 凑不出 2**
 * ⇒ 计数提示永远不出，现场那种"同一调用被拒 6 次"就永远拿不到提示。
 *
 * 认三种形态，都靠 `indexOf` 命中，取最靠前＝最像"主码"的那个：
 *   ① 裸码：`memory-save-needs-explicit-instruction`
 *   ② 括号形态：宿主 `page-runtime.describeToolFailure` 写的「…（consent-denied）」
 *   ③ 前缀形态：`duplicate-tool-signature: 同一轮…`（注入层折叠回执，靠这个接头）
 *
 * ⚠️ 注入层写折叠回执时 `duplicate-tool-signature:` 必须留在**开头**（已请 PM 转 UI）：
 * 改措辞顺序等于把封顶机制与计数机制的接头拆掉。
 */
export function extractFailureCode(text: string | undefined): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  let best: { code: string; index: number } | undefined;
  for (const code of TERMINAL_FAILURE_CODES) {
    const index = text.indexOf(code);
    if (index === -1) continue;
    if (best === undefined || index < best.index || (index === best.index && code.length > best.code.length)) {
      best = { code, index };
    }
  }
  return best?.code;
}

/**
 * 判定一条失败的性质。
 *
 * 顺序：**终局优先**——宿主侧的可读文案会把码写在括号里
 * （如「…（consent-denied）」，见 `page-runtime.describeToolFailure`），
 * 文案里可能同时出现 `timeout` 一类词；只要抽出终局码就按终局处理，避免判定翻转。
 * 默认按可重试处理（保持旧行为：未知码仍给续跑机会），终局集合是显式豁免。
 *
 * 分类与分桶**同出一个源**（都走 `extractFailureCode`）：同向不等于同源，同源才不会再分叉。
 */
export function classifyToolFailure(p: { ok: boolean; error?: string }): ToolFailureKind | undefined {
  if (p.ok) return undefined;
  const text = typeof p.error === 'string' ? p.error : '';
  if (extractFailureCode(text) !== undefined) return 'terminal';
  if (RETRYABLE_FAILURE_RE.test(text)) return 'retryable';
  return 'retryable';
}

/**
 * 终局失败的模型侧文案：**不含**「修正参数」「继续重试」这类句子。
 *
 * 为什么必须去掉：那不是措辞问题，是**行为指令**。真机里模型就是照着
 * 「修正参数或改用合适的下一步继续」把同一调用重发 6 次。
 */
export function buildTerminalFailureNotice(codes: readonly string[]): string {
  const uniq = [...new Set(codes.filter((c) => c.length > 0))];
  const list = uniq.length > 0 ? `（${uniq.join('、')}）` : '';
  return (
    `以下失败属于策略性拒绝${list}：这类失败重复同一调用不会改变结果。`
    + '请改用其他步骤，或直接向用户说明原因并结束本轮；不要原样重试同一调用。'
  );
}

/**
 * 注入层折叠回执的错误码前缀（与 UI 卡同一字符串，改动必须两边同步）。
 * 只用于"不计入重复计数"的排除，不参与文案拼接。
 */
const DUPLICATE_SIGNATURE_CODE = 'duplicate-tool-signature';

/**
 * 同一签名被终局拒绝 ≥ 阈值时，给模型的显式计数提示。
 *
 * ⚠️ **签名口径**：`PendingResult` 里**没有 params**（注入层只有
 * invocationName/ok/result/error/sessionId），所以这里用
 * `(invocationName, 规范失败码)` 近似"同一调用"。规范码由 `extractFailureCode` 抽出，
 * **不是整条错误文本**——同一调用的文案会带不同参数回显或不同耗时，按全文分桶
 * 会永远凑不出 2（这正是 2026-11-14 PM 复核抓到的缺陷）。
 * 真要按 (tool, params) 精确计数，需要注入层在 PendingResult 上补 params 摘要（属 UI 域，已报 PM 转）。
 */
export const REPEAT_DENIAL_ALERT_THRESHOLD = 2;

export function buildRepeatDenialNotice(executions: readonly PendingResult[]): string | undefined {
  const buckets = new Map<string, { tool: string; code: string; count: number }>();
  for (const e of executions) {
    if (classifyToolFailure({ ok: e.ok, ...(e.error !== undefined ? { error: e.error } : {}) }) !== 'terminal') {
      continue;
    }
    // 分桶键用**抽出来的规范码**（终局判定成立 ⇒ 码必然抽得出来；兜底留空串保证不抛）。
    const code = extractFailureCode(e.error) ?? '';
    // 折叠回执**不计入本计数**（与 UI 卡 `MAX_SIG_REDELIVERIES=3` 正交）：
    // 那种回执对应的工具**根本没再执行**，N 的语义是"真的执行过、并被策略拒绝了几次"；
    // 重复投递本身已由注入层的封顶 + 折叠回执负责，两边都数会让模型看到两个不同的 N。
    if (code === DUPLICATE_SIGNATURE_CODE) continue;
    const key = `${e.invocationName}\u0000${code}`;
    const hit = buckets.get(key);
    if (hit) hit.count += 1;
    else buckets.set(key, { tool: e.invocationName, code, count: 1 });
  }
  const repeated = [...buckets.values()].filter((b) => b.count >= REPEAT_DENIAL_ALERT_THRESHOLD);
  if (repeated.length === 0) return undefined;
  const parts = repeated.map((b) => {
    const reason = b.code.length > 0 ? b.code : '策略性拒绝';
    // 打印**码**而不是 120 字句子：模型要的是"哪一类拒绝"，长句只会淹掉"停止重试"这句指令。
    return `${b.tool} ×${b.count}（原因：${reason}）`;
  });
  return (
    `⚠️ 本轮同一调用已被终局拒绝 ${repeated.map((b) => b.count).join('/')} 次：${parts.join('；')}。`
    + '继续重复完全不会改变结果——请停止重试，改用其他步骤或直接向用户说明。'
  );
}

/** 把一批终局失败折算成提示里要印的码（去重、保序、丢掉抽不出码的）。 */
function terminalCodesOf(failures: readonly PendingResult[]): string[] {
  const codes: string[] = [];
  for (const e of failures) {
    const code = extractFailureCode(typeof e.error === 'string' ? e.error : undefined);
    if (code !== undefined) codes.push(code);
  }
  return codes;
}

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
  // R4-N6 移植（2026-11-14，上游 prompt.ts:149-153）：围栏要判**奇偶**，不是"出现过 ```"。
  //
  // 旧判据 `tail.includes('```')` 把「写到一半被截断的未闭合代码块」（``` 出现奇数次）
  // 也判成"有交付物 ⇒ 已完成"，于是**不 nudge**，用户拿到半截代码、本轮静默结束。
  // 现在：偶数围栏 = 已闭合可交付 → 不续；奇数 = 仍在写 → 继续走 pending/完成判定。
  const fenceCount = tail.split('```').length - 1;
  if (fenceCount > 0 && fenceCount % 2 === 0) return false;
  if (hasPendingActionAtTail(tail)) return true;
  if (COMPLETION_MARKER_RE.test(tail)) return false;
  if (ENDS_WITH_SENTENCE_TERMINAL_RE.test(tail)) return false;
  return true;
}

/**
 * 是否允许发起一次协议修复轮。
 *
 * 条件必须全部成立：已有工具执行结果、本用户回合尚未修复过、模型没有显式完成、
 * 且当前可见文本仍是半截或承诺后未执行。修复轮只用于让模型按 XML 协议继续，
 * 不消耗普通续跑步数或错误重试预算。
 */
export function shouldAttemptProtocolRepair(
  visibleText: string,
  executions: readonly PendingResult[],
  protocolRepairUsed: boolean,
): boolean {
  return (
    executions.length > 0
    && !protocolRepairUsed
    && !extractTaskCompleteSignal(visibleText)
    && shouldNudge(visibleText)
  );
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
 * 失败结果的结构化 `error` 槽。
 *
 * `code` 必须填 `extractFailureCode` 抽出的**规范码**（2026-11-14 PM 复核）：
 * 这个槽契约本来就有 `code`，之前两处都填 `undefined`，等于把码只留在散文里。
 * 现在散文、分类、分桶、结构化字段**同出一个源**，不会再各自分叉。
 */
function toolResultError(p: PendingResult): NormalizedToolResult['error'] {
  if (p.ok) return undefined;
  const code = extractFailureCode(p.error);
  return {
    ...(code !== undefined ? { code } : {}),
    message: failureMessage(p),
    retryable: classifyToolFailure({ ok: p.ok, error: p.error }) === 'retryable',
  };
}

/**
 * 把 studio 扁平 PendingResult 映射成 deepseek-pp 规范化的 NormalizedToolResult，
 * 供 <tool_results> JSON 序列化。detail = 完整可见文本，output = JSON.stringify(result)。
 *
 * 2026-11-13（工具执行缺陷 A）：失败结果**不许有空文案**。
 * 原来 `p.error ?? 'execution failed'` 兜不住空串——宿主侧 `reason: ''`（MCP 服务器把
 * 错误放在非 text 段时的真实形态）会让 summary/detail/error.message 三处全空，
 * 模型只看得到 `ok:false`，不知道哪次调用、为什么失败。
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
    error: toolResultError(p),
  };
}

/** 失败文案：宿主给了非空文本就用它，否则用「工具名＋自述」兜底（绝不留空串）。 */
function failureMessage(p: PendingResult): string {
  const text = typeof p.error === 'string' ? p.error.trim() : '';
  return text || failureTextFor(p.invocationName);
}

/** 压缩视图：只留 tool/ok/summary/error，无 detail/output，标 windowed。 */
function renderCompressedToolResult(p: PendingResult): NormalizedToolResult {
  return {
    tool: p.invocationName,
    ok: p.ok,
    summary: clampText(resultToSummary(p), SUMMARY_MAX_CHARS) ?? '',
    error: toolResultError(p),
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

// ---------------------------------------------------------------- 单轮累计预算

/** 预算视图：预算内的结果 ＋ 超预算时的可读提示。 */
export interface TurnToolResultsView {
  /** 保留的结果（时间正序，最新在末尾）。 */
  results: NormalizedToolResult[];
  /** 超预算提示；未超预算时为 undefined（此时逐字节等于旧输出）。 */
  notice?: string;
  /** 被省略的早期结果条数（未超预算时为 0）。 */
  omittedCount: number;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * 一条结果在**真实输出形态**下的字节数。
 *
 * 必须按 `JSON.stringify(x, null, 2)` 量，不能按紧凑 JSON：prompt 里落的是 pretty-print，
 * 缩进与换行本身就占不少字节。用紧凑形态记账会系统性低估，预算当场失效。
 */
function serializedBytes(results: readonly NormalizedToolResult[]): number {
  return utf8Bytes(JSON.stringify(results, null, 2));
}

/** 逐级收缩一条结果：先丢 output / 缩短 detail，最后只留 summary 骨架。 */
function shrinkAttempts(entry: NormalizedToolResult): NormalizedToolResult[] {
  return [
    { ...entry, output: undefined, detail: clampText(entry.detail, 800), truncated: true },
    { ...entry, output: undefined, detail: undefined, truncated: true },
    { tool: entry.tool, ok: entry.ok, summary: entry.summary.slice(0, 200), error: entry.error, truncated: true },
    { tool: entry.tool, ok: entry.ok, summary: entry.summary.slice(0, 60), error: entry.error, truncated: true },
    { tool: entry.tool, ok: entry.ok, summary: '(已省略)', truncated: true },
  ];
}

/**
 * 应用单轮累计预算：**保新弃旧**——从最新一条往回装，装不下的那条就地截断，
 * 更早的一律省略，并给出一句可读提示（模型必须知道"上下文被压缩过"，否则会把
 * "没看到"当成"没发生"，重复调用或错误推断）。
 *
 * 未超预算时逐字节等于 `renderWindowedToolResults` 的输出（无提示、无截断）。
 * 记账口径 = 构建器真正写进 prompt 的那份 `JSON.stringify(results, null, 2)`。
 */
export function renderBudgetedToolResults(executions: readonly PendingResult[]): TurnToolResultsView {
  const windowed = renderWindowedToolResults(executions);
  if (serializedBytes(windowed) <= TURN_TOOL_RESULT_BUDGET_BYTES) {
    return { results: windowed, omittedCount: 0 };
  }

  const keptNewestFirst: NormalizedToolResult[] = [];
  let omittedCount = 0;
  let truncatedOldest = false;

  for (let i = windowed.length - 1; i >= 0; i -= 1) {
    const entry = windowed[i];
    // keptNewestFirst 是倒序装的，序列化前要还原成时间正序。
    const withFull = [...keptNewestFirst, entry].reverse();
    if (serializedBytes(withFull) <= TURN_TOOL_RESULT_BUDGET_BYTES) {
      keptNewestFirst.push(entry);
      continue;
    }
    // 整条装不下：试逐级收缩版，能塞进多少留多少（保留"边界这条"的位置信息）。
    let keptShrunk = false;
    for (const shrunk of shrinkAttempts(entry)) {
      const trial = [...keptNewestFirst, shrunk].reverse();
      if (serializedBytes(trial) <= TURN_TOOL_RESULT_BUDGET_BYTES) {
        keptNewestFirst.push(shrunk);
        truncatedOldest = true;
        keptShrunk = true;
        break;
      }
    }
    omittedCount += keptShrunk ? i : i + 1; // 0..i-1 全被省略
    break;
  }

  const results = [...keptNewestFirst].reverse();
  const parts: string[] = [`本轮工具结果累计已超过 ${Math.round(TURN_TOOL_RESULT_BUDGET_BYTES / 1024)} KB 预算`];
  if (omittedCount > 0) parts.push(`最早的 ${omittedCount} 条已省略`);
  if (truncatedOldest) parts.push('边界那条已截断');
  parts.push('需要全量内容时请用更精确的参数重新查询，不要把省略当成"没有发生"');
  return { results, notice: `⚠️ ${parts.join('，')}。`, omittedCount };
}

/**
 * 从 PendingResult 提取给模型看的「概要」文本（summary 字段）。
 * 成功：stdout 首行 / result 字符串首行；失败：error 首段。
 */
function resultToSummary(p: PendingResult): string {
  if (!p.ok) {
    return failureMessage(p).slice(0, SUMMARY_MAX_CHARS);
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
    return failureMessage(p);
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
  // 2026-11-14：失败**分性**，不再 `some(!ok)` 一视同仁（真机：策略拒绝被"修正参数继续"推回 6 次）。
  const failures = executions.filter((e) => !e.ok);
  const terminal = failures.filter((e) => classifyToolFailure(e) === 'terminal');
  const retryable = failures.filter((e) => classifyToolFailure(e) === 'retryable');
  const repeatNotice = buildRepeatDenialNotice(executions);
  // 2026-11-13（B）：单轮累计预算在**渲染出口**统一生效——所有续跑 prompt 都走这里，
  // 不存在"某条路径绕过预算"的旁路。
  const view = renderBudgetedToolResults(executions);

  return [
    CONTINUATION_INTRO,
    CONTINUATION_ENOUGH,
    CONTINUATION_NO_PSEUDO,
    '',
    '<original_task>',
    clampText(originalTask, ORIGINAL_TASK_MAX_CHARS) ?? '',
    '</original_task>',
    // 终局提示必须在续跑提示**之前**：后者说"修正参数继续"，先读到的结论定调。
    // 提示里印的是**规范码**（不是整条错误文本）：长句会淹掉"不要原样重试"这句指令，
    // 而且同一码的不同参数回显会让提示每次长得不一样。
    ...(terminal.length > 0
      ? ['', buildTerminalFailureNotice(terminalCodesOf(terminal))]
      : []),
    ...(retryable.length > 0 ? ['', FAILURE_RECOVERY] : []),
    ...(repeatNotice ? ['', repeatNotice] : []),
    ...(view.notice ? ['', view.notice] : []),
    '',
    '<tool_results>',
    JSON.stringify(view.results, null, 2),
    '</tool_results>',
    ...(toolCatalog ? ['', '### Available Tools', toolCatalog] : []),
  ].join('\n');
}

/**
 * 协议修复 prompt：只发一次，明确要求模型使用 XML 工具标签继续或输出完成信号。
 */
export function buildProtocolRepairPrompt(
  originalTask: string,
  executions: readonly PendingResult[],
  toolCatalog?: string,
): string {
  const view = renderBudgetedToolResults(executions);
  // 2026-11-14：协议修复轮同样按性质分流——修复轮里模型最容易"换个写法再试同一个被拒调用"，
  // 终局提示与重复计数在这一轮尤其要说。可重试的续跑句保持原样（不新增、不改字）。
  const terminal = executions.filter((e) => classifyToolFailure(e) === 'terminal');
  const repeatNotice = buildRepeatDenialNotice(executions);
  return [
    '上一轮回答未完整遵循工具调用协议。请基于原始任务和工具结果继续，并且只使用 XML 工具标签调用工具。',
    '如果任务已经完成，输出 <task_complete>{"summary":"简要结论"}</task_complete>。',
    '如果需要继续，直接输出可执行的 XML 工具标签并等待结果。',
    '禁止输出伪工具调用 JSON、Markdown 代码块包裹的工具标签，或“点击继续”之类要求用户操作的文本。',
    '',
    '<original_task>',
    clampText(originalTask, ORIGINAL_TASK_MAX_CHARS) ?? '',
    '</original_task>',
    ...(terminal.length > 0
      ? ['', buildTerminalFailureNotice(terminalCodesOf(terminal))]
      : []),
    ...(repeatNotice ? ['', repeatNotice] : []),
    ...(view.notice ? ['', view.notice] : []),
    '',
    '<tool_results>',
    JSON.stringify(view.results, null, 2),
    '</tool_results>',
    ...(toolCatalog ? ['', '### Available Tools', toolCatalog] : []),
    '',
    '请现在继续操作。',
  ].join('\n');
}

// ---------------------------------------------------------------- 截断

/** 字符级截断：超限加 `...[truncated]`，未超原样；undefined 透传。 */
export function clampText(value: string | undefined, maxLen: number): string | undefined {
  if (!value) return value;
  return value.length > maxLen ? `${value.slice(0, maxLen)}\n...[truncated]` : value;
}
