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

/**
 * 向日志文件追加**一块**记录（一条 CLAIM/裁定常 5–10 行，块级是常态——AGENTS「控制面写入」条），
 * 自检四道：
 *   1) 末字节非 0x0A ⇒ 先补前导换行（防粘行）；
 *   2) 块首行加时刻锚前缀、块尾必带换行（块内换行原样保留）；
 *   3) 回读**追加区逐字等于预期**——不等即抛（短 token 被占位符替换/粘连/截断当场抓）；
 *   4) 回读块首行行首匹配时刻锚。
 * 幂等语义：只追加、不改既有字节——第二次写不动第一次。
 * 占位符纪律（AGENTS）：如需模板替换，占位符必须用正文中不可能自然出现的串
 * （`{{TS}}`／`@@NOW@@`），禁止拿两三个字母的短 token 做全文 Replace。
 */
export function safeAppendBlock(file: string, block: string): void {
  if (!block.trim()) {
    throw new Error('SafeAppend 拒绝空块');
  }
  const normalized = block.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (existsSync(file) && statSync(file).size > 0) {
    const buf = readFileSync(file);
    if (buf[buf.length - 1] !== 0x0a) {
      appendFileSync(file, '\n');
    }
  }
  const ts = timestamp();
  const record = `${ts} ${normalized}\n`;
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
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

/** 闸起跑写 RUNNING 行（AGENTS：起全量闸必须落 RUNNING——⑤ 起由闸自写，不靠人记）。 */
export function writeGateRunning(pmLog: string, info: Omit<GateRunInfo, 'gateNo'>): number {
  const gateNo = nextGateRunNo(pmLog);
  safeAppendLog(pmLog, `RUNNING GATE#${gateNo} by ${info.actor} pid=${info.pid} HEAD=${info.head} dirty=${info.dirty}`);
  return gateNo;
}

/** 闸收口写 END 行（exit 码与总时长取真实值，不许字面量——0.14.11 卡 B 同款口径）。 */
export function writeGateEnd(pmLog: string, gateNo: number, exitCode: number, totalSecs: string): void {
  safeAppendLog(pmLog, `END GATE#${gateNo} exit=${exitCode} total=${totalSecs}s`);
}

/** PowerShell 侧调用入口：npx tsx tools/gate/pmsafe.ts <file> <line> */
if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('pmsafe.ts')) {
  const [, , file, line] = process.argv;
  if (!file || line === undefined) {
    console.error('用法: npx tsx tools/gate/pmsafe.ts <file> <line>');
    process.exit(2);
  }
  try {
    safeAppendLog(file, line);
    console.log('SafeAppend OK');
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
