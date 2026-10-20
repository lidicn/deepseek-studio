/**
 * tools/audit/security.ts — 安全审计清单（S21）
 *
 * 扫 src/ 生产代码，发现危险模式：
 * - eval() / new Function()
 * - innerHTML / outerHTML 赋值
 * - 硬编码密钥/密码/token
 *
 * 2026-10-17 第六轮审计后采用分级口径：
 * - 纯静态模板、已消毒/已转义表达式 → warn（保留人工复核线索，不阻断）
 * - 含未识别插值或裸变量 → error（阻断）
 * - `// security-ok: 理由` → 人工确认，降为 warn
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SecuritySeverity = 'error' | 'warn';

export interface SecurityIssue {
  pattern: string;
  file: string;
  line: number;
  text: string;
  severity: SecuritySeverity;
  reason?: string;
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

function hasSecurityOk(lines: string[], index: number): boolean {
  if (/security-ok\s*:/i.test(lines[index] ?? '')) return true;
  for (let i = Math.max(0, index - 6); i < index; i++) {
    if (/security-ok\s*:/i.test(lines[i] ?? '')) return true;
  }
  return false;
}

/** 收集一条赋值语句，跨行模板也能看到 escapeHtml / renderMarkdown 等包装。 */
function collectStatement(lines: string[], index: number): string {
  let text = lines[index] ?? '';
  for (let i = index + 1; i < lines.length && i <= index + 40; i++) {
    text += '\n' + lines[i];
    if (/;\s*(?:\/\/.*)?$/.test(lines[i])) break;
  }
  return text;
}

function rhsOf(text: string): string {
  const index = text.indexOf('=');
  return index >= 0 ? text.slice(index + 1).trim() : text.trim();
}

function isEmptyClear(rhs: string): boolean {
  return /^(['"`])\1?\s*;?$/.test(rhs);
}

function isStaticLiteral(rhs: string): boolean {
  if (/^(['"])/.test(rhs) && !rhs.includes('${')) return true;
  // 纯模板字面量（没有 ${...}）是静态骨架。
  if (/^`/.test(rhs) && !rhs.includes('${')) return true;
  return false;
}

function isSanitizedExpression(text: string): boolean {
  return /\b(?:escapeHtml|sanitizeHtml|renderMarkdown|buildCardHtml|DOMPurify\.sanitize)\s*\(/.test(text);
}

function classifyHtmlAssignment(text: string, opts: { securityOk: boolean }): {
  severity: SecuritySeverity;
  reason: string;
  skip?: boolean;
} {
  const rhs = rhsOf(text);
  if (isEmptyClear(rhs)) {
    return { severity: 'warn', reason: '清空内容，无动态插值', skip: true };
  }
  if (isStaticLiteral(rhs)) {
    return { severity: 'warn', reason: '静态模板，无动态插值' };
  }
  if (opts.securityOk) return { severity: 'warn', reason: 'security-ok 人工确认' };
  if (isSanitizedExpression(text)) return { severity: 'warn', reason: '经 sanitizer/renderMarkdown/escapeHtml 包装' };
  return { severity: 'error', reason: '动态 HTML 值未被转义或消毒' };
}

export function checkFile(filePath: string, content: string, root: string): SecurityIssue[] {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  if (rel.startsWith('tests/') || rel.startsWith('docs/') || rel.startsWith('tools/')) return [];

  const issues: SecurityIssue[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    for (const d of DANGEROUS) {
      if (!d.re.test(lines[i])) continue;

      if (d.name === 'innerHTML 赋值' || d.name === 'outerHTML 赋值') {
        const statement = collectStatement(lines, i);
        const result = classifyHtmlAssignment(statement, { securityOk: hasSecurityOk(lines, i) });
        if (result.skip) continue;
        issues.push({
          pattern: d.name,
          file: rel,
          line: i + 1,
          text: trimmed,
          severity: result.severity,
          reason: result.reason,
        });
      } else {
        const securityOk = hasSecurityOk(lines, i);
        issues.push({
          pattern: d.name,
          file: rel,
          line: i + 1,
          text: trimmed,
          severity: securityOk ? 'warn' : 'error',
          reason: securityOk ? 'security-ok 人工确认' : '直接执行/硬编码敏感模式',
        });
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

  const errors = all.filter((issue) => issue.severity === 'error');
  const warnings = all.filter((issue) => issue.severity === 'warn');
  if (errors.length > 0) {
    console.error(`=== 安全审计：发现 ${errors.length} 条阻断项 ===`);
    for (const issue of errors) {
      console.error(`  [error] [${issue.pattern}] ${issue.file}:${issue.line}  ${issue.reason ?? ''}  ${issue.text}`);
    }
  }
  if (warnings.length > 0) {
    console.log(`=== 安全审计：${warnings.length} 条提示（已分类，不阻断） ===`);
    for (const issue of warnings) {
      console.log(`  [warn] [${issue.pattern}] ${issue.file}:${issue.line}  ${issue.reason ?? ''}`);
    }
  }

  const strict = process.argv.includes('--strict');
  if (errors.length > 0 || (strict && warnings.length > 0)) {
    process.exit(1);
  }
  console.log(`安全审计：通过（error=${errors.length}, warn=${warnings.length}）`);
  process.exit(0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('security.ts')) main();
