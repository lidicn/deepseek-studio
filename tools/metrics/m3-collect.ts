#!/usr/bin/env tsx
/**
 * tools/metrics/m3-collect.ts — M3 真机 trace 采集流水线（**只读采集 + 离线分析**）
 *
 * 为什么需要它（路线图 §19.2①）：M3 要的是**连续多天的真机频率指标**——每任务请求数
 * P50/P90、同任务相邻请求间隔、重试占比。现成的只有离线分析器（`term-state.ts`）和
 * 一次性的离线分布（`logs/baseline/20261102-offline-term-state.md`），**没有按天归档 + 每日
 * 出表 + 断档可见**的机制。缺它就算跑满 7 天也答不了「为什么聊不下去」。
 *
 * ── 真机 trace 从哪来（实测，非推断）──────────────────────────────────────
 *   · 写入方三处，写的都是**同一个**文件：
 *       src/host/trace-log.ts:22-30        （宿主侧 appendTraceLine）
 *       src/host/page-runtime.ts:459-471   （页端 msg.type==='trace'）
 *       （页内 `interceptorTrace` 只进内存环，不落盘）
 *   · 路径 = `<process.cwd()>/logs/trace/trace-<UTC日期>.jsonl`
 *       —— **按 UTC 天分文件**，名称天然是 `YYYY-MM-DD`。
 *   · 只 append，**没有滚动/覆盖机制**：不存在保留天数上限，旧文件不会被自动删除。
 *     唯一的坑是 `process.cwd()`：安装版 cwd = app_data_dir（`…\AppData\Roaming\com.deepseek.studio`），
 *     dev 树 cwd = 仓库根 —— 两处各写各的，所以本工具支持 `--source` 指定多个源目录。
 *
 * ── 本工具做什么（以及**不**做什么）──────────────────────────────────────────
 *   1. 按天**复制**到归档目录（`<archive>/<YYYY-MM-DD>/trace-<YYYY-MM-DD>.jsonl`）：
 *      原始字节原样保留（逐字节比对过才写），源文件**只读**——不改、不删、不移动。
 *   2. 写机器可读 manifest：每天多少文件/多少事件/起止时间/字节数 + **断档清单**。
 *      断档（连续日期里没有文件的那些天）必须显式列出 —— 「未观测 ≠ 不存在」。
 *   3. 逐日调 `term-state.ts` 的 `buildFrequencyReport` 出每日 Markdown 分布，
 *      表头/口径与 `logs/baseline/20261102-offline-term-state.md` 对齐（不另起一套格式）。
 *   4. 样本不足时**明说样本不足**，不算数、不编数。
 *
 * 纪律：只读；不碰 memories.db / config.json；不改产品行为（trace 打点、注入逻辑、请求策略一概不动）。
 *
 * 用法：
 *   npx tsx tools/metrics/m3-collect.ts                        # 采集 + 出表（默认源=仓库 logs/trace）
 *   npx tsx tools/metrics/m3-collect.ts --source <dir> [...]   # 追加源目录（如安装版 app_data 下的 logs/trace）
 *   npx tsx tools/metrics/m3-collect.ts --archive <dir>        # 归档根（默认 E:\NAS\deepseek-studio\data\m3-archive）
 *   npx tsx tools/metrics/m3-collect.ts --out <dir>            # 分布表输出目录（默认 <archive>/daily）
 *   npx tsx tools/metrics/m3-collect.ts --sample-min 20        # 样本不足阈值（任务数下限）
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFrequencyReport,
  buildRetryReport,
  collectRetryEvidence,
  collectTurnEvents,
  type FrequencyReport,
} from './term-state';

// ──────────────────────────────────────────────────────────── 类型

export interface DayStat {
  /** `YYYY-MM-DD`（UTC，与 trace 文件名同源）。 */
  day: string;
  /** 该天在**所有**源目录里找到的文件（每源一个）。 */
  sourceFiles: string[];
  /** 归档副本路径（写不进去时为 null）。 */
  archivedTo: string | null;
  bytes: number;
  /** 文件里所有 JSONL 行数（含非 trace 事件）。 */
  lines: number;
  /** `turn.end` 且带 turnId 的事件数。 */
  turnEnds: number;
  /** `turn.end` 但缺 turnId 的事件数（单列，不算任务）。 */
  turnEndsWithoutId: number;
  /** 最早 / 最晚事件 ts（ms）。无 ts 时为 null。 */
  firstTs: number | null;
  lastTs: number | null;
  /** 归档方式：copy=单源逐字节复制；merged=多源同日合并（每源前后加来源标记行）；none=未归档。 */
  archiveMode: 'copy' | 'merged' | 'none';
  /** 源文件与归档副本逐字节一致的校验结果（仅 copy 模式有意义）。 */
  byteIdentical: boolean;
  sha256: string;
  /** 该天的频率报告（样本不足时也照样给出，由 `sampleSufficient` 标注）。 */
  frequency: FrequencyReport;
  /** 任务数是否达到 `--sample-min` 阈值；不足时报告必须明说，不编数。 */
  sampleSufficient: boolean;
}

export interface CollectResult {
  generatedAt: string;
  sources: string[];
  /** 每个源目录是否存在（不存在要显式列出，不能静默当 0）。 */
  sourceStatus: Array<{ dir: string; exists: boolean }>;
  /** 扫描到的全部日期（升序）。 */
  days: DayStat[];
  /** 起止日期之间**没有** trace 文件的天（断档必须可见）。 */
  gaps: string[];
  /** 源目录里出现过、但不符合 `trace-YYYY-MM-DD.jsonl` 的条目（防止「采集不到」被静默）。 */
  ignoredEntries: string[];
  totals: {
    days: number;
    files: number;
    bytes: number;
    turnEnds: number;
    tasks: number;
    sampleSufficientDays: number;
    sampleInsufficientDays: number;
  };
}

export interface CollectOptions {
  /** 源目录（可多个；默认仓库 logs/trace）。 */
  sources: string[];
  /** 归档根目录。 */
  archiveDir: string;
  /** 每日分布输出目录。 */
  outDir: string;
  /** 样本不足阈值：任务数 < 该值即标注「样本不足」。 */
  sampleMin: number;
  /** 是否写盘（负控/单测里可设 false，只算不写）。 */
  write: boolean;
}

// ──────────────────────────────────────────────────────────── 纯逻辑

const TRACE_NAME_RE = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** 逐行解析，统计事件与时间戳（容错：坏行跳过，不静默吞计数）。 */
export function parseTraceText(text: string): {
  lines: number;
  turnEnds: number;
  turnEndsWithoutId: number;
  firstTs: number | null;
  lastTs: number | null;
} {
  let lines = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const raw of text.split('\n')) {
    const s = raw.trim();
    if (s === '') continue;
    lines += 1;
    try {
      const obj = JSON.parse(s) as { ts?: unknown };
      if (typeof obj.ts === 'number' && Number.isFinite(obj.ts)) {
        if (firstTs === null || obj.ts < firstTs) firstTs = obj.ts;
        if (lastTs === null || obj.ts > lastTs) lastTs = obj.ts;
      }
    } catch {
      continue; // 非 JSON 行：计入 lines，不计时间戳
    }
  }
  const ev = collectTurnEvents(text.split('\n'));
  return {
    lines,
    turnEnds: ev.withId.length,
    turnEndsWithoutId: ev.withoutId,
    firstTs,
    lastTs,
  };
}

/** 日期序列 [from..to]，两端闭区间（用于找出断档）。 */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** 起止之间的断档（升序）。 */
export function findGaps(days: string[]): string[] {
  if (days.length < 2) return [];
  const sorted = [...days].sort();
  const all = dateRange(sorted[0], sorted[sorted.length - 1]);
  const have = new Set(sorted);
  return all.filter((d) => !have.has(d));
}

/** 样本是否足够（任务数下限）。不足就标注，不编数。 */
export function isSampleSufficient(tasks: number, sampleMin: number): boolean {
  return tasks >= sampleMin;
}

// ──────────────────────────────────────────────────────────── 采集

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 列出源目录里的 trace 文件（只读；非匹配条目单独记下，便于发现命名漂移）。 */
function listSourceFiles(
  sources: string[],
): { byDay: Map<string, string[]>; status: CollectResult['sourceStatus']; ignored: string[] } {
  const byDay = new Map<string, string[]>();
  const status: CollectResult['sourceStatus'] = [];
  const ignored: string[] = [];
  for (const raw of sources) {
    const dir = resolve(raw);
    const exists = existsSync(dir);
    status.push({ dir, exists });
    if (!exists) continue;
    for (const name of readdirSync(dir)) {
      const m = TRACE_NAME_RE.exec(name);
      if (!m) {
        ignored.push(join(dir, name));
        continue;
      }
      const list = byDay.get(m[1]) ?? [];
      list.push(join(dir, name));
      byDay.set(m[1], list);
    }
  }
  return { byDay, status, ignored };
}

/** 采集一天：读源（只读）→ 归档副本（字节一致）→ 统计 + 频率报告。 */
export function collectDay(
  day: string,
  sourceFiles: string[],
  archiveDir: string,
  sampleMin: number,
  write: boolean,
): DayStat {
  const texts: string[] = [];
  let bytes = 0;
  for (const f of sourceFiles) {
    const buf = readFileSync(f); // 只读
    bytes += buf.length;
    texts.push(buf.toString('utf8'));
  }
  const text = texts.join('\n');
  const stat = parseTraceText(text);

  let archivedTo: string | null = null;
  let byteIdentical = false;
  let archiveMode: 'copy' | 'merged' | 'none' = 'none';
  const sha256 = sha256Of(Buffer.from(text, 'utf8'));

  if (write && sourceFiles.length === 1) {
    const dayDir = join(archiveDir, day);
    mkdirSync(dayDir, { recursive: true });
    const target = join(dayDir, `trace-${day}.jsonl`);
    if (!existsSync(target)) copyFileSync(sourceFiles[0], target);
    archivedTo = target;
    archiveMode = 'copy';
    const a = readFileSync(sourceFiles[0]);
    const b = readFileSync(target);
    byteIdentical = a.length === b.length && sha256Of(a) === sha256Of(b);
  } else if (write && sourceFiles.length > 1) {
    // 多个源同时有这一天：合并成一份归档副本（标注来源），原始文件各自不动。
    const dayDir = join(archiveDir, day);
    mkdirSync(dayDir, { recursive: true });
    const target = join(dayDir, `trace-${day}.jsonl`);
    if (!existsSync(target)) {
      const srcLines = sourceFiles
        .map((f) => `{"t":"m3.archive.source","file":${JSON.stringify(f)},"day":"${day}"}`)
        .join('\n');
      writeFileSync(target, `${srcLines}\n`, 'utf8');
      for (const f of sourceFiles) appendFileSync(target, readFileSync(f));
    }
    archivedTo = target;
    archiveMode = 'merged';
  }

  const ev = collectTurnEvents(text.split('\n'));
  const frequency = buildFrequencyReport(ev.withId, ev.withoutId);

  // retryable 重试：只有当日 trace **真的**含 continuation.decision / request.sent 才回填。
  // 一个事件都没有 = 数据流没接（白名单未放行）→ 保持 null，表上写「未采集」而不是 0。
  const retryEv = collectRetryEvidence(text.split('\n'));
  if (retryEv.decisions.length > 0 || retryEv.requestsSent.length > 0) {
    frequency.retry = buildRetryReport(retryEv.decisions, retryEv.requestsSent, retryEv.firstAttemptRetryOutTurnEnds);
  }

  return {
    day,
    sourceFiles,
    archivedTo,
    bytes,
    lines: stat.lines,
    turnEnds: stat.turnEnds,
    turnEndsWithoutId: stat.turnEndsWithoutId,
    firstTs: stat.firstTs,
    lastTs: stat.lastTs,
    archiveMode,
    byteIdentical,
    sha256,
    frequency,
    sampleSufficient: isSampleSufficient(frequency.taskCount, sampleMin),
  };
}

export function collectAll(opts: CollectOptions): CollectResult {
  const { byDay, status, ignored } = listSourceFiles(opts.sources);
  const days = [...byDay.keys()].sort();
  const stats = days.map((d) => collectDay(d, byDay.get(d) ?? [], opts.archiveDir, opts.sampleMin, opts.write));
  const gaps = findGaps(days);
  const totals = {
    days: stats.length,
    files: stats.reduce((n, s) => n + s.sourceFiles.length, 0),
    bytes: stats.reduce((n, s) => n + s.bytes, 0),
    turnEnds: stats.reduce((n, s) => n + s.turnEnds, 0),
    tasks: stats.reduce((n, s) => n + s.frequency.taskCount, 0),
    sampleSufficientDays: stats.filter((s) => s.sampleSufficient).length,
    sampleInsufficientDays: stats.filter((s) => !s.sampleSufficient).length,
  };
  return {
    generatedAt: new Date().toISOString(),
    sources: opts.sources.map((s) => resolve(s)),
    sourceStatus: status,
    days: stats,
    gaps,
    ignoredEntries: ignored,
    totals,
  };
}

// ──────────────────────────────────────────────────────────── 渲染（对齐 baseline 口径）

/** 结构化数字统一保留 2 位（避免 1.4000000000000004 这类浮点尾数污染表）。 */
function num(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}

function iso(ts: number | null): string {
  return ts === null ? '—' : new Date(ts).toISOString();
}

/**
 * 每日分布（Markdown）。表头/指标名与
 * `logs/baseline/20261102-offline-term-state.md` 的「频率」「E3 重试占比」两节保持一致，
 * 不另起一套口径。
 */
export function renderDailyMarkdown(day: DayStat, sampleMin: number): string {
  const f = day.frequency;
  const sufficient = day.sampleSufficient;
  const out: string[] = [];
  out.push(`# M3 每日频率分布 · ${day.day}（只读采集，离线分析）`);
  out.push('');
  out.push(`- 生成：${new Date().toISOString()}　脚本：tools/metrics/m3-collect.ts（分析器：tools/metrics/term-state.ts）`);
  out.push(`- 源文件：${day.sourceFiles.join(' , ') || '（无）'}`);
  out.push(`- 归档副本：${day.archivedTo ?? '（未归档）'}（方式：${day.archiveMode}；逐字节一致：${day.byteIdentical ? '是' : day.archiveMode === 'copy' ? '**否**' : '不适用'}）`);
  out.push(`- 样本：${day.lines} 行 / turn.end ${day.turnEnds}（缺 turnId ${day.turnEndsWithoutId} 单列）/ 任务 ${f.taskCount}`);
  out.push(`- 时间范围：${iso(day.firstTs)} ~ ${iso(day.lastTs)}`);
  out.push('');
  if (!sufficient) {
    out.push(`> **样本不足**：当日任务数 ${f.taskCount} < 阈值 ${sampleMin}。下表照列但不作结论——`);
    out.push('> 「未观测 ≠ 不存在」，不要拿单日小样本推总体。');
    out.push('');
  }
  out.push('### E1. 每任务请求数（轮数 = turn.end 数 = 请求数下界）');
  out.push('');
  out.push('| 指标 | 值 |');
  out.push('|---|---|');
  out.push(`| 任务数 / 有归属轮总数 | ${f.taskCount} / ${f.totalTurnEnds - f.eventsWithoutTurnId} |`);
  out.push(`| P50 / P90 / max | ${num(f.p50)} / ${num(f.p90)} / ${f.max} |`);
  out.push(`| >10 轮任务占比 | ${f.tasksOver10} / ${f.taskCount}（${(f.shareOver10 * 100).toFixed(1)}%） |`);
  out.push('');
  out.push('### E2. 同任务相邻请求间隔（≤30min 会话内）');
  out.push('');
  out.push('| 指标 | 值 |');
  out.push('|---|---|');
  out.push(`| 会话内间隔样本数（≤30min） | ${f.intervalSamples.length} |`);
  out.push(`| 会话内 P50 / P90 (ms) | ${f.intervalP50} / ${f.intervalP90} |`);
  out.push(`| 会话内最小 / 最大 (ms) | ${f.intervalMin} / ${f.intervalMax} |`);
  out.push(`| ≤5000ms 的「同轮双事件」占比（**≠ 独立请求间隔**） | ${f.fastResendPairs}（${(f.fastResendShare * 100).toFixed(1)}%） |`);
  out.push('');
  out.push(
    '> 口径：「同轮双事件」= 同一轮出现多个 turn.end（协议修复/终态重复落盘），' +
      '**不是独立请求风暴**；与上面的「独立请求间隔」分开读，别当成行为结论。',
  );
  out.push('');
  out.push('### E3. 重试占比（两种分母分列，不混算）');
  out.push('');
  out.push('| 指标 | 值 |');
  out.push('|---|---|');
  out.push(`| 含截断重发的任务数 | ${f.tasksWithResend} / ${f.taskCount} |`);
  out.push(`| 截断重发轮数 / **分母 B（轮数下界）** | ${f.resendRounds} / ${f.totalTurnEnds - f.eventsWithoutTurnId}（${(f.resendRoundShare * 100).toFixed(1)}%） |`);
  pushRetryRows(out, f);
  out.push('');
  out.push('## 局限');
  out.push('');
  out.push('- 本表由 `term-state.ts` 的同一套频率口径生成，表头与 baseline 报告一致，不另起口径。');
  out.push('- trace 按 **UTC 天**分文件；本地 08:00 前的事件会落在前一天，跨时区比较时注意。');
  out.push(`- 采集范围 = 源目录里实际存在的 trace 文件；缺失日期见 manifest 的 \`gaps\`，不补零、不推测。`);
  out.push('');
  return out.join('\n');
}

/**
 * E3 的 retryable 重试占比两行（分母 A = request.sent 实际发出请求；分母 B = 轮数下界已在上面单独成行）。
 *
 * **空值不是零**：`f.retry === null` 表示「未采集（无打点）」——历史 trace 里
 * `continuation.decision` / `request.sent` 不进落盘白名单（`main-world-interceptor.ts:649`
 * 只放行 `turn.end` 与 `m15.*`），此时该行必须写「未采集（无打点）」，**不许出 0**。
 * UI 域放行落盘后这里才会有真数据。口径由 Studio-PM 20261105 定稿。
 */
export function pushRetryRows(out: string[], f: FrequencyReport): void {
  const r = f.retry;
  if (r === null) {
    out.push('| retryable 重试占比（**分母 A = 实际发出请求**） | **未采集（无打点）** |');
    // 与上面同一件事就必须同一句话（20261105 PM 裁定：一个表里不许出现两种说法）。
    out.push('| retryable 重试占比（分母 B = 轮数下界） | **未采集（无打点）：retry 事件未落盘** |');
    return;
  }
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  out.push(
    `| retryable 重试占比（**分母 A = 实际发出请求 ${r.requestsSent}**） | ${pct(r.retryShare)}（首轮 ${r.firstAttemptRetry} / 续跑 ${r.errorRetry} / 截断 ${r.truncatedResend}） |`,
  );
  if (Object.keys(r.errorRetryByReason).length > 0) {
    const parts = Object.entries(r.errorRetryByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join('、');
    out.push(`| └ 续跑按原因分列 | ${parts} |`);
  }
  out.push(
    `| 预算耗尽（重试被拒，单列不计分子） | 首轮 ${r.budgetOut.firstAttemptRetryOut} / 续跑 ${r.budgetOut.errorBudgetOut} / 截断 ${r.budgetOut.truncatedBudgetOut} |`,
  );
}

/** 汇总侧的 retry 一行：任何一天都没采到 → 整列「未采集（无打点）」。 */
export function retryTotalsLine(r: CollectResult): string {
  const withRetry = r.days.filter((d) => d.frequency.retry !== null);
  if (withRetry.length === 0) return '**未采集（无打点）**';
  const sent = withRetry.reduce((n, d) => n + (d.frequency.retry?.requestsSent ?? 0), 0);
  const retries = withRetry.reduce(
    (n, d) => n + (d.frequency.retry?.firstAttemptRetry ?? 0) + (d.frequency.retry?.errorRetry ?? 0) + (d.frequency.retry?.truncatedResend ?? 0),
    0,
  );
  return `${((retries / Math.max(sent, 1)) * 100).toFixed(1)}%（分子 ${retries} / 分母 A ${sent}，${withRetry.length}/${r.days.length} 天有打点）`;
}

/** 累计汇总（跨天）。 */
export function renderTotalsMarkdown(r: CollectResult, sampleMin: number): string {
  const out: string[] = [];
  out.push('# M3 累计汇总（多日只读采集）');
  out.push('');
  out.push(`- 生成：${r.generatedAt}　脚本：tools/metrics/m3-collect.ts`);
  out.push(`- 源：${r.sources.join(' , ')}`);
  for (const s of r.sourceStatus) out.push(`  - ${s.dir}：${s.exists ? '存在' : '**不存在**（缺源要显式可见）'}`);
  out.push(`- 归档根：见 manifest.json`);
  // 版本标记：一天都没采到 retry 证据 → 本版是「口径定稿版，retry 待打点」，
  // 不许被当成 M3 的最终数据表（UI 白名单落地后重跑会自动切换）。
  const anyRetry = r.days.some((d) => d.frequency.retry !== null);
  out.push(`- 版本：${anyRetry ? '终表（retry 已采集）' : '终表（口径定稿版，**retry 待打点**）'}`);
  out.push('');
  out.push('| 指标 | 值 |');
  out.push('|---|---|');
  out.push(`| 采集天数 / 文件数 | ${r.totals.days} / ${r.totals.files} |`);
  out.push(`| 原始字节合计 | ${r.totals.bytes} |`);
  out.push(`| turn.end 合计 / 任务合计 | ${r.totals.turnEnds} / ${r.totals.tasks} |`);
  out.push(`| 样本充足天 / 样本不足天（阈值 ${sampleMin} 任务） | ${r.totals.sampleSufficientDays} / ${r.totals.sampleInsufficientDays} |`);
  out.push(`| **断档天数** | ${r.gaps.length}${r.gaps.length ? `（${r.gaps.join(', ')}）` : ''} |`);
  out.push(`| retryable 重试占比（分母 A = 实际发出请求） | ${retryTotalsLine(r)} |`);
  out.push('');
  out.push('## 口径注记（20261105 PM 定稿，别把空值读成 0）');
  out.push('');
  out.push('- **重试占比**：`turn.end` 只是**请求数下界**；HTTP 重试若要真值必须靠 `request.sent` / `continuation.decision` 落盘。');
  out.push('  这两类事件的历史落盘白名单未放行 → 表上写「**未采集（无打点）**」，**空值 ≠ 0，不许当成「没有重试」**。');
  out.push('- **同轮双事件 ≠ 独立请求风暴**：`≤5000ms` 那一项统计的是「同一轮出现多个 turn.end」（协议修复/终态重复落盘），');
  out.push('  与「独立请求间隔」是两件事，分开读，不得合成「用户在猛发请求」这类结论。');
  out.push('- **两种分母**：分母 A（实际发出请求，含重试重发）回答「请求放大」；分母 B（轮数下界）回答「任务轮数」。两者不可互换。');
  out.push('');
  out.push('## 逐日');
  out.push('');
  out.push('| 日期 | 行数 | turn.end | 任务 | P50/P90 | 充足? | 字节 |');
  out.push('|---|---|---|---|---|---|---|');
  for (const d of r.days) {
    const f = d.frequency;
    out.push(
      `| ${d.day} | ${d.lines} | ${d.turnEnds} | ${f.taskCount} | ${num(f.p50)}/${num(f.p90)} | ${
        d.sampleSufficient ? '是' : '**不足**'
      } | ${d.bytes} |`,
    );
  }
  out.push('');
  if (r.ignoredEntries.length > 0) {
    out.push('## 未纳入采集的条目（命名不符，防止「采集不到」被静默）');
    out.push('');
    for (const e of r.ignoredEntries) out.push(`- ${e}`);
    out.push('');
  }
  return out.join('\n');
}

// ──────────────────────────────────────────────────────────── CLI

function argValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

function argValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}

export function runCli(argv: string[]): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..');
  const extraSources = argValues(argv, '--source');
  // 归档默认放**仓外**（仓库同级目录 `m3-archive`）：trace 是用户真机运行数据，
  // 留在仓内会被 `git add -A` 卷进公开仓（`.gitignore` 未覆盖 `data/`，20261105 实测）。
  const archiveDir = argValue(argv, '--archive') ?? resolve(root, '..', 'm3-archive');
  const outDir = argValue(argv, '--out') ?? join(archiveDir, 'daily');
  const sampleMin = Number(argValue(argv, '--sample-min') ?? 20);
  const sources = [join(root, 'logs', 'trace'), ...extraSources];

  const result = collectAll({ sources, archiveDir, outDir, sampleMin, write: true });

  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(archiveDir, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  for (const d of result.days) {
    writeFileSync(join(outDir, `${d.day}.md`), `${renderDailyMarkdown(d, sampleMin)}\n`, 'utf8');
  }
  const totalsPath = join(outDir, 'TOTALS.md');
  writeFileSync(totalsPath, `${renderTotalsMarkdown(result, sampleMin)}\n`, 'utf8');

  console.log(`[m3-collect] 源：${result.sources.join(' , ')}`);
  console.log(`[m3-collect] 采集天数=${result.totals.days} 文件=${result.totals.files} turn.end=${result.totals.turnEnds} 任务=${result.totals.tasks}`);
  console.log(`[m3-collect] 断档=${result.gaps.length}${result.gaps.length ? `（${result.gaps.join(', ')}）` : ''}`);
  console.log(`[m3-collect] 归档=${archiveDir}`);
  console.log(`[m3-collect] 分布=${outDir}（${result.days.length} 份每日 + TOTALS.md）`);
  return result.totals.days > 0 ? 0 : 1;
}

const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('m3-collect.ts');
if (isDirectRun) {
  process.exit(runCli(process.argv.slice(2)));
}