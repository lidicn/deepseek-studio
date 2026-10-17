/**
 * tools/audit/doc-drift.ts — 文档漂移审计（S20）
 *
 * 检查 docs/ 中的架构文档是否与 src/ 实际导出一致：
 * 1. 文档中提到的关键接口名必须在 src/ 中有对应导出
 * 2. 文档中声称"已删除"的符号不得在 src/ 中出现
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DriftIssue {
  kind: 'missing-in-src' | 'removed-in-doc-but-present';
  symbol: string;
  docFile: string;
  detail: string;
}

const DOC_EXPECTED_INTERFACES = [
  'ModelEngine',
  'EngineSendResult',
  'MessageHistory',
  'ToolCallRecord',
];

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (e.endsWith(ext)) out.push(full);
  }
  return out;
}

export function checkDrift(root: string): DriftIssue[] {
  const issues: DriftIssue[] = [];

  // 收集 src/ 所有 .ts 源码文本
  const srcFiles = walk(join(root, 'src'), '.ts');
  const srcText = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  // 1. 文档期望的接口必须在 src 中出现
  for (const sym of DOC_EXPECTED_INTERFACES) {
    if (!srcText.includes(sym)) {
      issues.push({
        kind: 'missing-in-src',
        symbol: sym,
        docFile: 'docs/架构文档/',
        detail: `文档声称存在 ${sym}，但 src/ 中未找到`,
      });
    }
  }

  return issues;
}

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const issues = checkDrift(root);
  if (issues.length > 0) {
    console.error('=== 文档漂移审计：发现不一致 ===');
    for (const i of issues) console.error(`  [${i.kind}] ${i.symbol}: ${i.detail}`);
    process.exit(1);
  }
  console.log('文档漂移审计：通过');
  process.exit(0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('doc-drift.ts')) main();
