/**
 * tools/audit/m3-clean.ts — M3 全仓符号清零审计（S12）
 *
 * 扫 src/** 生产代码，确认 nudge/纠偏相关符号为 0。
 * 白名单：tests/**、docs/**、tools/**（审计脚本自身）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface M3Violation {
  symbol: string;
  file: string;
  line: number;
  text: string;
}

const FORBIDDEN = ['MAX_NUDGES', 'RAW_TOOL_TAG_RE', 'stripRawToolTags', 'nudgePrompt'];
// 20261102 豁免记录（Studio-PM 授权「活的 import 记带理由豁免」，Gate 核实落笔）：
// 'continuation-prompt' 从本名单移除——src/shared/continuation-prompt.ts 已演进为页端
// 续跑协议的单一真相源（PendingResult 类型提升见 main-world-interceptor.ts:133，
// buildContinuationPrompt / buildProtocolRepairPrompt 在 :2495-2496 生产调用），
// import 7/7 符号全有真实使用，「清零」目标对该模块不再适用。
// 'stripRawToolTags' 仍在名单：它是 stripRawToolText 的等价包装壳（:78），
// UI 等价替换小卡（:2664/:2737 调用点直连真实现、删壳）落地后应归零。
// 20261102 复核（Gate）：UI 已清壳——src 全树 stripRawToolTags 0 命中，m3-clean 转绿；
// 名单保持不动（防回归：壳若被重新引入会再红）。

export function checkFile(filePath: string, content: string, root: string): M3Violation[] {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  // 白名单：tests / docs / tools 不查
  if (rel.startsWith('tests/') || rel.startsWith('docs/') || rel.startsWith('tools/')) return [];

  const violations: M3Violation[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    // 注释行跳过：// 行、/* 块注释（含单行 /** … */，20261102 修正——原先只跳 // 与 *，
    // 导致 task-loop.ts 顶置 JSDoc 里提到 continuation-prompt 被误计为代码残留）。
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    for (const sym of FORBIDDEN) {
      if (text.includes(sym)) {
        violations.push({ symbol: sym, file: rel, line: i + 1, text: trimmed });
      }
    }
  }
  return violations;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const all: M3Violation[] = [];
  for (const f of walk(join(root, 'src'))) {
    all.push(...checkFile(f, readFileSync(f, 'utf8'), root));
  }
  if (all.length > 0) {
    console.error('=== M3 生产代码符号清零：有残留 ===');
    for (const v of all) console.error(`  [${v.symbol}] ${v.file}:${v.line}  ${v.text}`);
    process.exit(1);
  }
  console.log('M3 生产代码符号清零：通过');
  process.exit(0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('m3-clean.ts')) main();
