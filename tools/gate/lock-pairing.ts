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
/** 卡㊲（私聊PM 派卡，2026-11-17）：执行方提取**单一真相**——同一枚 CLAIM 行在
 *  锁判定（isRealLock/structuredHeadOk）与 CLI 执行方判定（isExecutor／未在册剔除）两处
 *  必须同结果（记就两处都记、剔就两处都剔且打印行号）。认两种形态：
 *  ① 正序 `CLAIM commit 群PM …`——动作词（可带 +，如 commit+push）之后第一个非分隔词＝执行方；
 *  ② 加粗前缀＋词序倒置 `**群PM｜CLAIM commit+push 卡号 …`——执行方在 CLAIM **之前**、
 *     `｜` 分隔（structuredHeadOk 同款"加粗前缀本身就是锁行惯例"），动作词后跟的是卡号/范围
 *     ——此前被误取成执行方（恰是路线图 §十二 ⑩ 记的那格：锁判定认、CLI 执行方不认）。
 *  倒置形态的席名交替与 structuredHeadOk 的 actor 交替**同源**（含非在册席名——名册过滤
 *  是调用方职责，本函数只管提取）；正序捕获仍停在分隔符（与 structuredHeadOk 同套 ｜：（）*）。
 *  返回 undefined ＝ 行内无 CLAIM 动作词（非锁行）。 */
export function executorOfLine(line: string): string | undefined {
  // 卡㊳ 补格：动作词复合段的 `\+\S+` 会把全角括注（\S 含全角）吞进动作 token
  // （`CLAIM commit+push（给 AGENTS…` 实咬 L3171）——限定 + 后缀只吃 ASCII 复合
  // （commit+push 形态），全角字符（含括注）不属动作词。
  const m = /CLAIM\s+(?:commit|push|tag)(?:\+[a-z]+)?/.exec(line);
  if (!m) return undefined;
  const before = line.slice(0, m.index);
  const inverted = /\*{0,2}(群PM|私聊PM|Gate|Chief|轮询器|Core|UI|Verify)(?:[（(][^）)\n]{1,12}[）)])?\s*｜\s*$/.exec(before);
  if (inverted) return inverted[1];
  let after = line.slice(m.index + m[0].length);
  // 卡㊳ 补格（真台账 L3171/L4514 实咬）：动作词可直跟括注（`CLAIM commit+push（给…）**`）⇒
  // 括注属动作段、执行方在括注后；动作词也可能多打（`CLAIM commit push 群PM`）⇒ 跳过
  // 动作词表内 token。括注后的下一个词才是执行方候选。
  for (;;) {
    after = after.replace(/^\s+/, '');
    if (after.startsWith('（') || after.startsWith('(')) {
      const close = after.search(/[）)]/);
      if (close < 0) return undefined;
      after = after.slice(close + 1);
      continue;
    }
    const w = /^([^\s｜：（）*]+)/.exec(after);
    if (!w) return undefined;
    if (/^(?:commit|push|tag)$/.test(w[1])) { after = after.slice(w[0].length); continue; }
    return w[1];
  }
}

/** 卡㊳：**收口行**（RELEASE 行）的执行方提取——与锁行不同源（RELEASE 不是 CLAIM）。
 *  B 型实样：`06:34:08 **群PM（轮询器自动收口）｜RELEASE <sha> …` ⇒ 席名在前文、以 ｜ 收尾；
 *  A 型（`[ts] RELEASE(挂账) <sha>`）前文无席名 ⇒ undefined ＝ 不可归属（不判销任何锁）。
 *  席名不进死名单（⑤ 套件合成执行方 gate-test 也要能自销）——取 ｜ 前最后一个非分隔 token，
 *  且其前文必须过 structuredHeadOk（锚段/加粗/分隔符合法，叙述行不得借道）。 */
export function releaseActorOfLine(line: string): string | undefined {
  const m = /RELEASE(?:\([^)]*\)|（[^）]*）)?\s+[0-9a-fA-F]{7}/.exec(line);
  if (!m) return undefined;
  const before = line.slice(0, m.index);
  const inv = /(?:^|[\s*｜:（(])([^\s｜:（）*]+)(?:[（(][^）)\n]{1,12}[）)])?\s*｜\s*$/.exec(before);
  if (inv && structuredHeadOk(before.slice(0, inv.index))) return inv[1];
  return undefined;
}

/** 结构式前文判定（锁与 B 型收口共用）：锚段/执行方名（可带 ≤12 字括注）/加粗/分隔符自由组合，
 *  走到尾即放行（无论是否含锚——`**群PM｜` 加粗前缀本身就是锁行惯例）；剩余含叙述字符＝句中引用。
 *  卡㊳ allowBareActor＝B 型收口判定专用：head 已剥掉「席名（括注）｜」的 `｜` 与括注，
 *  以裸席名（gate-test 等合成执行方，≤12 字非分隔 token）收尾也放行——叙述行进不到这条
 *  链路（调用点只在 mb 正则命中「收口）｜RELEASE sha」之后），不构成叙述借道面。 */
function structuredHeadOk(before: string, allowBareActor = false): boolean {
  if (before.length === 0) return true; // 行首直跟（裸 CLAIM 锁）
  // 卡㊳（L4700 实咬后收窄）：allowBareActor **不许逐段蚕食**——上面的逐段循环会以 `｜?`
  // 可空尾把整句叙述当成席名序列吃光（叙述行被判真收口）。bare actor 只允许一种形态：
  // 整段 head（剥掉「席名（括注）｜」后）＝合法结构式前缀 + 一枚裸席名收尾。整体锚定判定：
  if (allowBareActor) {
    const bare = /(?:^|[\s*｜:（(])([^\s｜:（）*]{1,12})$/.exec(before);
    if (bare && structuredHeadOk(before.slice(0, bare.index))) return true;
    // 非 bare 收尾形态走默认逐段（genericActor 仍要求 ｜ 收尾，叙述行进不来）
  }
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
    // 卡㊳：合成执行方（⑤ 套件 gate-test 等）不进死名单——仅认「席名（可带括注）＋｜收尾」
    // 的倒置形态（与 releaseActorOfLine 的 B 型收口同款）；bare 收尾形态已在上面整体锚定
    // 处理。叙述行不得借道——枚 7/7b/7c 叙述负样本守的就是这格。
    const genericActor = /^([^\s｜:（）*]{1,12})(?:[（(][^）)\n]{1,12}[）)])?\s*｜/.exec(rest);
    if (genericActor) {
      rest = rest.slice(genericActor[0].length);
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

/** ⑰-补4 收口 B 型同套结构式（`…收口）｜RELEASE` 前文＝执行方前缀/锚段＋分隔符）。
 *  卡㊳：allowBareActor——head 剥完括注＋｜ 后以裸席名（合成执行方）收尾也放行。 */
function isRealReleaseB(line: string, idx: number): boolean {
  return structuredHeadOk(line.slice(0, idx), true);
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
  /** 卡㊳（私聊PM 派卡，2026-11-17）：按执行方配对视图——**新增字段，不动 locks/releases/unpaired
   *  的位置式旧语义**（unpaired＝位置式、含跨执行方互销，收紧须先报 PM 另批）。
   *  sameActorClosedLines＝被"执行方可归属且等执行方"收口行闭合的锁行号；
   *  unpairedByActor＝未被同执行方收口行闭合的锁按执行方分桶（锁自身执行方推不出 ⇒ 不可归属桶）；
   *  releasesUnattributable＝执行方推不出的收口行枚数（严格式行、读时推断，禁回写台账）。 */
  unpairedByActor: Record<string, number>;
  sameActorClosedLines: number[];
  releasesUnattributable: number;
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
  // 卡㊳（私聊PM 派卡）：**读时归属推断，不改位置式旧语义**。锁的执行方＝executorOfLine（卡㊲
  // 单源）；收口行执行方＝executorOfLine（A 型无执行方 ⇒ undefined ⇒ 归"不可归属"档，不得
  // 默认判销）。位置式 pairs 保留作向后兼容视图；同执行方闭合/未闭合分桶另出新字段。
  
  const sameActorClosedLines: number[] = [];
  const unpairedByActor: Record<string, number> = {};
  for (const l of locks) {
    const lockActor = executorOfLine(lines[l - 1] ?? '');
    // 卡㊳ 判据：其后存在**任一**同执行方收口行 ⇒ 已销（不限位置式首条——批次释放/多收口
    // 形态下，同执行方的收口可能排在别席收口之后）。收口行推不出执行方 ⇒ 不参与判销。
    const relActor = lockActor === undefined ? undefined
      : releases.find((n) => n > l && releaseActorOfLine(lines[n - 1] ?? '') === lockActor);
    if (lockActor !== undefined && relActor !== undefined) {
      sameActorClosedLines.push(l);
      continue;
    }
    // 未被同执行方收口闭合 ⇒ 未销（按执行方分桶；锁自身推不出执行方 ⇒ 不可归属桶）
    const bucket = lockActor ?? '不可归属';
    unpairedByActor[bucket] = (unpairedByActor[bucket] ?? 0) + 1;
  }
  const releasesUnattributable = releases.filter((n) => releaseActorOfLine(lines[n - 1] ?? '') === undefined).length;
  return {
    locks,
    releases,
    unpaired,
    pairs,
    dropped,
    unpairedByActor,
    sameActorClosedLines,
    releasesUnattributable,
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
  // 卡㊳：按执行方配对视图（新增行，旧三行语义不动）。bump 键序固定：群PM／私聊PM／不可归属／其余按序。
  const bucketOrder = ['群PM', '私聊PM', '不可归属'];
  const buckets = Object.keys(res.unpairedByActor).sort((a, b) => {
    const ia = bucketOrder.indexOf(a); const ib = bucketOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const bucketStr = buckets.length > 0
    ? buckets.map((k) => `${k}:${res.unpairedByActor[k]}`).join('／')
    : '全零（各锁均已被同执行方收口行闭合或无锁）';
  console.log(`unpaired_by_actor=${bucketStr}`);
  console.log(`releases_unattributable=${res.releasesUnattributable}`);
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
    // 执行方提取：**单一真相**＝executorOfLine（卡㊲）——正序与加粗倒置两形态同函数判定，
    // isExecutor 与未在册剔除两处共用它，杜绝"锁判定认、CLI 执行方不认"的相反判定
    // （路线图 §十二 ⑩：倒置行此前被误取卡号为执行方）。
    const executorOf = (n: number): string | undefined => executorOfLine(lines[n - 1] ?? '');
    const lastRelease = res.lastReleaseLine ?? 0;
    // ㉑-加闸可观测面：空 actor 下被名册剔除的锁逐枚列出（双向可证伪——剔了什么必须可见）
    const unregistered: number[] = [];
    // 卡㊳（私聊PM 派卡，2026-11-17；群PM 06:1x 裁定＋06:4x L4757 归一定稿）：销锁判据三层——
    // ① **带席名收口只销本席**（卡㊳ 本体：两 PM 不可互销）；
    // ② **A 型不可归属收口按位置销所有席**（63 枚历史 A 型若判"从未销锁"＝私聊PM 侧钩恒
    //    放行＝放开越权面，06:2x per-actor 版已废；位置销保留计数与 stderr 提示）；
    // ③ **sha 配对自愈出口**：锁行与收口行内 sha 相等即配对判销（不依赖席名——CLAIM 与
    //    RELEASE 同 sha 是强凭证——sha 配对作为**正信号**保留在 (g) 夹具与 sha 相等即配对
    //    语义中；"不等"不作否决权（否则 L4582/L4585 形态会因 sha 不等漏销＝死账复活）。
    // 窗口：⑱-② 的窗口意图由 soldBy 的"其后无任何收口 ⇒ 未销"表达（06:1x 单窗预筛与
    //    归一销锁判据互斥——「锁+唯一收口」形态永远出窗，卡㊳ 三格夹具两连咬后定稿撤销）。
    const releaseActorLine = (n: number): string | undefined => releaseActorOfLine(lines[n - 1] ?? '');
    const soldBy = (l: number, lockActor: string | undefined): boolean => {
      for (const n of res.releases) {
        if (n <= l) continue;
        const relActor = releaseActorLine(n);
        if (relActor !== undefined) {
          if (lockActor !== undefined && relActor === lockActor) return true; // ① 带席名只销本席
          continue; // 他席带席名收口不销本席锁
        }
        // ② A 型不可归属：按位置销所有席（06:4x L4757 归一——防单席钩恒放行）。
        return true;
      }
      return false;
    };
    const openClaims = res.locks.filter((n) => {
      const exec0 = executorOf(n);
      if (who === '') {
        if (exec0 !== undefined && !REGISTERED.includes(exec0)) {
          unregistered.push(n);
          return false;
        }
        if (exec0 === undefined) {
          // 锁自身推不出执行方 ⇒ 归不可归属档，不计入任何席的未销（与 parse 层 unpairedByActor
          // 的"不可归属"桶同语义——不参与判销也不顶门）
          return false;
        }
        return !soldBy(n, exec0);
      }
      // 具名：只看本执行方的锁（带席名收口只销本席；A 型按位置销＋sha 配对自愈）
      const exec = executorOf(n);
      if (exec !== who) return false;
      return !soldBy(n, exec);
    });
    // 不可归属收口诊断（可观测面：A 型按位置销所有席——计数保留、判销语义随 06:4x 归一）
    const unattributableCount = res.releases.filter((n: number) => releaseActorLine(n) === undefined).length;
    for (const n of unregistered) {
      console.error(`[check-claim] 执行方未在册剔除 L${n}（空 actor 只认在册 群PM／私聊PM）: ${(lines[n - 1] ?? '').slice(0, 120)}`);
    }
    if (unattributableCount > 0) {
      console.error(`[check-claim] ${unattributableCount} 枚收口行执行方不可归属（A 型无席名）——按位置销所有席（L4757 归一），计数保留`);
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
