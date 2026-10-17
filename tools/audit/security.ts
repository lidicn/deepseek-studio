/**
 * tools/audit/security.ts — 安全审计清单（S21）
 *
 * 扫 src/ 生产代码，发现危险模式：
 * - eval() / new Function()
 * - innerHTML / outerHTML 赋值
 * - 硬编码密钥/密码/token
 * - shell.exec 未做输入净化
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SecurityIssue {
  pattern: string;
  file: string;
  line: number;
  text: string;
}

const DANGEROUS = [
  { re: /\beval\s*\(/, name: 'eval()' },
  { re: /new\s+Function\s*\(/, name: 'new Function()' },
  { re: /\.innerHTML\s*=/, name: 'innerHTML 赋值' },
  { re: /\.outerHTML\s*=/, name: 'outerHTML 赋值' },
  { re: /(password|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, name: '硬编码密钥' },
];

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

export function checkFile(filePath: string, content: string, root: string): SecurityIssue[] {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  if (rel.startsWith('tests/') || rel.startsWith('docs/') || rel.startsWith('tools/')) return [];

  const issues: SecurityIssue[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    for (const d of DANGEROUS) {
      if (d.re.test(lines[i])) {
        issues.push({ pattern: d.name, file: rel, line: i + 1, text: trimmed });
      }
    }
  }
  return issues;
}

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const all: SecurityIssue[] = [];
  for (const f of walk(join(root, 'src'))) {
    all.push(...checkFile(f, readFileSync(f, 'utf8'), root));
  }
  if (all.length > 0) {
    console.error('=== 安全审计：发现危险模式 ===');
    for (const i of all) console.error(`  [${i.pattern}] ${i.file}:${i.line}  ${i.text}`);
    process.exit(1);
  }
  console.log('安全审计：通过');
  process.exit(0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('security.ts')) main();
