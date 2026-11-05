#!/usr/bin/env tsx
/**
 * tools/metrics/term-state.ts — M0 终态分布测量（只测量，不改行为）
 *
 * 离线扫描既有日志，产出「七终态」分布：
 *   complete / truncated / disconnected / unknown / no-tool-calls / empty-response / max-rounds
 *   （另有 F6 新增 read-no-data、M1 计划新增 interrupted——见 docs/harness/00-term-state.md）
 *
 * 三类证据分开计数（不做跨类合并，避免重复计数伪装成精确度）：
 *   A. 页端 trace：logs/trace/trace-*.jsonl 的 turn.end 行（stopReason 原始值 → 七终态映射）
 *   B. CDP 抓包信号：logs/cdp-chat-capture/ 按请求分组（哨兵/长度/响应体存在性，只布尔探测不外泄内容）
 *   C. 引擎日志提及：logs/verify-exit/ 等 .log/.json 里的 completion= / stopReason= / API 返回体文案
 * 另有 E. 频率口径（M3，20261102）：每任务请求数分布 / 同任务相邻间隔 / 截断重发占比。
 *   判读铁律：**字节类只回答成本，频率类只回答请求表面积**——两件事互相独立，
 *   本脚本不产出「所以被限流」类合成结论。
 *   M3-1（20261105）补上 retryable 重试占比：打点在 interceptor 里**实有其事**
 *   （continuation.decision 的 first-attempt-retry / error-retry-<reason> /
 *   continuation-truncated，见 main-world-interceptor.ts:2620/:3004/:3016），
 *   分母 = request.sent 打点（实际发出请求数，含重试重发，:1636/:1918/:2885）。
 *   口径纪律：轮数（turn.end 数）= 请求数**下界**，与「实际发出请求数」**两个分母分开列**，不混算；
 *   attempt 序号不在 trace 字段里（:2619 的 d() 日志有、record 没带），占比只能数事件条数——如实注明。
 *
 * 用法：
 *   npx tsx tools/metrics/term-state.ts [路径...] [--out <file.md>]
 *   路径可以是文件或目录（目录递归取 .jsonl/.json/.log/.txt）；缺省 = 三个标准数据源。
 * 退出码：0=≥1 条终态证据被分桶  1=输入存在但 0 条终态证据  2=输入路径全部不可读
 *
 * 容错：未知 stopReason 一律单列到 unknown(未收录) 并在明细里点名，绝不崩。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 类型

export type HostTerm =
  | 'complete'
  | 'truncated'
  | 'disconnected'
  | 'unknown'
  | 'no-tool-calls'
  | 'empty-response'
  | 'max-rounds'
  | 'read-no-data'
  | 'timeout'
  | 'aborted';

export interface TermDist {
  /** 七终态（+read-no-data）→ 条数 */
  buckets: Record<string, number>;
  /** 原始值 → 条数（未做映射） */
  rawValues: Record<string, number>;
  /** 未收录进映射表的原始值 → 条数（单列不崩） */
  unmapped: Record<string, number>;
  total: number;
}

export interface CaptureGroup {
  requestId: string;
  status: number | null;
  bodyBytes: number;
  hasTaskComplete: boolean;
  hasDoneMarker: boolean;
  hasFinishedSignal: boolean;
  agentDriven: boolean;
  classify:
    | 'complete-signal'
    | 'finished-signal'
    | 'long-stream-no-sentinel'
    | 'short-body-no-sentinel'
    | 'no-response-body';
}

export interface TermStateReport {
  trace: TermDist;
  captures: CaptureGroup[];
  logMentions: Record<string, number>;
  /** E. 频率口径；仅当输入含 .jsonl trace 时产出，否则 null（不占节）。 */
  frequency: FrequencyReport | null;
  inputs: string[];
  filesScanned: number;
}

// ---------------------------------------------------------------- 映射表

/** 页端 stopReason / 引擎值 → 七终态。新值出现时进 unmapped 单列，改这里即可。 */
const TERM_MAP: Record<string, HostTerm> = {
  // 宿主侧原生值（model-engine.ts:20 / task-loop.ts）
  complete: 'complete',
  truncated: 'truncated',
  disconnected: 'disconnected',
  unknown: 'unknown',
  'no-tool-calls': 'no-tool-calls',
  'empty-response': 'empty-response',
  'max-rounds': 'max-rounds',
  'read-no-data': 'read-no-data',
  timeout: 'timeout',
  aborted: 'aborted',
  // 页端 turn.end 值（page-runtime trace）
  completed: 'complete',
  'continuation-truncated': 'truncated',
  'truncated-tool-tag': 'truncated',
  'max-loop': 'max-rounds',
  'protocol-repair-failed': 'unknown',
};

export function mapTerm(raw: string): HostTerm | null {
  return Object.prototype.hasOwnProperty.call(TERM_MAP, raw) ? TERM_MAP[raw] : null;
}

// ---------------------------------------------------------------- A. trace turn.end

interface TurnEndLine {
  t?: string;
  stopReason?: string;
  finished?: boolean;
}

export function bucketTraceLines(lines: string[]): TermDist {
  const dist: TermDist = { buckets: {}, rawValues: {}, unmapped: {}, total: 0 };
  for (const rawLine of lines) {
    const s = rawLine.trim();
    if (s === '') continue;
    let obj: TurnEndLine;
    try {
      obj = JSON.parse(s) as TurnEndLine;
    } catch {
      continue; // 非 JSON 行不算证据
    }
    if (typeof obj !== 'object' || obj === null || obj.t !== 'turn.end') continue;
    const reason = typeof obj.stopReason === 'string' ? obj.stopReason : '(缺 stopReason)';
    dist.total++;
    dist.rawValues[reason] = (dist.rawValues[reason] ?? 0) + 1;
    const mapped = mapTerm(reason);
    if (mapped === null) {
      dist.unmapped[reason] = (dist.unmapped[reason] ?? 0) + 1;
      dist.buckets[`unknown(未收录:${reason})`] = (dist.buckets[`unknown(未收录:${reason})`] ?? 0) + 1;
    } else {
      dist.buckets[mapped] = (dist.buckets[mapped] ?? 0) + 1;
    }
  }
  return dist;
}

// ---------------------------------------------------------------- B. CDP 抓包信号

/** task_complete 哨兵：页端判停与宿主 completed 的唯一依据（task-loop.ts:130 同源形态）。 */
const TASK_COMPLETE_RE = /<task_complete>/;
const DONE_MARKER_RE = /\[DONE\]/;
const FINISHED_SIGNAL_RE = /"quasi_status"[^\n]{0,40}"FINISHED"/; // SSE 抓包实测完成信号：{"p":"quasi_status","v":"FINISHED"}（20261102）
const AGENT_SENTINEL_RE = /【Studio Agent】|\[studio-tool-capability/;
const LONG_STREAM_BYTES = 2048;

export function classifyCaptureGroup(
  requestId: string,
  requestText: string | null,
  metaText: string | null,
  bodyText: string | null,
): CaptureGroup {
  let status: number | null = null;
  if (metaText !== null) {
    try {
      const meta = JSON.parse(metaText) as { status?: number };
      if (typeof meta.status === 'number') status = meta.status;
    } catch {
      status = null;
    }
  }
  const agentDriven = requestText !== null && AGENT_SENTINEL_RE.test(requestText);
  if (bodyText === null) {
    return {
      requestId,
      status,
      bodyBytes: 0,
      hasTaskComplete: false,
      hasDoneMarker: false,
      hasFinishedSignal: false,
      agentDriven,
      classify: 'no-response-body',
    };
  }
  const bodyBytes = Buffer.byteLength(bodyText, 'utf8');
  const hasTaskComplete = TASK_COMPLETE_RE.test(bodyText);
  const hasDoneMarker = DONE_MARKER_RE.test(bodyText);
  const hasFinishedSignal = FINISHED_SIGNAL_RE.test(bodyText);
  let classify: CaptureGroup['classify'];
  if (hasTaskComplete) classify = 'complete-signal';
  else if (hasFinishedSignal) classify = 'finished-signal';
  else if (bodyBytes >= LONG_STREAM_BYTES) classify = 'long-stream-no-sentinel';
  else classify = 'short-body-no-sentinel';
  return { requestId, status, bodyBytes, hasTaskComplete, hasDoneMarker, hasFinishedSignal, agentDriven, classify };
}

/** 把一个目录里的 -request.json / -response-meta.json / -response-body.txt 按请求前缀分组后分类。 */
export function scanCaptureDir(dir: string): CaptureGroup[] {
  const files: { rel: string; abs: string }[] = [];
  walk(dir, (rel, abs) => files.push({ rel, abs }));

  const groups = new Map<
    string,
    { request?: string | null; meta?: string | null; body?: string | null }
  >();
  for (const f of files) {
    const base = f.rel.replace(/\\/, '/');
    const m = base.match(/^(.*)-(request\.json|response-meta\.json|response-body\.txt)$/);
    if (!m) continue;
    const id = m[1];
    const g = groups.get(id) ?? {};
    if (m[2] === 'request.json') g.request = readSafe(f.abs);
    else if (m[2] === 'response-meta.json') g.meta = readSafe(f.abs);
    else g.body = readSafe(f.abs);
    groups.set(id, g);
  }

  const out: CaptureGroup[] = [];
  for (const [id, g] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(classifyCaptureGroup(id, g.request ?? null, g.meta ?? null, g.body ?? null));
  }
  return out;
}

// ---------------------------------------------------------------- C. 引擎日志终态提及

/** 提及模式（每类单独计数；一行命中多个模式会分别计入，属已知口径，报告里注明）。 */
const MENTION_PATTERNS: [string, RegExp][] = [
  ['API返回体(read-no-data)', /\(read-no-data\)/g],
  ['API返回体(empty-response)', /\(empty-response\)/g],
  ['engine.completion=', /\bcompletion=(complete|truncated|disconnected|unknown)\b/g],
  ['json.stopReason', /"stopReason"\s*:\s*"([a-z-]+)"/g],
  ['log.reason=', /\breason=(read-no-data|empty-response|page-disconnected|no-page-for-dom-capability)\b/g],
];

export function scanLogMentions(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, re] of MENTION_PATTERNS) {
    const hits = text.match(re);
    if (hits && hits.length > 0) out[name] = (out[name] ?? 0) + hits.length;
  }
  return out;
}

// ---------------------------------------------------------------- 汇总与渲染

export function aggregateLogMentions(perFile: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of perFile) {
    for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

// ---------------------------------------------------------------- E. 频率口径（M3）

/** 同任务相邻间隔超过该值视为跨时段（沿用 Verify 20261102 测量口径），不进连发统计。 */
export const CROSS_SESSION_MS = 30 * 60 * 1000;
/** ≤该值的相邻间隔视为「快速重发对」代理（同 Verify 口径）。 */
export const FAST_RESEND_MS = 5000;
/** 截断类终态：之后同任务仍有轮 → 记一次「截断重发」。 */
const TRUNCATED_TERMS = new Set(['truncated', 'continuation-truncated', 'truncated-tool-tag']);

interface TurnEndFull {
  t?: string;
  turnId?: string;
  stopReason?: string;
  ts?: number;
}

/** 从 jsonl 行里取 turn.end 事件，按有无 turnId 分流（无 turnId 单列不计任务）。 */
export function collectTurnEvents(lines: string[]): { withId: TurnEndFull[]; withoutId: number } {
  const withId: TurnEndFull[] = [];
  let withoutId = 0;
  for (const rawLine of lines) {
    const s = rawLine.trim();
    if (s === '') continue;
    let obj: TurnEndFull;
    try {
      obj = JSON.parse(s) as TurnEndFull;
    } catch {
      continue; // 非 JSON 行不算证据
    }
    if (typeof obj !== 'object' || obj === null || obj.t !== 'turn.end') continue;
    if (typeof obj.turnId === 'string' && obj.turnId !== '') withId.push(obj);
    else withoutId++;
  }
  return { withId, withoutId };
}

/** 线性插值分位数（空集返回 0；调用前需升序）。 */
export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// ---------------------------------------------------------------- M3-1 retry 口径

/**
 * 三类重试的 trace 事件形态（interceptor 实测，源码行号 20261105 核对）：
 *   ① 首轮 retryable 重试：continuation.decision reason='first-attempt-retry' triggered=true
 *      （main-world-interceptor.ts:2620，fetch/XHR 共用 escalateFirstAttemptFailure :2595）
 *   ② 续跑 error-retry：reason='error-retry-<classifyResponse.reason>' triggered=true
 *      （:3004，reason 后缀 = 具体失败原因，分列统计）
 *   ③ 截断重发：reason='continuation-truncated' triggered=true（:3016）
 * 预算耗尽是「重试被拒」不是「重试发生」，单列不计入分子：
 *   - turn.end stopReason='first-attempt-retry-out'（:2605，首轮预算 FIRST_ATTEMPT_MAX_RETRIES 尽）
 *   - continuation.decision reason='error-budget-out' / 'continuation-truncated-budget-out'
 *     （:2981，续跑预算 MAX_ERROR_RETRIES=3 尽，按 isTruncated 分流）
 *
 * 分母：request.sent 打点（:1636 fetch / :1918 XHR / :2885，每条 = 一次实际发出的 chat 请求，
 * 含重试重发）——轮数（turn.end 数）只是请求数下界，两个分母分开列，不混算。
 *
 * 已知缺口（如实注明）：attempt 序号（第几次重试）不在 trace 字段里，
 * 占比只能数事件条数；「重试集中在哪几轮」需先补打点才能测。
 */
export const RETRY_REASON = {
  firstAttempt: 'first-attempt-retry',
  errorRetryPrefix: 'error-retry-',
  truncatedResend: 'continuation-truncated',
} as const;

export interface DecisionEvent {
  turnId?: string;
  reason?: string;
  triggered: boolean;
}

export interface RequestSentEvent {
  turnId?: string;
  bytes?: number;
}

/** 从 jsonl 行里取 continuation.decision / request.sent / first-attempt-retry-out 终态。 */
export function collectRetryEvidence(lines: string[]): {
  decisions: DecisionEvent[];
  requestsSent: RequestSentEvent[];
  firstAttemptRetryOutTurnEnds: number;
} {
  const decisions: DecisionEvent[] = [];
  const requestsSent: RequestSentEvent[] = [];
  let firstAttemptRetryOutTurnEnds = 0;
  for (const rawLine of lines) {
    const s = rawLine.trim();
    if (s === '') continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    if (obj.t === 'continuation.decision' && typeof obj.reason === 'string') {
      decisions.push({
        turnId: typeof obj.turnId === 'string' && obj.turnId !== '' ? obj.turnId : undefined,
        reason: obj.reason,
        triggered: obj.triggered === true,
      });
    } else if (obj.t === 'request.sent') {
      requestsSent.push({
        turnId: typeof obj.turnId === 'string' && obj.turnId !== '' ? obj.turnId : undefined,
        bytes: typeof obj.bytes === 'number' ? obj.bytes : undefined,
      });
    } else if (obj.t === 'turn.end' && obj.stopReason === 'first-attempt-retry-out') {
      firstAttemptRetryOutTurnEnds++;
    }
  }
  return { decisions, requestsSent, firstAttemptRetryOutTurnEnds };
}

export interface RetryReport {
  /** 分母：实际发出请求数（request.sent 计数，含重试重发）。 */
  requestsSent: number;
  /** 其中有 turnId 归属的条数（无 turnId 单列不进每任务聚合）。 */
  requestsSentWithTurnId: number;
  /** 分子（分列，不混算）：各类 triggered=true 的调度事件条数。 */
  firstAttemptRetry: number;
  errorRetry: number;
  errorRetryByReason: Record<string, number>;
  truncatedResend: number;
  /** 预算耗尽（重试被拒，单列）：first-attempt-retry-out 走 turn.end，另两类走 continuation.decision。 */
  budgetOut: { firstAttemptRetryOut: number; errorBudgetOut: number; truncatedBudgetOut: number };
  /** 占比：分子 / 实际发出请求数（分母 0 时为 0）。 */
  retryShare: number;
  perClassShare: { firstAttempt: number; errorRetry: number; truncated: number };
}

export function buildRetryReport(
  decisions: DecisionEvent[],
  requestsSent: RequestSentEvent[],
  firstAttemptRetryOutTurnEnds: number,
): RetryReport {
  let firstAttemptRetry = 0;
  let errorRetry = 0;
  let truncatedResend = 0;
  let errorBudgetOut = 0;
  let truncatedBudgetOut = 0;
  const errorRetryByReason: Record<string, number> = {};
  for (const d of decisions) {
    const reason = d.reason ?? '';
    if (reason === RETRY_REASON.firstAttempt && d.triggered) {
      firstAttemptRetry++;
    } else if (reason.startsWith(RETRY_REASON.errorRetryPrefix) && d.triggered) {
      errorRetry++;
      const sub = reason.slice(RETRY_REASON.errorRetryPrefix.length);
      errorRetryByReason[sub] = (errorRetryByReason[sub] ?? 0) + 1;
    } else if (reason === RETRY_REASON.truncatedResend && d.triggered) {
      truncatedResend++;
    } else if (reason === 'error-budget-out') {
      errorBudgetOut++;
    } else if (reason === 'continuation-truncated-budget-out') {
      truncatedBudgetOut++;
    }
  }
  const denom = requestsSent.length;
  const share = (n: number): number => (denom > 0 ? n / denom : 0);
  const totalRetry = firstAttemptRetry + errorRetry + truncatedResend;
  return {
    requestsSent: denom,
    requestsSentWithTurnId: requestsSent.filter((r) => typeof r.turnId === 'string' && r.turnId !== '').length,
    firstAttemptRetry,
    errorRetry,
    errorRetryByReason,
    truncatedResend,
    budgetOut: { firstAttemptRetryOut: firstAttemptRetryOutTurnEnds, errorBudgetOut, truncatedBudgetOut },
    retryShare: share(totalRetry),
    perClassShare: { firstAttempt: share(firstAttemptRetry), errorRetry: share(errorRetry), truncated: share(truncatedResend) },
  };
}

export interface FrequencyReport {
  /** 口径：turnId = 一次用户消息；轮数 = turn.end 数 = 请求数下界（HTTP 重试无打点）。 */
  taskCount: number;
  totalTurnEnds: number;
  eventsWithoutTurnId: number;
  turnCounts: number[];
  p50: number;
  p90: number;
  max: number;
  tasksOver10: number;
  shareOver10: number;
  /** 同任务相邻间隔（ms，≤30min 的会话内样本，升序）。 */
  intervalSamples: number[];
  crossSessionPairs: number;
  anomalousPairs: number;
  intervalP50: number;
  intervalP90: number;
  intervalMin: number;
  intervalMax: number;
  fastResendPairs: number;
  fastResendShare: number;
  /** 截断重发：截断终态轮之后同任务仍有后续轮。 */
  tasksWithResend: number;
  resendRounds: number;
  resendRoundShare: number;
  /** M3-1：retryable 重试占比（分列口径）；仅当输入含 .jsonl trace 时产出。 */
  retry: RetryReport | null;
}

export function buildFrequencyReport(events: TurnEndFull[], withoutTurnId: number): FrequencyReport {
  const byTask = new Map<string, TurnEndFull[]>();
  for (const e of events) {
    if (typeof e.turnId !== 'string' || e.turnId === '') continue; // 防御：collect 已分流
    const list = byTask.get(e.turnId);
    if (list) list.push(e);
    else byTask.set(e.turnId, [e]);
  }

  const turnCounts: number[] = [];
  const intervalSamples: number[] = [];
  let crossSessionPairs = 0;
  let anomalousPairs = 0;
  let fastResendPairs = 0;
  let tasksWithResend = 0;
  let resendRounds = 0;
  let totalTurns = 0;

  for (const [, evs] of byTask) {
    evs.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const n = evs.length;
    totalTurns += n;
    turnCounts.push(n);

    // E3 可测口径：截断终态轮之后同任务仍有后续轮 → 该轮记一次截断重发
    let taskResends = 0;
    for (let i = 0; i < n - 1; i++) {
      const sr = typeof evs[i].stopReason === 'string' ? (evs[i].stopReason as string) : '';
      if (TRUNCATED_TERMS.has(sr)) taskResends++;
    }
    if (taskResends > 0) {
      tasksWithResend++;
      resendRounds += taskResends;
    }

    // E2 相邻间隔
    for (let i = 1; i < n; i++) {
      const a = evs[i - 1].ts;
      const b = evs[i].ts;
      if (typeof a !== 'number' || typeof b !== 'number' || b < a) {
        anomalousPairs++; // 缺 ts / 倒挂，单列不污染 min
        continue;
      }
      const d = b - a;
      if (d > CROSS_SESSION_MS) {
        crossSessionPairs++;
        continue;
      }
      intervalSamples.push(d);
      if (d <= FAST_RESEND_MS) fastResendPairs++;
    }
  }

  turnCounts.sort((a, b) => a - b);
  intervalSamples.sort((a, b) => a - b);
  const shareBase = totalTurns > 0 ? totalTurns : 1;
  return {
    taskCount: byTask.size,
    totalTurnEnds: totalTurns + withoutTurnId,
    eventsWithoutTurnId: withoutTurnId,
    turnCounts,
    p50: quantile(turnCounts, 0.5),
    p90: quantile(turnCounts, 0.9),
    max: turnCounts.length > 0 ? (turnCounts[turnCounts.length - 1] as number) : 0,
    tasksOver10: turnCounts.filter((c) => c > 10).length,
    shareOver10: turnCounts.length > 0 ? turnCounts.filter((c) => c > 10).length / turnCounts.length : 0,
    intervalSamples,
    crossSessionPairs,
    anomalousPairs,
    intervalP50: quantile(intervalSamples, 0.5),
    intervalP90: quantile(intervalSamples, 0.9),
    intervalMin: intervalSamples.length > 0 ? (intervalSamples[0] as number) : 0,
    intervalMax: intervalSamples.length > 0 ? (intervalSamples[intervalSamples.length - 1] as number) : 0,
    fastResendPairs,
    fastResendShare: intervalSamples.length > 0 ? fastResendPairs / intervalSamples.length : 0,
    tasksWithResend,
    resendRounds,
    resendRoundShare: resendRounds / shareBase,
    retry: null, // main() 采集到 continuation.decision / request.sent 后回填
  };
}

function fmtDist(dist: TermDist, title: string): string[] {
  const out: string[] = [`## ${title}`, ''];
  out.push(`turn.end 事件总数：${dist.total}`);
  out.push('');
  out.push('| 七终态（映射后） | 条数 | 占比 |');
  out.push('|---|---|---|');
  const keys = [...Object.keys(dist.buckets)].sort((a, b) => (dist.buckets[b] ?? 0) - (dist.buckets[a] ?? 0));
  for (const k of keys) {
    const n = dist.buckets[k] ?? 0;
    const pct = dist.total > 0 ? ((n / dist.total) * 100).toFixed(1) + '%' : '-';
    out.push(`| ${k} | ${n} | ${pct} |`);
  }
  if (keys.length === 0) out.push('| （无 turn.end 事件） | 0 | - |');
  out.push('');
  out.push('原始值明细：');
  const rawKeys = [...Object.keys(dist.rawValues)].sort((a, b) => (dist.rawValues[b] ?? 0) - (dist.rawValues[a] ?? 0));
  for (const k of rawKeys) {
    const mapped = mapTerm(k);
    out.push(`- \`${k}\` × ${dist.rawValues[k]} → ${mapped === null ? '**未收录→unknown 单列**' : mapped}`);
  }
  if (rawKeys.length === 0) out.push('- （无）');
  out.push('');
  return out;
}

function fmtCaptures(caps: CaptureGroup[]): string[] {
  const out: string[] = ['## C. CDP 抓包信号（按请求分组，只探测布尔与字节数，不外泄内容）', ''];
  const byClass = new Map<string, number>();
  for (const c of caps) byClass.set(c.classify, (byClass.get(c.classify) ?? 0) + 1);
  out.push('| 分类 | 请求数 |');
  out.push('|---|---|');
  for (const k of [...byClass.keys()].sort()) out.push(`| ${k} | ${byClass.get(k)} |`);
  if (byClass.size === 0) out.push('| （无抓包） | 0 |');
  out.push('');
  out.push('明细：');
  for (const c of caps) {
    out.push(
      `- ${c.requestId}：status=${c.status ?? '?'} body=${c.bodyBytes}B agent=${c.agentDriven ? 'Y' : 'N'} task_complete=${c.hasTaskComplete ? 'Y' : 'N'} FINISHED=${c.hasFinishedSignal ? 'Y' : 'N'} [DONE]=${c.hasDoneMarker ? 'Y' : 'N'} → ${c.classify}`,
    );
  }
  if (caps.length === 0) out.push('- （无）');
  out.push('');
  return out;
}

function fmtMentions(m: Record<string, number>): string[] {
  const out: string[] = ['## D. 引擎日志终态提及（verify-exit 等，模式各自计数、不做跨模式去重）', ''];
  out.push('| 模式 | 命中次数 |');
  out.push('|---|---|');
  const keys = [...Object.keys(m)].sort((a, b) => (m[b] ?? 0) - (m[a] ?? 0));
  for (const k of keys) out.push(`| ${k} | ${m[k]} |`);
  if (keys.length === 0) out.push('| （无命中） | 0 |');
  out.push('');
  return out;
}

function fmtFrequency(f: FrequencyReport): string[] {
  const pctStr = (x: number): string => (x * 100).toFixed(1) + '%';
  // 线性插值分位会带浮点尾巴（如 8200.000000000007），近整数取整、其余保留 1 位小数
  const num = (x: number): string => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1));
  const out: string[] = ['## E. 频率口径（M3：每任务请求表面积；轮数 = turn.end 数 ≈ 请求数下界）', ''];
  out.push('### E1. 每任务请求数分布（分组键 turnId = 一次用户消息触发的全部请求）');
  out.push('');
  out.push('| 指标 | 值 |');
  out.push('|---|---|');
  out.push(`| 任务数（distinct turnId） | ${f.taskCount} |`);
  out.push(`| turn.end 事件总数 | ${f.totalTurnEnds}（无 turnId 单列 ${f.eventsWithoutTurnId}，不计任务） |`);
  out.push(`| 请求数 P50 / P90 / max | ${num(f.p50)} / ${num(f.p90)} / ${num(f.max)} |`);
  out.push(`| 请求数 >10 的任务 | ${f.tasksOver10}（占比 ${pctStr(f.shareOver10)}） |`);
  out.push('');
  out.push('### E2. 同任务相邻请求间隔（ms）');
  out.push('');
  out.push('| 指标 | 值 |');
  out.push('|---|---|');
  out.push(`| 会话内间隔样本数（≤30min） | ${f.intervalSamples.length} |`);
  out.push(`| 跨时段间隔对（>30min，剔出连发统计） | ${f.crossSessionPairs} |`);
  out.push(`| 异常对（缺 ts / 倒挂，单列） | ${f.anomalousPairs} |`);
  out.push(`| 会话内 P50 / P90 (ms) | ${num(f.intervalP50)} / ${num(f.intervalP90)} |`);
  out.push(`| 会话内最小 / 最大 (ms) | ${f.intervalMin} / ${f.intervalMax} |`);
  out.push(`| ≤5000ms 的「快速重发对」（占会话内间隔） | ${f.fastResendPairs}（${pctStr(f.fastResendShare)}） |`);
  out.push('');
  out.push('### E3. 重试占比（M3-1 分列口径：分子分列、预算耗尽单列、两个分母不混算）');
  out.push('');
  const r = f.retry;
  if (r === null) {
    out.push('| retryable HTTP 重试占比 | 数据源缺失（输入无 .jsonl trace，缺报不编数） |');
  } else {
    // 「未采集」与「采集到 0」必须区分（PM 20261105：空值不是零）：
    // retry 证据（request.sent + 三类调度事件 + 预算耗尽）全零 = 落盘白名单未放行
    // （interceptor :649 只放行 turn.end / m15.*）或该批无聊天流量 → 显示「未采集」；
    // 任一证据非零 → 显示真实数字。
    const hasRetryEvidence =
      r.requestsSent > 0 ||
      r.firstAttemptRetry + r.errorRetry + r.truncatedResend > 0 ||
      r.budgetOut.firstAttemptRetryOut + r.budgetOut.errorBudgetOut + r.budgetOut.truncatedBudgetOut > 0;
    if (!hasRetryEvidence) {
      out.push('| 指标 | 值 |');
      out.push('|---|---|');
      out.push('| **分母 A：实际发出请求数** | **未采集（无打点）** |');
      out.push('| 分子①②③（三类重试） | **未采集（无打点）** |');
      out.push(`| 对照：分母 B（轮数下界 = turn.end 数，与分母 A 不混算） | ${f.totalTurnEnds - f.eventsWithoutTurnId} |`);
      out.push('');
      out.push('**未采集 ≠ 零**：当前 `logs/trace/*.jsonl` 里没有任何 retry 证据事件——原因是落盘白名单（interceptor :649）尚未放行 `continuation.decision` / `request.sent` 两类事件（见 ⚠️ 备注），此状态下**不许把重试占比写成 0**。');
    } else {
      out.push('| 指标 | 值 |');
      out.push('|---|---|');
      out.push(`| **分母 A：实际发出请求数**（request.sent 计数，含重试重发） | ${r.requestsSent}（有 turnId 归属 ${r.requestsSentWithTurnId}） |`);
      out.push(`| 分子① 首轮 retryable 重试（reason='first-attempt-retry'） | ${r.firstAttemptRetry}（占分母 A ${pctStr(r.perClassShare.firstAttempt)}） |`);
      const sub = Object.keys(r.errorRetryByReason).sort().map((k) => `${k}×${r.errorRetryByReason[k]}`).join('， ') || '（无）';
      out.push(`| 分子② 续跑 error-retry（reason='error-retry-<原因>'，分列） | ${r.errorRetry}（占分母 A ${pctStr(r.perClassShare.errorRetry)}）；原因明细：${sub} |`);
      out.push(`| 分子③ 截断重发（reason='continuation-truncated'） | ${r.truncatedResend}（占分母 A ${pctStr(r.perClassShare.truncated)}） |`);
      out.push(`| **重试合计 / 分母 A** | ${r.firstAttemptRetry + r.errorRetry + r.truncatedResend} / ${r.requestsSent}（**${pctStr(r.retryShare)}**） |`);
      out.push(`| 代理口径·含截断重发的任务数（turn.end 序列推断） | ${f.tasksWithResend} / ${f.taskCount} |`);
      out.push(`| 代理口径·截断重发轮数 / 有归属轮总数 | ${f.resendRounds} / ${f.totalTurnEnds - f.eventsWithoutTurnId}（${pctStr(f.resendRoundShare)}） |`);
      out.push(`| 预算耗尽·首轮（turn.end 'first-attempt-retry-out'，不计分子） | ${r.budgetOut.firstAttemptRetryOut} |`);
      out.push(`| 预算耗尽·续跑（'error-budget-out' / 'continuation-truncated-budget-out'，不计分子） | ${r.budgetOut.errorBudgetOut} / ${r.budgetOut.truncatedBudgetOut} |`);
      out.push(`| 对照：分母 B（轮数下界 = turn.end 数，与分母 A **不混算**） | ${f.totalTurnEnds - f.eventsWithoutTurnId} |`);
    }
    out.push('');
    out.push('口径备注：');
    out.push('- 分子 = `continuation.decision` 里各类 `triggered:true` 的**调度事件条数**（每次调度 → 一条 request.sent）；分母 = `request.sent` 打点数（**实际发出请求数**，含重试重发）。');
    out.push('- 轮数（turn.end 数）只是请求数**下界**（turn.end 在轮结束时打、HTTP 重试不产生新轮），与分母 A 是两个口径，E1 表的「请求数分布」仍是下界口径。');
    out.push('- **attempt 序号不在 trace 字段里**（interceptor :2619 的 d() 日志有、record 没带）：占比按事件条数计，「重试集中在哪几轮」需补打点才能测——如实缺报。');
    out.push('- **⚠️ 落盘白名单缺口（20261105 核实）**：`interceptorTrace.record` 的落盘白名单只有 `turn.end` 与 `m15.*`（main-world-interceptor.ts:649），`continuation.decision` / `request.sent` **只进内存环（2000 条上限）、不落盘**——白名单放行前，本表的分母 A / 分子恒走「未采集」分支。聚合侧已就绪（本文件测试锁定），UI 域把这两类加进 :649 白名单后真数据即流入。');
    out.push('- 截断重发的 E3 代理口径（turn.end 序列推断）与真打点口径并存：前者是轮级代理、后者是请求级实测，互不替代。');
  }
  out.push('');
  out.push('### 判读口径（字节类与频率类分开，不互相推论）');
  out.push('');
  out.push('- **字节类只回答成本**：Σ bodyBytes（见 C 表）回答"花了多少流量"，与请求次数无关。');
  out.push('- **频率类只回答请求表面积**：E1/E2/E3 回答"发了多少请求、多密、多少是重发"，与字节量无关。');
  out.push('- 本脚本不产出「所以被限流」类合成结论：成本高≠频率高，频率高≠成本高，两件事互相独立。');
  out.push('');
  return out;
}

export function renderReport(r: TermStateReport): string {
  const out: string[] = [];
  out.push('# 终态分布（离线测量，只读不改）');
  out.push('');
  out.push(`- 生成：${new Date().toISOString()}　脚本：tools/metrics/term-state.ts`);
  out.push(`- 输入：${r.inputs.join(' , ')}（扫描 ${r.filesScanned} 个文件）`);
  out.push('- 退出码语义：0=≥1 条终态证据被分桶；1=输入存在但 0 条终态证据；2=输入路径全部不可读');
  out.push('');
  out.push(...fmtDist(r.trace, 'A. 页端 trace turn.end 七终态视图（映射表见 TERM_MAP）'));
  out.push(...fmtCaptures(r.captures));
  out.push(...fmtMentions(r.logMentions));
  if (r.frequency !== null) out.push(...fmtFrequency(r.frequency));
  out.push('## 局限');
  out.push('');
  out.push('- 三类证据分开计数，不做跨类合并；同一轮在 trace 与抓包里各计一次是口径而非错误。');
  out.push('- 未知 stopReason 进 `unknown(未收录:…)` 单列，不崩、不吞；映射表补录后再复跑即可归位。');
  out.push('- CDP 抓包为布尔/字节探测，绝不输出响应体内容本身。');
  return out.join('\n');
}

// ---------------------------------------------------------------- IO

const SCAN_EXTS = new Set(['.jsonl', '.json', '.log', '.txt']);

function readSafe(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function walk(dir: string, cb: (rel: string, abs: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, (rel, a) => cb(join(e, rel), a));
    else if (SCAN_EXTS.has(extname(e).toLowerCase())) cb(e, abs);
  }
}

function collectInputs(paths: string[]): { files: string[]; missing: number } {
  const files: string[] = [];
  let missing = 0;
  for (const p of paths) {
    if (!existsSync(p)) {
      missing++;
      continue;
    }
    const st = statSync(p);
    if (st.isFile()) {
      files.push(p);
    } else {
      const found: string[] = [];
      walk(p, (_rel, abs) => found.push(abs));
      files.push(...found);
    }
  }
  return { files, missing };
}

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');

  const argv = process.argv.slice(2);
  let outFile: string | null = null;
  const outIdx = argv.indexOf('--out');
  if (outIdx >= 0) {
    outFile = argv[outIdx + 1] ?? null;
    argv.splice(outIdx, 2);
  }
  const inputPaths = argv.length > 0 ? argv : [
    join(root, 'logs', 'trace'),
    join(root, 'logs', 'cdp-chat-capture'),
    join(root, 'logs', 'verify-exit'),
  ];

  const { files, missing } = collectInputs(inputPaths);
  if (files.length === 0) {
    console.error(`[term-state] 无可读输入（缺失 ${missing} 个路径）：${inputPaths.join(' , ')}`);
    process.exit(2);
  }

  const report: TermStateReport = {
    trace: { buckets: {}, rawValues: {}, unmapped: {}, total: 0 },
    captures: [],
    logMentions: {},
    frequency: null,
    inputs: inputPaths,
    filesScanned: 0,
  };
  const mentionParts: Record<string, number>[] = [];
  const freqEvents: TurnEndFull[] = [];
  const retryDecisions: DecisionEvent[] = [];
  const retryRequestsSent: RequestSentEvent[] = [];
  let firstAttemptRetryOutTurnEnds = 0;
  let freqWithoutId = 0;
  let hasTraceJsonl = false;

  for (const f of files) {
    report.filesScanned++;
    const ext = extname(f).toLowerCase();
    const text = readSafe(f);
    if (text === null) continue;
    if (ext === '.jsonl') {
      hasTraceJsonl = true;
      const d = bucketTraceLines(text.split('\n'));
      report.trace.total += d.total;
      for (const [k, v] of Object.entries(d.buckets)) report.trace.buckets[k] = (report.trace.buckets[k] ?? 0) + v;
      for (const [k, v] of Object.entries(d.rawValues)) report.trace.rawValues[k] = (report.trace.rawValues[k] ?? 0) + v;
      for (const [k, v] of Object.entries(d.unmapped)) report.trace.unmapped[k] = (report.trace.unmapped[k] ?? 0) + v;
      const allLines = text.split('\n');
      const ev = collectTurnEvents(allLines);
      freqEvents.push(...ev.withId);
      freqWithoutId += ev.withoutId;
      // M3-1：retry 证据与 turn.end 同源同文件采集（continuation.decision / request.sent）
      const retryEv = collectRetryEvidence(allLines);
      retryDecisions.push(...retryEv.decisions);
      retryRequestsSent.push(...retryEv.requestsSent);
      firstAttemptRetryOutTurnEnds += retryEv.firstAttemptRetryOutTurnEnds;
    } else {
      mentionParts.push(scanLogMentions(text));
      if (ext === '.json' || ext === '.txt') {
        // verify-exit 里的分组抓包形态（round*.samples.jsonl 走 mention；capture 目录由专门扫描处理）
      }
    }
  }
  report.logMentions = aggregateLogMentions(mentionParts);
  if (hasTraceJsonl) {
    report.frequency = buildFrequencyReport(freqEvents, freqWithoutId);
    report.frequency.retry = buildRetryReport(retryDecisions, retryRequestsSent, firstAttemptRetryOutTurnEnds);
  }

  // capture 目录：仅当输入里显式包含 cdp-chat-capture 目录时分组扫描
  for (const p of inputPaths) {
    if (existsSync(p) && statSync(p).isDirectory() && /cdp-chat-capture$/.test(p.replace(/\\/g, '/'))) {
      report.captures.push(...scanCaptureDir(p));
    }
  }

  const hasEvidence = report.trace.total > 0 || report.captures.length > 0 || Object.keys(report.logMentions).length > 0;
  const md = renderReport(report);

  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, md + '\n', 'utf8');
    console.log(`[term-state] 报告已写 ${outFile}`);
  } else {
    console.log(md);
  }

  process.exit(hasEvidence ? 0 : 1);
}

// 仅直接执行时跑 main
const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('term-state.ts');
if (isDirectRun) {
  main();
}
