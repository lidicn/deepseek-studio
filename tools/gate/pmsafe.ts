/**
 * tools/gate/pmsafe.ts — PM-LOG 安全追加（⑤，20261115 PM 派卡）
 *
 * 针对 2026-11-15 当晚三次损伤形态的机械自检：
 *   ① 06:35 粘行（上一条缺尾换行 ⇒ 新记录粘进上一行）——写前查末字节非 0x0A 则补前导换行；
 *   ② 08:02 `AGEN08:02`（短 token 被占位符替换连坐）——写入后**逐字回读**，与预期记录
 *      不全等即抛错（通道/工具层任何替换都逃不过回读）；
 *   ③ 07:58 假"已修"（Contains 判据与 regex 模式不一致）——自检用同一把正则判回读结果，
 *      断言与文档口径写在同一处。
 *
 * 两 PM 与闸三处共用：闸直接 import；PowerShell 侧经
 * `npx tsx tools/gate/pmsafe.ts <file> <line>` 调用（判据单源，不许各写各的）。
 */

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';

/** 新记录行首的时刻锚（回读自检判据）。 */
const TS_ANCHOR = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function timestamp(): string {
  const d = new Date();
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

/** 控制面台账规模下限（⑤-b，PM 09:00 实弹：pmsafe 新建出 139 B 野件 `PM-LOG`）。
 *  真台账现 1.45 MB；小于此值的既存文件＝疑似误指目标，拒绝写入。 */
const MIN_LOG_BYTES = 100 * 1024;

/**
 * 向日志文件追加**一块**记录（一条 CLAIM/裁定常 5–10 行，块级是常态——AGENTS「控制面写入」条），
 * 自检六道：
 *   1) 目标文件必须**已存在**——不存在即抛（文案带路径；防打错文件名新建野件，⑤-b PM 实弹）；
 *   2) 目标文件小于 100 KB 即抛（同上，防把小文件当台账）；
 *   3) 末字节非 0x0A ⇒ 先补前导换行（防粘行）；
 *   4) 块首行加时刻锚前缀、块尾必带换行（块内换行原样保留）；
 *   5) 回读**追加区逐字等于预期**——不等即抛（短 token 被占位符替换/粘连/截断当场抓）；
 *   6) 回读块首行行首匹配时刻锚。
 * 幂等语义：只追加、不改既有字节——第二次写不动第一次。
 * 占位符纪律（AGENTS）：如需模板替换，占位符必须用正文中不可能自然出现的串
 * （`{{TS}}`／`@@NOW@@`），禁止拿两三个字母的短 token 做全文 Replace。
 * **注意**：本入口是控制面（PM-LOG 真台账）专用——写探针输出等普通文件请用裸 write，
 * 不要让测试/脚本借道本入口写小文件。
 */
export function safeAppendBlock(file: string, block: string): void {
  if (!block.trim()) {
    throw new Error('SafeAppend 拒绝空块');
  }
  if (!existsSync(file)) {
    throw new Error(`SafeAppend 拒绝写入不存在的文件（防打错文件名新建野件——⑤-b PM 09:00 实弹）：${file}`);
  }
  const size = statSync(file).size;
  if (size < MIN_LOG_BYTES) {
    throw new Error(`SafeAppend 拒绝写入小于 ${MIN_LOG_BYTES} B 的文件（疑似误指目标，非控制面台账）：${file}（${size} B）`);
  }
  const buf = readFileSync(file);
  if (buf[buf.length - 1] !== 0x0a) {
    appendFileSync(file, '\n');
  }
  const ts = timestamp();
  // 卡⑳（群PM 16:3x 实弹）：正文开头已带时间戳 ⇒ 追加机器锚会造**双时刻行**——结构式锁判据
  // 把整行判成叙述（CLAIM 不落锁＝钩要抓的绕过面）。正文首行以 `[YYYY-MM-DD …` 开头 ⇒
  // 拒写（调用方自行决定用正文时刻还是机器锚，两套不可混）；其余块仍由本入口统一加锚。
  if (/^\s*\[\d{4}-\d{2}-\d{2} /.test(normalized(block).split('\n')[0])) {
    throw new Error(
      'SafeAppend 拒绝：正文开头已带时间戳（[YYYY-MM-DD…]）——机器锚会与之叠成双时刻行，' +
        '锁判据会把整行判成叙述（CLAIM 不落锁）。请二选一：去掉正文的时刻锚（用本入口的机器锚），' +
        '或直接用裸写入入口并自担三段式自检。卡⑳ 20261116 PM 实弹。',
    );
  }
  const record = `${ts} ${normalized(block)}\n`;
  const before = readFileSync(file, 'utf8');
  appendFileSync(file, record);
  // 回读自检：追加区（按字符切，不用字节——UTF-8 多字节会错位）逐字等于预期
  const after = readFileSync(file, 'utf8');
  const tail = after.slice(before.length);
  if (tail !== record) {
    throw new Error(`SafeAppend 自检失败：追加区与写入内容逐字不等（疑似通道替换或粘连）：${tail.slice(0, 80)}`);
  }
  const firstLine = record.split('\n')[0];
  if (!TS_ANCHOR.test(firstLine)) {
    throw new Error('SafeAppend 自检失败：新记录首行缺时刻锚');
  }
}

function normalized(block: string): string {
  return block.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/**
 * 向日志文件追加一行，四道自检：
 *   1) 末字节非 0x0A ⇒ 先补前导换行（防粘行）；
 *   2) 写入必带尾换行；
 *   3) 回读末行逐字等于「时刻锚＋line」——不等即抛（短 token 被替换/粘连当场抓）；
 *   4) 回读末行行首匹配时刻锚。
 * 幂等语义：只追加、不改既有字节——第二次写不动第一次。
 */
export function safeAppendLog(file: string, line: string): void {
  if (line.includes('\n')) {
    throw new Error('SafeAppend 拒绝多行写入：一条记录一行，多余换行会破坏行级自检——整块记录请用 safeAppendBlock');
  }
  safeAppendBlock(file, line);
}

/** PM-LOG 里下一个 GATE# 号段（数既有 RUNNING GATE#N 取 max+1；无文件从 1 起）。
 *  行首容忍时刻锚前缀（safeAppendLog 写入的行都带 [时刻] 前缀）。 */
export function nextGateRunNo(pmLog: string): number {
  if (!existsSync(pmLog)) return 1;
  const content = readFileSync(pmLog, 'utf8');
  let max = 0;
  for (const m of content.matchAll(/^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] )?RUNNING GATE#(\d+)/gm)) {
    max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export interface GateRunInfo {
  gateNo: number;
  actor: string;
  pid: number;
  head: string;
  dirty: number;
}

/** 闸起跑写 RUNNING 行（AGENTS：起全量闸必须落 RUNNING——⑤ 起由闸自写，不靠人记）。
 *  ⑤-补5（PM 判据，与 host-freshness「缺失≠陈旧，显式 N/A」同族）：**闸侧**在 PM-LOG.md
 *  不存在时**不抛**——打印 N/A 到 stdout 并返回 0（未登记）；CI 干净树天生没有 gitignored
 *  台账，这里抛会崩 gate 步骤（43660126937 那发）。人／席位显式写台账走 safeAppendLog／
 *  safeAppendBlock，**保持「不存在即抛」**——两条守卫语义不同，不许合并。 */
export function writeGateRunning(pmLog: string, info: Omit<GateRunInfo, 'gateNo'>): number {
  if (!existsSync(pmLog)) {
    console.log('[⑤ 闸自写] N/A：本树无 PM-LOG.md（干净 checkout／CI）——跳过 RUNNING 登记');
    return 0;
  }
  const gateNo = nextGateRunNo(pmLog);
  safeAppendLog(pmLog, `RUNNING GATE#${gateNo} by ${info.actor} pid=${info.pid} HEAD=${info.head} dirty=${info.dirty}`);
  return gateNo;
}

/** 闸收口写 END 行（exit 码与总时长取真实值，不许字面量——0.14.11 卡 B 同款口径）。
 *  ⑤-补5：gateNo=0（RUNNING 未登记）⇒ 静默跳过——不写不抛，不造伪发。 */
export function writeGateEnd(pmLog: string, gateNo: number, exitCode: number, totalSecs: string): void {
  if (gateNo === 0) {
    return;
  }
  if (!existsSync(pmLog)) {
    console.log('[⑤ 闸自写] N/A：本树无 PM-LOG.md（干净 checkout／CI）——跳过 END 登记');
    return;
  }
  safeAppendLog(pmLog, `END GATE#${gateNo} exit=${exitCode} total=${totalSecs}s`);
}

/**
 * ⑤-补6（PM 判据）：dry-run 的**顺序判据**抽成可注入纯函数——run.ts 只调它，
 * 判据与 spawn 解耦（DS 同款口径：要生效证据一律用导出纯函数断言）。
 * 返回 reject=true 时调用方**必须在任何写入之前**退出（D1：拒绝后置＝自己写伪发）。
 */
export function decideDryRun(pmLogPath: string): { reject: boolean; reason: string } {
  if (existsSync(pmLogPath)) {
    return {
      reject: true,
      reason: '本树存在 PM-LOG.md——dry-run 只用于空树（CI／干净 checkout），防伪发登记',
    };
  }
  return { reject: false, reason: '空树：N/A 登记链可走（无台账 ⇒ writeGateRunning 打 N/A 返回 0）' };
}

/** PowerShell 侧调用入口：
 *  单行：npx tsx tools/gate/pmsafe.ts <file> <line>
 *  块级（⑤-b）：npx tsx tools/gate/pmsafe.ts --file <blockFile> ——正文从文件读，
 *  不经 argv 传长正文（PM 09:00 实弹：内嵌双引号被 cmd /c 吃掉、正文截断到 139 B，
 *  逐字回读防的是进程内串，防不了参数在到达进程之前被截断）。 */
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('pmsafe.ts')) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === '--file') {
      const blockFile = argv[1];
      const target = argv[2];
      if (!blockFile || !target) {
        console.error('用法: npx tsx tools/gate/pmsafe.ts --file <blockFile> <target>');
        process.exit(2);
      }
      safeAppendBlock(target, readFileSync(blockFile, 'utf8'));
      console.log('SafeAppend OK (block via --file)');
    } else {
      const [file, line] = argv;
      if (!file || line === undefined) {
        console.error('用法: npx tsx tools/gate/pmsafe.ts <file> <line> 或 --file <blockFile> <target>');
        process.exit(2);
      }
      safeAppendBlock(file, line);
      console.log('SafeAppend OK');
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
