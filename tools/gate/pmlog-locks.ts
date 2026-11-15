/**
 * tools/gate/pmlog-locks.ts — 闸位锁态只读核查（⑧／⑧-补，20261115 群PM 派卡）
 *
 * 背景（2026-11-15 14:1x 群PM 实弹）：群PM 按单一窄正则（只认 `END GATE#n`）扫 PM-LOG
 * 得出「26 枚未闭合」，进程表现读 0 枚闸在跑——台账既有收口写法远不止一种，且
 * PM-LOG 2026-11-15 11:5x 那条私聊PM 判据原文明确要求「某批有无收口必须三处齐查
 * （PM-LOG END／FREE 行＋marker 第二行＋闸日志尾判）」。本工具把「闸位是否被占用」
 * 从两个 PM 各自的正则里拿出来：文本配对＋进程表交叉核对＋不一致双报。
 *
 * **只读**：本工具绝不写台账（无任何 append/写入口；测试以字节前后全等证明）。
 * CI 上无 PM-LOG ⇒ 显式 N/A＋exit 0（缺失≠干净，⑤ 闸侧语义同款）。
 *
 * 四态（Chief 判据，2026-11-15 14:5x）：`open`／`closed`／`closed-aborted`／`reference-only`。
 * **FREE ≠ 收口**（台账 L「FREE gate#23（中止，非收口）」原文）——行首 FREE 锚定
 * `^FREE (gate#\d+|第\d+次)` 才判（散文「端口 free」不咬）；行内带「中止/非收口」⇒
 * aborted，带「收口 GATE_EXIT=」证据 ⇒ closed。作废/ABORTED 形态 ⇒ closed-aborted。
 *
 * 起跑认定（⑧-补 ①，群PM 判据）：**行内出现 `RUNNING GATE#n` 字面 ⇒ 一律算起跑过**
 * （进 open 或 closed），`reference-only` 只留给无 RUNNING 字面的提及。两格引用例外：
 *   - 否定引用「无 RUNNING GATE#n」：该行语义就是「这枚没起跑」——不立记录（若全台账
 *     再无别处起跑，落 reference-only 恰是该行的自报）；
 *   - 判据/散文引用（反引号、或前 4 字符含 行/条，如「先 append 一行 RUNNING GATE#72」
 *     「我 grep `RUNNING GATE#39 …`」）：该号**已有记录**时引用行不重复立；**首见**（该号
 *     还没有任何记录，如 L2636「已执行。RUNNING GATE#96」）⇒ 立记录——可见性优先于
 *     沉默，不许任何真起跑被降成「从没跑过」（#96/#99 两枚复核退回的教训）。
 *
 * 收口形态（从真实台账现读归纳）：
 *   ① `END GATE#n`（含 `## END GATE#n`、行中带读数、小写 `END gate#n` 变体，全部 -i）；
 *   ①′ `CLOSED GATE#n`（私聊PM 11-08 时代，L「CLOSED GATE#72 exit=0」）；
 *   ② `GATE#n`（含裸 `#n`）后 48 字符内出现「收口」；
 *   ②′ `#n 作废`／`#n … ABORTED`（裸号不带 GATE 前缀——「RUNNING GATE#81（#80 作废）」实样）
 *      ⇒ closed-aborted；
 *   ③ 不带号的 `GATE_EXIT=<数字>`（收 30 行内的**最近一条 open**——启发式，输出带行号供
 *      人工复核；远处的收口引文不许吞掉几百行前悬着的旧闸）；
 *   ④ 行首 `FREE`（见上，锚定形态）。
 *   另：叙述闭合「那条 RUNNING GATE#n 到此闭合」按收口算（窗口判定，真起跑行正文远处
 *   的「那条」不算）。
 *
 * 已知启发式边界（输出全带行号，人工一秒可核）：无号 GATE_EXIT= 收「30 行内最近 open」
 * 可能收错对象；三处齐查的另两处（marker 第二行、闸日志尾判）不在本工具射程——它只读
 * PM-LOG。
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LockStatus = 'open' | 'closed' | 'closed-aborted';

export interface LockRecord {
  n: number;
  status: LockStatus;
  startLine: number;
  endLine?: number;
  form?:
    | 'END GATE#n'
    | 'CLOSED GATE#n'
    | 'GATE#n 收口'
    | 'GATE#n 作废/中止'
    | 'GATE_EXIT='
    | 'FREE(中止)'
    | 'FREE(收口)'
    | '叙述闭合';
}

export interface ParsedLocks {
  records: LockRecord[];
  /** 台账里被提及（gate#n）但从未立起跑记录的号——叙述内引（「该号段没跑过」的账面口径）。 */
  referenceOnly: number[];
}

const RUNNING_RE = /RUNNING GATE#(\d+)/i;
const END_RE = /END GATE#(\d+)/i;
const CLOSED_RE = /CLOSED GATE#(\d+)/i;
const GATE_EXIT_VALUED = /GATE_EXIT=\s*\d/;
const NARRATIVE = /那条|到此闭合/;
/** 行首 FREE 必须带闸号锚（Chief 判据：散文 free 不判；「FREE 第22次全量闸」也是实样形态）。 */
const FREE_ANCHOR = /^FREE\s+(?:gate#\d+|第\d+次)/i;

/** 否定引用：匹配位前 6 字符内出现「无」——「闸进程 0、无 RUNNING GATE#71」实样。 */
function isNegatedRun(line: string, idx: number): boolean {
  return /无/.test(line.slice(Math.max(0, idx - 6), idx));
}

/** 判据/散文引用：反引号引号，或前 4 字符含 行/条（「先 append 一行 RUNNING GATE#72」实样）。 */
function isQuotedRun(line: string, idx: number): boolean {
  const before = line.slice(Math.max(0, idx - 4), idx);
  return /[`「『"]/.test(before) || /行|条/.test(before);
}

/** 行内 `收口|作废|ABORTED` 对应的仓号：每个关键词回扫其前最近的仓号（间隔 ≤48 字符）。
 *  仓号两种形态：`GATE#n`／裸 `#n`（「RUNNING GATE#81（#80 作废）」——裸号不带 GATE 前缀）。
 *  排除自指（＝本行 RUNNING 的号）。 */
function closeKeywordTargets(line: string, runN: number): { n: number; kind: '收口' | '作废/中止' }[] {
  const targets: { n: number; kind: '收口' | '作废/中止' }[] = [];
  const REF = /(?:GATE)?#(\d+)/gi;
  for (const m of line.matchAll(/收口|作废|ABORTED/gi)) {
    const kind = /作废|ABORTED/i.test(m[0]) ? '作废/中止' : '收口';
    const cut = line.slice(Math.max(0, (m.index ?? 0) - 48), m.index);
    let last: { n: number; end: number } | undefined;
    for (const g of cut.matchAll(REF)) {
      last = { n: Number(g[1]), end: (g.index ?? 0) + g[0].length };
    }
    if (last && cut.length - last.end <= 48 && last.n !== runN) {
      if (!targets.some((t) => t.n === last.n)) targets.push({ n: last.n, kind });
    }
  }
  return targets;
}

export function parseGateLocks(text: string): ParsedLocks {
  const lines = text.split(/\r?\n/);
  const open: { n: number; startLine: number }[] = [];
  const records: LockRecord[] = [];
  const hasRecord = new Set<number>();
  /** 带号收口收该号**全部**待闭记录——同一闸的判据引用行与真起跑行一次收净（CLOSED GATE#71 实样）。 */
  const closeAll = (n: number, endLine: number, form: LockRecord['form'], aborted = false): void => {
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].n === n) {
        const rec = open.splice(k, 1)[0];
        records.push({
          n: rec.n,
          status: aborted ? 'closed-aborted' : 'closed',
          startLine: rec.startLine,
          endLine,
          form,
        });
      }
    }
  };
  /** 无号形态（GATE_EXIT=<数字>／FREE 第N次）只收 30 行内的最近 open——台账 3,800+ 行，
   *  远处的收口引文不许吞掉几百行前悬着的旧闸；收不到近距 open 就不动，旧闸如实留在
   *  open 名单（账面缺口，进程交叉核对兜底）。 */
  const closeRecent = (endLine: number, form: LockRecord['form'], aborted = false, maxLines = 30): void => {
    const latest = open[open.length - 1];
    if (latest && endLine - latest.startLine <= maxLines) {
      const rec = open.pop()!;
      records.push({
        n: rec.n,
        status: aborted ? 'closed-aborted' : 'closed',
        startLine: rec.startLine,
        endLine,
        form,
      });
    }
  };
  lines.forEach((line, idx) => {
    const ln = idx + 1;
    const run = line.match(RUNNING_RE);
    if (run) {
      const n = Number(run[1]);
      // 叙述闭合判定用窗口：那条/到此闭合必须贴着 RUNNING 提及（±前 24/后 48），
      // 真起跑行正文远处的「那条」（#64 实例）不许把它误判成叙述
      const ctx = line.slice(Math.max(0, (run.index ?? 0) - 24), (run.index ?? 0) + 48);
      if (NARRATIVE.test(ctx)) {
        closeAll(n, ln, '叙述闭合');
        return;
      }
      if (isNegatedRun(line, run.index ?? 0)) return; // 否定引用：该行自报「这枚没起跑」
      if (isQuotedRun(line, run.index ?? 0) && hasRecord.has(n)) return; // 判据/散文引用且该号已有真记录 ⇒ 不重复立
      // 其余一律立记录（⑧-补 ①）：真起跑／前导叙述＋真 RUNNING（#96 实样）／补记 RUNNING（#99 实样）／
      // 首见判据引用——可见性优先于沉默，不许任何 RUNNING 字面被降成「从没跑过」
      open.push({ n, startLine: ln });
      hasRecord.add(n);
      // 不 return：RUNNING 行正文可同时收上一发（L2520「RUNNING GATE#93 …GATE#92 于 08:17 收口绿」、
      // L2357「RUNNING GATE#81（#80 作废）」），收口扫描对全部行执行
    } else if (/补记\s*RUNNING/i.test(line)) {
      // 补记 RUNNING（起闸方未落行、代为登记——#99 L3306 实样：补记 RUNNING（…）…GATE#99）：
      // 行内带仓号 ⇒ 在此行立起跑记录（RUNNING 无号、仓号在行内深处，RUNNING_RE 咬不到）
      const rm = /RUNNING/i.exec(line);
      const seg = line.slice((rm?.index ?? 0) + 8);
      const m = /GATE#(\d+)/i.exec(seg) ?? /#(\d+)/.exec(seg);
      if (m) {
        const n = Number(m[1]);
        if (!hasRecord.has(n) && !open.some((o) => o.n === n)) {
          open.push({ n, startLine: ln });
          hasRecord.add(n);
        }
      }
      return;
    }
    // 收口扫描（对全部行，含 RUNNING 行）
    const end = line.match(END_RE) ?? line.match(CLOSED_RE);
    const runN = run ? Number(run[1]) : -1;
    if (end) {
      closeAll(Number(end[1]), ln, end[0].toUpperCase().startsWith('CLOSED') ? 'CLOSED GATE#n' : 'END GATE#n');
    } else if (FREE_ANCHOR.test(line)) {
      const named = line.match(/gate#(\d+)/i);
      const aborted = /中止|非收口/i.test(line);
      if (named) closeAll(Number(named[1]), ln, aborted ? 'FREE(中止)' : 'FREE(收口)', aborted);
      else closeRecent(ln, aborted ? 'FREE(中止)' : 'FREE(收口)', aborted);
    } else {
      const targets = closeKeywordTargets(line, runN);
      if (targets.length > 0) {
        for (const t of targets) closeAll(t.n, ln, t.kind === '收口' ? 'GATE#n 收口' : 'GATE#n 作废/中止', t.kind === '作废/中止');
      } else if (GATE_EXIT_VALUED.test(line)) {
        closeRecent(ln, 'GATE_EXIT=');
      }
    }
  });
  for (const r of open) records.push({ n: r.n, status: 'open', startLine: r.startLine });
  records.sort((a, b) => a.startLine - b.startLine);
  const openedNs = new Set(records.map((r) => r.n));
  const mentioned = new Set<number>();
  for (const m of text.matchAll(/gate#(\d+)/gi)) mentioned.add(Number(m[1]));
  const referenceOnly = [...mentioned].filter((n) => !openedNs.has(n)).sort((a, b) => a - b);
  return { records, referenceOnly };
}

/** 进程表交叉核对：命令行含 gate/vitest 的 node 进程（win32；排除本工具自身；他台返回空）。 */
export function scanGateProcesses(): { pid: number; cmd: string }[] {
  if (process.platform !== 'win32') return [];
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { [string]::Concat($_.ProcessId, [char]9, $_.CommandLine) }"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 },
    );
    return out
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('\t');
        return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) };
      })
      .filter((p) => Number.isFinite(p.pid) && p.pid !== process.pid && /gate|vitest/i.test(p.cmd));
  } catch {
    return [];
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const pmlogIdx = argv.indexOf('--pmlog');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const logPath = pmlogIdx >= 0 && argv[pmlogIdx + 1] ? resolve(argv[pmlogIdx + 1]) : join(root, 'PM-LOG.md');
  if (!existsSync(logPath)) {
    console.log(`[pmlog-locks] N/A——PM-LOG 不存在（CI 无控制面台账），本步未判：${logPath}`);
    process.exit(0);
  }
  const text = readFileSync(logPath, 'utf8');
  const { records, referenceOnly } = parseGateLocks(text);
  const openRecs = records.filter((r) => r.status === 'open');
  const closedRecs = records.filter((r) => r.status === 'closed');
  const abortedRecs = records.filter((r) => r.status === 'closed-aborted');
  for (const r of records) {
    if (r.status === 'open') {
      console.log(`[pmlog-locks] GATE#${r.n} open（RUNNING@L${r.startLine} 无收口）`);
    } else {
      const tag = r.status === 'closed-aborted' ? 'closed-aborted' : 'closed';
      console.log(`[pmlog-locks] GATE#${r.n} ${tag}（L${r.startLine} → L${r.endLine} ${r.form}）`);
    }
  }
  if (referenceOnly.length > 0) {
    console.log(`[pmlog-locks] reference-only ${referenceOnly.length} 枚（叙述内引，无起跑行）：#${referenceOnly.join(' #')}`);
  }
  const procs = scanGateProcesses();
  const pidList = procs.map((p) => ` pid=${p.pid}`).join('');
  console.log(`[pmlog-locks] 进程表：gate/vitest 类 node ${procs.length} 枚${pidList}`);
  if (openRecs.length > 0 && procs.length === 0) {
    console.log(`[pmlog-locks] 不一致①：文本判 open ${openRecs.length} 枚而进程为 0 ⇒ 均为账面缺口（非在跑闸），不构成锁位`);
  } else if (procs.length > 0 && openRecs.length === 0) {
    console.log('[pmlog-locks] 不一致②：进程在跑而文本无 RUNNING ⇒ ⑤ RUNNING 自写锁未守住，命令行如下');
    for (const p of procs) console.log(`[pmlog-locks]   pid=${p.pid} ${p.cmd.slice(0, 200)}`);
  } else if (procs.length > 0 && openRecs.length > 0) {
    console.log(`[pmlog-locks] 文本 open ${openRecs.length} 枚＋进程 ${procs.length} 枚——无法按 pid 配对，人工核对命令行：`);
    for (const p of procs) console.log(`[pmlog-locks]   pid=${p.pid} ${p.cmd.slice(0, 200)}`);
  } else {
    console.log('[pmlog-locks] 一致：无 open 记录、无闸类进程');
  }
  console.log(
    `[pmlog-locks] 汇总：open=${openRecs.length} closed=${closedRecs.length} closed-aborted=${abortedRecs.length} reference-only=${referenceOnly.length} processes=${procs.length}`,
  );
  process.exit(0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('pmlog-locks.ts')) {
  main();
}
