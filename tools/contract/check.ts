#!/usr/bin/env tsx
/**
 * tools/contract/check.ts — 契约守门（S2）
 *
 * 静态读源码文本做断言，不 import 运行（避免副作用与循环依赖）。
 * 判定前先剥注释（stripComments）：文档注释里的字面量不参与契约判定（20261101 F6 假阳性教训）。
 * 任何席位改坏 ModelEngine / MessageHistory / TaskLoop 的契约，这里立刻红。
 *
 * 用法：npx tsx tools/contract/check.ts
 * 退出码：0=全过  1=有违规
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 类型

export interface ContractViolation {
  rule: string;
  message: string;
}

// ---------------------------------------------------------------- 注释剥离

// 这些关键字后面跟 / 是正则字面量开始（而非除号）
const REGEX_ALLOWED_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * 剥掉 TS 源码里的注释（行注释 + 块注释/JSDoc），字符串 / 正则 / 模板字面量原样保留。
 *
 * 契约断言只看代码本体：文档注释里出现的 'xxx' 字面量不得参与契约判定。
 * （20261101 F6 教训：task-loop.ts 类型 union 内部的 JSDoc 含 completion='disconnected'，
 * 被白名单扫描当成非法成员，产生假红。）
 *
 * 实现为单遍扫描的 mini-lexer：字符串与正则字面量透传（不剥离其中的引号），
 * 用「前一个有效 token」启发式区分除号与正则起始。已知限制：模板字符串 ${} 内
 * 嵌套反引号不递归处理；三个目标文件（model-engine / message-history / task-loop）实测无此形态。
 */
export function stripComments(src: string): string {
  const n = src.length;
  let out = '';
  let i = 0;
  let prev = ''; // 上一个有效 token：标识符/数字完整串，或单个符号字符；'' 表示尚未出现

  const regexStart = (): boolean => {
    if (prev === '') return true;
    if (/^[0-9a-zA-Z_$]+$/.test(prev)) {
      return REGEX_ALLOWED_KEYWORDS.has(prev);
    }
    return !(prev === ')' || prev === ']' || prev === '"' || prev === "'" || prev === '`');
  };

  while (i < n) {
    const c = src.charAt(i);
    const d = src.charAt(i + 1);

    // 行注释：吞到行尾（换行本身保留）
    if (c === '/' && d === '/') {
      while (i < n && src.charAt(i) !== '\n') i++;
      continue;
    }
    // 块注释 / JSDoc：整体吞掉，替换成一个空格保持词法分隔
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) i++;
      i = Math.min(i + 2, n);
      out += ' ';
      continue;
    }
    // 字符串 / 模板字面量：原样透传（含转义）
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const s = src.charAt(i);
        out += s;
        i++;
        if (s === '\\' && i < n) {
          out += src.charAt(i);
          i++;
          continue;
        }
        if (s === quote) break;
      }
      prev = quote;
      continue;
    }
    // 正则字面量：按「前一个有效 token」区分除号与正则起始
    if (c === '/' && regexStart()) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const s = src.charAt(i);
        out += s;
        i++;
        if (s === '\\' && i < n) {
          out += src.charAt(i);
          i++;
          continue;
        }
        if (s === '[') inClass = true;
        else if (s === ']') inClass = false;
        else if (s === '/' && !inClass) break;
        else if (s === '\n') break; // 未闭合正则容错：不吞整行
      }
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) {
      prev = /[0-9a-zA-Z_$]/.test(c) && /^[0-9a-zA-Z_$]+$/.test(prev) ? prev + c : c;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- 断言函数（纯文本）

/**
 * ModelEngine 契约：
 * - 必须导出 ModelEngine / EngineSendResult / ToolCallRecord / createApiEngineStub
 * - EngineSendResult.toolCalls 必须是 number（不能改成必填对象）
 * - EngineSendResult.toolCallRecords 必须可选（?）
 * - ModelEngine 必须有 name / health / send / waitForNextReply?
 */
export function checkModelEngine(src: string): ContractViolation[] {
  const v: ContractViolation[] = [];
  const rule = 'ModelEngine';
  src = stripComments(src); // 注释先剥：文档注释不得参与契约判定

  // 导出成员
  if (!/export\s+(interface|type)\s+ModelEngine\b/.test(src)) {
    v.push({ rule, message: '缺少 export interface ModelEngine' });
  }
  if (!/export\s+(interface|type)\s+EngineSendResult\b/.test(src)) {
    v.push({ rule, message: '缺少 export interface EngineSendResult' });
  }
  if (!/export\s+(interface|type)\s+ToolCallRecord\b/.test(src)) {
    v.push({ rule, message: '缺少 export interface ToolCallRecord' });
  }
  if (!/export\s+function\s+createApiEngineStub\b/.test(src)) {
    v.push({ rule, message: '缺少 export function createApiEngineStub' });
  }

  // toolCalls 必须仍是 number（不是 ToolCallRecord[] 或其他对象）
  if (!/readonly\s+toolCalls\s*:\s*number\s*;/.test(src)) {
    // 检查 toolCalls 是否存在且不是 number
    const tc = src.match(/readonly\s+toolCalls\s*:\s*([^;]+);/);
    if (tc) {
      v.push({ rule, message: `EngineSendResult.toolCalls 类型被改成非 number（当前: ${tc[1].trim()}）` });
    } else {
      v.push({ rule, message: 'EngineSendResult 中找不到 toolCalls 字段' });
    }
  }

  // toolCallRecords 必须可选（如果存在的话）
  const tcr = src.match(/readonly\s+toolCallRecords(\??)\s*:/);
  if (tcr && tcr[1] !== '?') {
    v.push({ rule, message: 'toolCallRecords 被改成必填（破坏 additive 契约）' });
  }

  // ModelEngine 必须有 name / health / send（全文搜索，不依赖块提取）
  // 2026-11-13 N2-04：send 增加可选 signal（additive），规则同步；signal 必须可选。
  if (!/\bsend\s*\(\s*text\s*:\s*string\s*(?:,\s*signal\s*\?\s*:\s*AbortSignal\s*)?\)\s*:\s*Promise/.test(src)) {
    v.push({ rule, message: 'ModelEngine 缺少 send(text: string) 方法' });
  }
  // signal 若存在必须可选（必填＝破坏 additive 契约；负例 6c 锁）
  if (/\bsend\s*\(\s*text\s*:\s*string\s*,\s*signal\s*:\s*AbortSignal/.test(src)) {
    v.push({ rule, message: 'ModelEngine.send 的 signal 参数被改成必填（破坏 additive 契约）' });
  }
  // waitForNextReply?（可选方法）：存在且 signal 必须可选（2026-11-13 N2-04 同步，防同坑再踩；负例 6d 锁）
  if (!/\bwaitForNextReply\s*\?\s*\(\s*(?:signal\s*\?\s*:\s*AbortSignal\s*)?\)\s*:\s*Promise/.test(src)) {
    v.push({ rule, message: 'ModelEngine 缺少 waitForNextReply?（可选方法、可选 signal）' });
  }
  if (/\bwaitForNextReply\s*\?\s*\(\s*signal\s*:\s*AbortSignal/.test(src)) {
    v.push({ rule, message: 'ModelEngine.waitForNextReply 的 signal 参数被改成必填（破坏 additive 契约）' });
  }
  if (!/\bhealth\s*\(\s*\)\s*:\s*Promise/.test(src)) {
    v.push({ rule, message: 'ModelEngine 缺少 health() 方法' });
  }
  if (!/\bname\s*:\s*'web'\s*\|\s*'api'/.test(src)) {
    v.push({ rule, message: 'ModelEngine 缺少 name 字段' });
  }

  return v;
}

/**
 * MessageHistory 契约：
 * - MESSAGE_HISTORY_VERSION 必须为 1
 * - MessageHistorySnapshot.version 必须为字面量 1
 * - restore 必须在 version 不符时抛错
 * - 必须导出 createMessageHistory
 */
export function checkMessageHistory(src: string): ContractViolation[] {
  const v: ContractViolation[] = [];
  const rule = 'MessageHistory';
  src = stripComments(src); // 注释先剥：文档注释不得参与契约判定

  if (!/export\s+const\s+MESSAGE_HISTORY_VERSION\s*=\s*1\b/.test(src)) {
    v.push({ rule, message: 'MESSAGE_HISTORY_VERSION 不是 1' });
  }
  if (!/export\s+function\s+createMessageHistory\b/.test(src)) {
    v.push({ rule, message: '缺少 export function createMessageHistory' });
  }

  // snapshot.version 必须是字面量 1
  const snapBlock = src.match(/export\s+interface\s+MessageHistorySnapshot\s*\{([\s\S]*?)\}/);
  if (snapBlock) {
    const ver = snapBlock[1].match(/readonly\s+version\s*:\s*([^;]+);/);
    if (ver) {
      if (!/^\s*1\s*$/.test(ver[1].trim())) {
        v.push({ rule, message: `MessageHistorySnapshot.version 不是字面量 1（当前: ${ver[1].trim()}）` });
      }
    } else {
      v.push({ rule, message: 'MessageHistorySnapshot 缺少 version 字段' });
    }
  }

  // restore 必须有版本检查抛错
  if (!/restore[\s\S]*?version[\s\S]*?throw/.test(src)) {
    v.push({ rule, message: 'restore 方法未见 version 不匹配时 throw' });
  }

  return v;
}

/**
 * TaskLoop 契约：
 * - TaskLoopStopReason 必须只有这些合法值：completed / no-tool-calls / timeout / max-rounds / empty-response / read-no-data / interrupted / aborted
 *   （read-no-data = 页还活着、引擎连续读不到数据，与 empty-response=页端消失/传输断 二分；20261101 F6 新增）
 *   （interrupted = M1 新终态：流已过完但无完成哨兵、且本轮有可见输出；用户主动 stop 不归它；20261102 M1 新增）
 * - 必须导出 createTaskLoop
 */
export function checkTaskLoop(src: string): ContractViolation[] {
  const v: ContractViolation[] = [];
  const rule = 'TaskLoop';
  src = stripComments(src); // 注释先剥：union 内部 JSDoc 里的字面量不算成员（F6 假阳性根源）

  if (!/export\s+function\s+createTaskLoop\b/.test(src)) {
    v.push({ rule, message: '缺少 export function createTaskLoop' });
  }

  // 抓 TaskLoopStopReason 类型定义
  const stopType = src.match(/export\s+type\s+TaskLoopStopReason\s*=([\s\S]*?);/);
  if (stopType) {
    const body = stopType[1];
    const allowed = ['completed', 'no-tool-calls', 'timeout', 'max-rounds', 'empty-response', 'read-no-data', 'interrupted', 'aborted'];
    // 提取所有字符串字面量
    const literals = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const a of allowed) {
      if (!literals.includes(a)) {
        v.push({ rule, message: `TaskLoopStopReason 缺少合法值 '${a}'` });
      }
    }
    // 检查有没有非法值（不在白名单里的）
    for (const lit of literals) {
      if (!allowed.includes(lit)) {
        v.push({ rule, message: `TaskLoopStopReason 出现非法值 '${lit}'` });
      }
    }
  } else {
    v.push({ rule, message: '找不到 TaskLoopStopReason 类型定义' });
  }

  return v;
}

// ---------------------------------------------------------------- CLI

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');

  const targets = [
    { file: 'src/host/engine/model-engine.ts', check: checkModelEngine },
    { file: 'src/host/kernel/message-history.ts', check: checkMessageHistory },
    { file: 'src/host/kernel/task-loop.ts', check: checkTaskLoop },
  ];

  let allViolations: ContractViolation[] = [];

  for (const t of targets) {
    const p = join(root, t.file);
    if (!existsSync(p)) {
      allViolations.push({ rule: 'file', message: `文件不存在: ${t.file}` });
      continue;
    }
    const src = readFileSync(p, 'utf8');
    const violations = t.check(src);
    allViolations = allViolations.concat(violations);
  }

  if (allViolations.length > 0) {
    console.error('=== 契约守门：违规 ===');
    for (const v of allViolations) {
      console.error(`  [${v.rule}] ${v.message}`);
    }
    process.exit(1);
  }

  console.log('契约守门：全部通过（ModelEngine / MessageHistory / TaskLoop）');
  process.exit(0);
}

// 仅直接执行时跑 main
const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('check.ts');
if (isDirectRun) {
  main();
}
