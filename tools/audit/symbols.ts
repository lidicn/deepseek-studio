#!/usr/bin/env tsx
/**
 * tools/audit/symbols.ts — M3 符号清零审计（S7）
 *
 * M3 删纠偏后，以下符号必须 0 命中（除白名单注释）：
 *   MAX_NUDGES / RAW_TOOL_TAG_RE / stripRawToolTags / MAX_LOOPS
 * shouldNudge 允许定义存在但调用必须 0。
 *
 * 用法：npx tsx tools/audit/symbols.ts
 * 退出码：0=全清零  1=有残留
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SymbolViolation {
  symbol: string;
  file: string;
  line: number;
  text: string;
}

/** 必须清零的符号（直接 grep 全文）。 */
const MUST_BE_ZERO = ['MAX_NUDGES', 'RAW_TOOL_TAG_RE', 'stripRawToolTags', 'MAX_LOOPS'];

/** 逐行扫描一个文件，返回违规。 */
export function checkFile(filePath: string, content: string, root: string): SymbolViolation[] {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');
  const violations: SymbolViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    // 跳过注释行（// 或 * 开头的 JSDoc）
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    for (const sym of MUST_BE_ZERO) {
      if (text.includes(sym)) {
        violations.push({ symbol: sym, file: rel, line: i + 1, text: trimmed });
      }
    }
  }

  // shouldNudge：允许定义但不允许调用
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    // 匹配 shouldNudge( 调用（不是函数定义 function shouldNudge）
    if (/shouldNudge\s*\(/.test(text) && !/function\s+shouldNudge|export\s+function\s+shouldNudge/.test(text)) {
      violations.push({ symbol: 'shouldNudge(call)', file: rel, line: i + 1, text: trimmed });
    }
  }

  return violations;
}

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory() && entry !== 'node_modules' && entry !== '.git') {
      // DCD 裁定 §1.1：尺子自排除 tools/audit/ 自身（常量表+判红代码在自己头上扫到红）。
      // 注意：tools/eval/ 不排除——run.ts:198 是 eval harness 在测 shouldNudge，
      //       M3 删完 shouldNudge 后这个 case 要跟着删，保留报警。
      if (entry === 'audit') continue;
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const dirs = ['src', 'tools'];
  const all: SymbolViolation[] = [];

  for (const d of dirs) {
    const dirPath = join(root, d);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of walkTsFiles(dirPath)) {
      all.push(...checkFile(file, readFileSync(file, 'utf8'), root));
    }
  }

  if (all.length > 0) {
    console.error('=== 符号清零审计：有残留 ===');
    for (const v of all) {
      console.error(`  [${v.symbol}] ${v.file}:${v.line}  ${v.text}`);
    }
    process.exit(1);
  }
  console.log('符号清零审计：全部清零');
  process.exit(0);
}

const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('symbols.ts');
if (isDirectRun) main();
