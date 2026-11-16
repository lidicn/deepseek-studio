/**
 * tools/gate/lock-pairing.ts — 控制面锁/收口配对取数器（卡⑰，20261116 群PM 派卡）
 *
 * 背景：PM 控制面的锁/收口配对判据原本只活在 gitignored 的 `logs/pmg-lock-check.ps1`
 * （随时会被清），2026-11-16 Chief 要求把「未闭合锁=0」从计数差升级成逐枚配对真跑，
 * 群PM 据此定稿判据并声明「任何人（包括 PM）不再手写这两条正则」。本件是该判据的
 * 版本库载体——判据从 ps1 **逐条冻结移植**，不做"改良"：配对基线（58 锁/68 收口候选/
 * 未配对 0）已由 PM 与 Chief 两个独立口径（67/53）互证，改宽改窄都会让本件的数与
 * 台账对不上。
 *
 * 判据（冻结，源＝logs/pmg-lock-check.ps1，2026-11-16 版）：
 *   锁   ＝ `CLAIM\s+(commit|push|tag)`——裸词 CLAIM（后跟非 commit/push/tag）不计入；
 *   收口 ＝ 严格两型，行首锚＋≥7 位 sha 门槛，叙述行不命中：
 *     A 型：行首机器锚 `[YYYY-MM-DD HH:MM:SS] RELEASE(挂账) <sha7>`（括注可选）；
 *     B 型：`收口…）｜RELEASE <sha7>`（`**群PM（轮询器自动收口）｜RELEASE 21707f6…**` 实样）。
 *   配对 ＝ 逐枚锁找**其后首条**收口（收口可被多枚锁共享——批次释放），无后者列行号。
 *   结构 ＝ `^## `/`^### `/总行数/字节。
 *
 * 两枚牙（2026-11-16 当天最贵的教训，测试锁死）：
 *   ① PM 手填的锚定式 `轮询器自动收口｜RELEASE <sha>`（漏右括号、行首无机器锚）⇒
 *     两型都不命中——谁照那个字面跑会得 0 条收口、把全部锁判成未闭；
 *   ② 叙述行裸词（`落 CLAIM 后执行`／`RELEASE 21707f6 已经落账`）不计入。
 *
 * 行数口径与 ps1 Get-Content 对齐：尾 0x0A 不产生空尾行。目标文件可参数化
 * （`--pmlog <路径>`，默认仓根 PM-LOG.md），**无写死盘符**（⑦ 判据延伸）。
 * 台账缺席 ⇒ 显式 N/A＋exit 0（缺失≠干净，⑤/⑧ 同款语义）。
 * 按卡面 ③：独立可执行工具，**不进 run.ts 步骤清单**（不改闸面基线）；接进闸须 PM 另批。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_RE = /CLAIM\s+(commit|push|tag)/;
/** ㉑-加闸（群PM 裁定）：在册执行方名册——空 actor（钩默认口径）只认在册锁；
 *  具名入口不查名册（gate-test 合成夹具走具名）。单一真相，⑤-补 口径。 */
const REGISTERED = ['群PM', '私聊PM'];
const REL_A = /^\[[0-9-]{10} [0-9:]{8}\] RELEASE(?:\([^)]*\)|（[^）]*）)?\s+[0-9a-fA-F]{7}/;
const H2_RE = /^## /;
const H3_RE = /^### /;

/** ⑰-补4（群PM 定字，2026-11-16）：锁＝`CLAIM\s+(commit|push|tag)` 且前文＝**锚段＋分隔符**——
 *  锚段（自由组合）：`[ts]`／`## @…`／`### [..]`／`11-16 HH:MM:SS`／加粗 `**`／执行方名；
 *  锚段之后只允许分隔符 `｜：（）*` 与空白。**结构式判定，不用长度阈值**（⑰-补3 反噬：
 *  枚举前缀漏了 `## @`/`### [` 两类合法锚剔掉 16 枚真锁；长度上界是观测值不是判据）。
 *  句中引用（叙述/复述判据，前文含非法叙述字符）一律不计。
 *  配套 dropped 诊断（loose 命中 − 计入，带被剔行号）——收紧判据必须双向可证伪。 */
const ANCHOR_RE =
  /^(?:\[[0-9-]{10} [0-9:]{8}\]|#{2,3} @[^\n]{0,26}|### \[[0-9:]{4,8}\]|[0-9]{2}-[0-9]{2} [0-9:]{5,8}|[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)(?=\s|$)/;
/** 结构式前文判定（锁与 B 型收口共用）：锚段/执行方名（可带 ≤12 字括注）/加粗/分隔符自由组合，
 *  走到尾即放行（无论是否含锚——`**群PM｜` 加粗前缀本身就是锁行惯例）；剩余含叙述字符＝句中引用。 */
function structuredHeadOk(before: string): boolean {
  if (before.length === 0) return true; // 行首直跟（裸 CLAIM 锁）
  let rest = before;
  while (rest.length > 0) {
    rest = rest.replace(/^[\s*]+/, '');
    if (rest.length === 0) break;
    const anchor = ANCHOR_RE.exec(rest);
    if (anchor) {
      rest = rest.slice(anchor[0].length);
      continue;
    }
    const actor = /^(?:群PM|私聊PM|Gate|Chief|轮询器|Core|UI|Verify)/.exec(rest);
    if (actor) {
      rest = rest.slice(actor[0].length);
      // 执行方后可带括注（`（轮询器自动收口）` 实样）——括注≤12 字视作锚段一部分
      const paren = /^[（(][^）)\n]{1,12}[）)]/.exec(rest);
      if (paren) rest = rest.slice(paren[0].length);
      continue;
    }
    if (/^[｜:：（）]/.test(rest)) {
      rest = rest.slice(1);
      continue;
    }
    return false; // 剩余含叙述字符（句读/长文）＝句中引用
  }
  return true;
}

function isRealLock(line: string, idx: number): boolean {
  return structuredHeadOk(line.slice(0, idx));
}

/** ⑰-补4 收口 B 型同套结构式（`…收口）｜RELEASE` 前文＝执行方前缀/锚段＋分隔符）。 */
function isRealReleaseB(line: string, idx: number): boolean {
  return structuredHeadOk(line.slice(0, idx));
}

export interface LockPairingResult {
  /** 锁行号（1 起）。 */
  locks: number[];
  /** 收口行号（1 起）。 */
  releases: number[];
  /** 未配对锁行号（1 起）——其后不存在任何收口行。 */
  unpaired: number[];
  /** 逐枚配对：锁行 → 其后首条收口行（收口可共享）。 */
  pairs: { lockLine: number; releaseLine: number }[];
  /** ⑰-补4 双向可观测：loose 命中被位置判据剔除的行——每行带 1 起行号与行首 120 字符。 */
  dropped: { line: number; kind: 'lock' | 'release'; text: string }[];
  lastLockLine?: number;
  lastReleaseLine?: number;
  structure: { h2: number; h3: number; lines: number; bytes: number };
}

export function parseLockPairing(text: string, bytes?: number): LockPairingResult {
  const lines = text.split(/\r?\n/);
  // ps1 Get-Content 口径：文件尾 0x0A 不产生空尾行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const locks: number[] = [];
  const releases: number[] = [];
  const dropped: { line: number; kind: 'lock' | 'release'; text: string }[] = [];
  let h2 = 0;
  let h3 = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lm = LOCK_RE.exec(line);
    if (lm) {
      if (isRealLock(line, lm.index)) locks.push(i + 1);
      else dropped.push({ line: i + 1, kind: 'lock', text: line.slice(0, 120) });
    }
    if (REL_A.test(line)) {
      releases.push(i + 1);
    } else {
      const mb = /收口[^）]*）\s*｜RELEASE\s+[0-9a-fA-F]{7}/.exec(line);
      if (mb) {
        // ⑰-补4：B 型正则可能从执行方括注（`（轮询器自动收口）`）内部起匹配——前文断在
        // 括注中间会让结构判定误剔真收口（L3425 等八枚）。真前文＝行首到 mb.index，
        // 若以悬空 `（…` 结尾则连同括注起点一起剥掉再判。
        let head = line.slice(0, mb.index);
        const dangling = /[（(][^）)\n]*$/.exec(head);
        if (dangling) head = head.slice(0, dangling.index);
        if (isRealReleaseB(head, head.length)) releases.push(i + 1);
        else dropped.push({ line: i + 1, kind: 'release', text: line.slice(0, 120) });
      }
    }
    if (H2_RE.test(line)) h2++;
    if (H3_RE.test(line)) h3++;
  }
  const pairs: { lockLine: number; releaseLine: number }[] = [];
  const unpaired: number[] = [];
  let r = 0; // 收口指针：只前进、不消费——批次释放可被多枚锁共享
  for (const l of locks) {
    while (r < releases.length && releases[r] <= l) r++;
    if (r < releases.length) pairs.push({ lockLine: l, releaseLine: releases[r] });
    else unpaired.push(l);
  }
  return {
    locks,
    releases,
    unpaired,
    pairs,
    dropped,
    lastLockLine: locks.length > 0 ? locks[locks.length - 1] : undefined,
    lastReleaseLine: releases.length > 0 ? releases[releases.length - 1] : undefined,
    structure: {
      h2,
      h3,
      lines: lines.length,
      bytes: bytes ?? Buffer.byteLength(text, 'utf8'),
    },
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--pmlog');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const logPath = idx >= 0 && argv[idx + 1] ? resolve(argv[idx + 1]) : join(root, 'PM-LOG.md');
  if (!existsSync(logPath)) {
    console.log(`[lock-pairing] N/A——控制面台账不存在（CI 无 PM-LOG），本步未判：${logPath}`);
    process.exit(0);
  }
  const bytes = statSync(logPath).size;
  const text = readFileSync(logPath, 'utf8');
  const res = parseLockPairing(text, bytes);
  console.log(`locks=${res.locks.length}`);
  console.log(`releases=${res.releases.length}`);
  console.log(`unpaired=${res.unpaired.length}`);
  for (const u of res.unpaired) {
    const line = text.split(/\r?\n/)[u - 1] ?? '';
    console.log(`UNPAIRED L${u} : ${line.slice(0, 120)}`);
  }
  // ⑰-补4：dropped 诊断——被位置判据剔除的 loose 命中全列（双向可证伪：不漏报真锁）
  console.log(`dropped=${res.dropped.length}`);
  for (const d of res.dropped) {
    console.log(`DROPPED ${d.kind} L${d.line} : ${d.text}`);
  }
  console.log(`lastLockLine=${res.lastLockLine ?? '-'}`);
  console.log(`lastReleaseLine=${res.lastReleaseLine ?? '-'}`);
  console.log(`h2=${res.structure.h2}`);
  console.log(`h3=${res.structure.h3}`);
  console.log(`lines=${res.structure.lines}`);
  console.log(`bytes=${res.structure.bytes}`);
  if (argv.includes('--check-claim')) {
    // 卡⑱（群PM 派卡）：pre-commit 钩的单一真相入口——钩不再自己解析台账。
    // 用法：--check-claim <执行方>（空串/缺省＝任一在册执行方，与 ⑤-补 口径同）。
    // 判定复用 parseLockPairing 的严格判据（A/B 两型收口＋结构式前缀）：
    //   exit 0 ＝ 该执行方存在未销锁 CLAIM（放行提交）
    //   exit 2 ＝ 无未销锁（拦提交， stderr 给落行指引）
    // ⑱-② 窗口：**自最近一次真收口行起扫描**（不是末 40 行）——CLAIM 被叙述挤到
    //   窗口外的绕过面消除；台账全量读入，窗口只影响"哪些历史锁仍算在途"。
    const whoRaw = argv[argv.indexOf('--check-claim') + 1] ?? '';
    const who = whoRaw.trim();
    const lines = text.split(/\r?\n/);
    // 执行方提取：真行形态「CLAIM commit+push 群PM …」／「CLAIM commit 群PM …」——
    // 动作 token 可带 +（commit+push），执行方紧跟动作之后的第一个非动作词
    const executorOf = (n: number): string | undefined => {
      const line = lines[n - 1] ?? '';
      return /CLAIM\s+(?:commit|push|tag)(?:\+\S+)?\s+([^\s｜：（）*]+)/.exec(line)?.[1];
    };
    const isExecutor = (n: number): boolean => {
      // ㉑：执行方提取通用化——⑰ 硬编码 (群PM|私聊PM) 让 ⑤ 套件的 gate-test 合成
      //   执行方不被识别（⑱ 单源化迁移遗漏，⑤ 套件本机 11 failed 的隐藏半边）。通用捕获
      //   停在分隔符（与 structuredHeadOk 同套 ｜：（）*）上，不把 `群PM｜④②c`／`群PM（⑤` 整段吃掉。
      // ㉑-加闸（群PM 探针裁定，2026-11-16）：空 actor（钩默认口径）＝任一**在册**执行方——
      //   名册单一真相＝⑤-补 口径（群PM／私聊PM）。非在册名（随手编的执行方）不得经空
      //   actor 放行（越权绕过面）；具名入口不查名册（gate-test 合成夹具走具名精确比名）。
      //   缺参与传空串两入口同分支（L199 ?? ''）。
      const exec = executorOf(n);
      return exec !== undefined ? (who === '' ? REGISTERED.includes(exec) : exec === who) : who === '';
    };
    const lastRelease = res.lastReleaseLine ?? 0;
    // ㉑-加闸可观测面：空 actor 下被名册剔除的锁逐枚列出（双向可证伪——剔了什么必须可见）
    const unregistered: number[] = [];
    const openClaims = res.locks.filter((n) => {
      if (n <= lastRelease) return false;
      if (who === '') {
        const exec = executorOf(n);
        if (exec !== undefined && !REGISTERED.includes(exec)) {
          unregistered.push(n);
          return false;
        }
      }
      return isExecutor(n);
    });
    for (const n of unregistered) {
      console.error(`[check-claim] 执行方未在册剔除 L${n}（空 actor 只认在册 群PM／私聊PM）: ${(lines[n - 1] ?? '').slice(0, 120)}`);
    }
    if (openClaims.length > 0) {
      for (const n of openClaims) {
        console.error(`[check-claim] 未销锁 CLAIM L${n} : ${(lines[n - 1] ?? '').slice(0, 120)}`);
      }
      process.exit(0);
    }
    console.error(`[check-claim] 无未销锁 CLAIM（窗口＝自 L${lastRelease + 1} 真收口起；${who === '' ? `任一在册执行方${unregistered.length > 0 ? `；${unregistered.length} 枚执行方未在册锁已剔除` : ''}` : `执行方 ${who}`}）。落一行：CLAIM commit <执行方> <时刻> <范围一句话>——然后重试；应急 --no-verify 但必须写日志。`);
    process.exit(2);
  }
  // 卡⑰-补（Chief 判据 ③）：unpaired>0 ⇒ exit 1——可直接被看门狗当闸位调用，不必人读输出。
  // N/A 面（台账缺席）仍 exit 0：缺失≠未闭合锁，两级语义不同。
  process.exit(res.unpaired.length > 0 ? 1 : 0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('lock-pairing.ts')) {
  main();
}
