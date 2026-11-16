// 卡㉘（2026-11-16，UI）：trace jsonl 读取器＋判据（三项真机取证的文件面证据通道）。
// 证据文件：宿主 trace 落盘 `logs/trace/trace-<UTC日期>.jsonl`（一行一条 JSON，单行截 4000 字符，
//   宿主 msel 行见 src/host/desktop-host.ts L2251-2265；页端 turn.end / continuation.decision 行
//   见 src/host/page-runtime.ts trace 分支 L508-526；两写点同文件、路径＝宿主进程 cwd 的 logs/trace/）。
// 用法：node trace-read.mjs <locate|msel|fuse|turns|export> [--root <dir>|--auto] [--since <iso|ms>] [--until <iso|ms>]
// 退出码：0 判据过／有数据 · 1 判据不过（msel 超预算／turn 异常终态）· 2 用法错 · 3 trace 根未找到 · 4 窗口内无数据
//
// 判据常量（漂移锁在 tests/desktop/c1-live/c1-live.test.ts：改动此处必须同步改锁）：
//   MSEL_TURN_BUDGET_MS ＝ 120：＝ 注入层 MEM_SELECT_WAIT_BUDGET_MS（src/inject/main-world-interceptor.ts L307，
//       该常量未导出，故本侧镜像＋测试 grep 源文件字面量互锁；「不许调大」的注释口径照抄）。
//   TERMINAL_FUSE_N ＝ 3：＝ shared TERMINAL_FUSE_THRESHOLD（src/shared/continuation-prompt.ts）。
//   NON_TERMINAL_FUSE_N ＝ 5：＝ shared NON_TERMINAL_FUSE_THRESHOLD。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MSEL_TURN_BUDGET_MS = 120;
export const TERMINAL_FUSE_N = 3;
export const NON_TERMINAL_FUSE_N = 5;

/** --auto 时的候选根（每根读 <root>/logs/trace/trace-*.jsonl）：宿主 cwd 决定落点，四个已知形态各列一枚。 */
export function candidateRoots(env = process.env, home = process.env.USERPROFILE ?? '') {
  const out = ['E:\\NAS\\deepseek-studio'];
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'DeepSeek++ Studio'));
  if (env.APPDATA) out.push(join(env.APPDATA, 'com.deepseek.studio'));
  if (home) out.push(join(home, '.config', 'deepseek-studio'));
  return out;
}

/** 列一个根下的 trace 文件（含 mtime／行数证据三件套里的 mtime＋行数）。 */
export function findTraceFiles(root) {
  const dir = join(root, 'logs', 'trace');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^trace-.*\.jsonl$/.test(f))
    .map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').length;
      return { path: p, file: f, mtime: st.mtime.toISOString(), lines };
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

/** 读多文件 trace 行；坏行（含 4000 字符截断的残行）保留 `_truncated` 形态，不吞证据。 */
export function readTraceRows(files) {
  const rows = [];
  for (const f of files) {
    for (const line of readFileSync(f.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        rows.push({ _truncated: true, _raw: line.slice(0, 160) });
      }
    }
  }
  return rows;
}

function parseWhen(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && String(n) === String(v) ? n : Date.parse(v);
}

/** 窗口内 `kind:'msel'` 行逐枚判预算；返回 { rows, over, verdict }。 */
export function judgeMsel(rows, budgetMs = MSEL_TURN_BUDGET_MS) {
  const ms = rows.filter((r) => r && r.kind === 'msel');
  const judged = ms.map((r) => ({
    seq: r.seq,
    at: r.at,
    durationMs: r.durationMs,
    ok: r.ok,
    count: r.count ?? null,
    reason: r.reason ?? null,
    verdict: r.ok !== false && r.durationMs < budgetMs ? 'PASS' : `FAIL(${r.ok === false ? 'not-ok' : 'over-budget'} ${r.durationMs}ms)`,
  }));
  const over = judged.filter((j) => j.verdict !== 'PASS');
  return { rows: judged, over, verdict: judged.length === 0 ? 'NO-DATA' : over.length === 0 ? 'PASS' : 'FAIL' };
}

/** 窗口内熔断面：continuation.decision reason=fuse-* ＋ 同 turn 的 turn.end stopReason。 */
export function judgeFuse(rows) {
  const decisions = rows.filter((r) => r && r.t === 'continuation.decision' && String(r.reason ?? '').startsWith('fuse-'));
  const ends = rows.filter((r) => r && r.t === 'turn.end' && String(r.stopReason ?? '').startsWith('fuse-'));
  const fired = decisions.map((d) => {
    const end = ends.find((e) => e.turnId === d.turnId);
    return {
      turnId: d.turnId,
      axis: d.reason === 'fuse-terminal' ? 'terminal' : 'non-terminal',
      count: d.count ?? null,
      stopReason: end?.stopReason ?? null,
      at: end?.at ?? d.at ?? null,
      consistent: end ? end.stopReason === d.reason : null,
    };
  });
  const countBelow = fired.filter((f) => f.axis === 'terminal' && (f.count ?? 0) < TERMINAL_FUSE_N);
  return {
    fired,
    belowThreshold: countBelow,
    verdict: fired.length === 0 ? 'NO-FUSE-IN-WINDOW' : 'FUSE-FIRED',
  };
}

/** C1 多轮闭合面：turn.end 全量终态，异常终态＝非已知收尾集合。 */
const KNOWN_TURN_ENDS = new Set([
  'completed', 'terminate', 'fuse-terminal', 'fuse-non-terminal', 'user-aborted',
]);
export function judgeTurns(rows) {
  const ends = rows.filter((r) => r && r.t === 'turn.end').map((r) => ({
    turnId: r.turnId,
    stopReason: r.stopReason,
    finished: r.finished,
    at: r.at ?? null,
  }));
  const anomalies = ends.filter((e) => !KNOWN_TURN_ENDS.has(e.stopReason));
  return { ends, anomalies, verdict: ends.length === 0 ? 'NO-DATA' : anomalies.length === 0 ? 'PASS' : 'ANOMALY' };
}

// ───────────────────────────────────────────────────────── CLI ──
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || !['locate', 'msel', 'fuse', 'turns', 'export'].includes(cmd)) {
    console.error('usage: node trace-read.mjs <locate|msel|fuse|turns|export> [--root <dir>|--auto] [--since <iso|ms>] [--until <iso|ms>]');
    process.exit(2);
  }
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  let roots;
  if (opt('--root')) roots = [opt('--root')];
  else if (argv.includes('--auto')) roots = candidateRoots();
  else {
    console.error('need --root <dir> or --auto');
    process.exit(2);
  }
  const since = parseWhen(opt('--since'));
  const until = parseWhen(opt('--until'));

  const found = [];
  for (const root of roots) {
    for (const f of findTraceFiles(root)) found.push({ root, ...f });
  }
  if (found.length === 0) {
    console.error(`ROOT-MISS roots-tried=${JSON.stringify(roots)}`);
    process.exit(3);
  }
  // 证据三件套：根＋mtime＋行数（AGENTS 读数现算口径）
  for (const f of found) console.log(`ROOT ${f.root} file=${f.file} mtime=${f.mtime} lines=${f.lines}`);
  const rows = readTraceRows(found.map(({ path: p, mtime, lines, file }) => ({ path: p, mtime, lines, file })));

  if (cmd === 'locate') {
    if (argv.includes('--auto')) console.log(`AUTO-CANDIDATES ${JSON.stringify(roots)}`);
    console.log(JSON.stringify({ roots: found, rowCount: rows.length }, null, 2));
    process.exit(found.length === 0 ? 3 : 0);
  }
  // 窗口内无 at 字段的残行不被滤掉——证据不吞，交给逐行判读；有 at 的行才走 since/until 界。
  const picked = rows.filter((r) => (r.at !== undefined && r.at !== null && !Number.isNaN(r.at)
    ? ((since === undefined || r.at >= since) && (until === undefined || r.at <= until))
    : true));

  if (cmd === 'export') {
    for (const r of picked) console.log(JSON.stringify(r));
    process.exit(picked.length === 0 ? 4 : 0);
  }
  if (cmd === 'msel') {
    const j = judgeMsel(picked);
    for (const r of j.rows) {
      console.log(`MSEL seq=${r.seq} at=${r.at} durationMs=${r.durationMs} ok=${r.ok} count=${r.count} → ${r.verdict}`);
    }
    console.log(`MSEL-VERDICT ${j.verdict}${j.rows.length ? ` (n=${j.rows.length}, over=${j.over.length})` : ''}`);
    process.exit(j.verdict === 'PASS' ? 0 : j.verdict === 'NO-DATA' ? 4 : 1);
  }
  if (cmd === 'fuse') {
    const j = judgeFuse(picked);
    for (const f of j.fired) {
      console.log(`FUSE turn=${f.turnId} axis=${f.axis} count=${f.count} stopReason=${f.stopReason} consistent=${f.consistent}`);
    }
    for (const b of j.belowThreshold) console.log(`FUSE-WARN turn=${b.turnId} count=${b.count} < ${TERMINAL_FUSE_N}（终局轴未达阈值，非熔断）`);
    console.log(`FUSE-VERDICT ${j.verdict}${j.fired.length ? ` (n=${j.fired.length})` : ''}`);
    // 配套 grep 提示：tool/code 不在 trace 行里，在 sidecar 日志行（注入层 L3144 d() 出口）
    console.log(`SIDECAR-GREP hint: 在 sidecar-*.log 内 grep 'auto-continue fuse'（tool= code= count= 全在此行）`);
    process.exit(j.verdict === 'FUSE-FIRED' ? 0 : 4);
  }
  if (cmd === 'turns') {
    const j = judgeTurns(picked);
    for (const e of j.ends) console.log(`TURN ${e.turnId} stopReason=${e.stopReason} finished=${e.finished} at=${e.at}`);
    for (const a of j.anomalies) console.log(`TURN-ANOMALY ${a.turnId} stopReason=${a.stopReason}`);
    console.log(`TURNS-VERDICT ${j.verdict}${j.ends.length ? ` (n=${j.ends.length}, anomalies=${j.anomalies.length})` : ''}`);
    process.exit(j.verdict === 'PASS' ? 0 : j.verdict === 'NO-DATA' ? 4 : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
