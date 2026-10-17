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

const FORBIDDEN = ['MAX_NUDGES', 'RAW_TOOL_TAG_RE', 'stripRawToolTags', 'nudgePrompt', 'continuation-prompt'];

export function checkFile(filePath: string, content: string, root: string): M3Violation[] {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  // 白名单：tests / docs / tools 不查
  if (rel.startsWith('tests/') || rel.startsWith('docs/') || rel.startsWith('tools/')) return [];

  const violations: M3Violation[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    for (const sym of FORBIDDEN) {
      // continuation-prompt 是 import 路径，检查 import 行
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
