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
    inputs: inputPaths,
    filesScanned: 0,
  };
  const mentionParts: Record<string, number>[] = [];

  for (const f of files) {
    report.filesScanned++;
    const ext = extname(f).toLowerCase();
    const text = readSafe(f);
    if (text === null) continue;
    if (ext === '.jsonl') {
      const d = bucketTraceLines(text.split('\n'));
      report.trace.total += d.total;
      for (const [k, v] of Object.entries(d.buckets)) report.trace.buckets[k] = (report.trace.buckets[k] ?? 0) + v;
      for (const [k, v] of Object.entries(d.rawValues)) report.trace.rawValues[k] = (report.trace.rawValues[k] ?? 0) + v;
      for (const [k, v] of Object.entries(d.unmapped)) report.trace.unmapped[k] = (report.trace.unmapped[k] ?? 0) + v;
    } else {
      mentionParts.push(scanLogMentions(text));
      if (ext === '.json' || ext === '.txt') {
        // verify-exit 里的分组抓包形态（round*.samples.jsonl 走 mention；capture 目录由专门扫描处理）
      }
    }
  }
  report.logMentions = aggregateLogMentions(mentionParts);

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
