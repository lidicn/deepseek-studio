#!/usr/bin/env tsx
/**
 * tools/contract/check.ts — 契约守门（S2）
 *
 * 静态读源码文本做断言，不 import 运行（避免副作用与循环依赖）。
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
  if (!/\bsend\s*\(\s*text\s*:\s*string\s*\)\s*:\s*Promise/.test(src)) {
    v.push({ rule, message: 'ModelEngine 缺少 send(text: string) 方法' });
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
 * - TaskLoopStopReason 必须只有四个合法值：completed / no-tool-calls / timeout / max-rounds
 * - 必须导出 createTaskLoop
 */
export function checkTaskLoop(src: string): ContractViolation[] {
  const v: ContractViolation[] = [];
  const rule = 'TaskLoop';

  if (!/export\s+function\s+createTaskLoop\b/.test(src)) {
    v.push({ rule, message: '缺少 export function createTaskLoop' });
  }

  // 抓 TaskLoopStopReason 类型定义
  const stopType = src.match(/export\s+type\s+TaskLoopStopReason\s*=([\s\S]*?);/);
  if (stopType) {
    const body = stopType[1];
    const allowed = ['completed', 'no-tool-calls', 'timeout', 'max-rounds', 'empty-response'];
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
