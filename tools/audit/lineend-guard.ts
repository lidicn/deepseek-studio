#!/usr/bin/env tsx
/**
 * tools/audit/lineend-guard.ts — 行尾断言（20261106 Gate 第三件）
 *
 * 终结「内容未变却显示 M」的行尾伪影（今晚第二次：esbuild.inject.mjs 被 PowerShell 写成 CRLF）。
 *
 * 口径（@Core 纠正 + PM 更正事实后定死）：
 * - 断言对象 = **index 侧（i/）**，不是工作树（w/）。w/ 由 core.autocrlf + checkout 决定、
 *   i/ 由 .gitattributes 决定，**只有 i/ 是仓库约定**。读归一化后的内容会永远绿 → 必须读 index 原始字节。
 * - 数据源 = `git -c core.autocrlf=false ls-files --eol`（一次性列出全部跟踪文件）。
 * - 判红 = `i/crlf` 或 `i/mixed`；`w/crlf` 只提示不判红（正常 Windows checkout）。
 * - 豁免读 .gitattributes 的 `eol=crlf` / `binary`（`-text`）声明，**不硬编码扩展名清单**
 *   （硬编码必然与 .gitattributes 漂移）。attr 字段已含有效属性，直接用它判豁免。
 *
 * 用法（gate 阻塞级）：npx tsx tools/audit/lineend-guard.ts
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认扫本仓；--root <path> 覆盖（负控测试用临时仓，不改缺省行为）。
const argv = process.argv.slice(2);
const ri = argv.indexOf('--root');
const root = (ri !== -1 && argv[ri + 1]) ? resolve(argv[ri + 1]) : resolve(__dirname, '..', '..');

interface Row {
  path: string;
  iEol: string;
  wEol: string;
  attr: string;
}

function isExempt(attr: string): boolean {
  // attr 形如 "text=auto eol=lf" / "text eol=crlf" / "binary" / "-text"
  return /\beol=crlf\b/.test(attr) || /\bbinary\b/.test(attr) || /(^|\s)-text(\s|$)/.test(attr);
}

function parseLsEol(out: string): Row[] {
  const rows: Row[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    // 格式：i/<eol>\tw/<eol>\tattr/<attrs>\t<path>（path 前是 tab，path 可含空格）
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const head = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const tokens = head.trim().split(/\s+/);
    const iEol = tokens.find((t) => t.startsWith('i/'))?.slice(2) ?? '';
    const wEol = tokens.find((t) => t.startsWith('w/'))?.slice(2) ?? '';
    const attr = tokens.find((t) => t.startsWith('attr/'))?.slice(5) ?? '';
    if (path) rows.push({ path, iEol, wEol, attr });
  }
  return rows;
}

function main(): void {
  const out = execSync('git -c core.autocrlf=false ls-files --eol', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = parseLsEol(out);

  const violations: Row[] = [];
  let worktreeCrlf = 0;
  for (const r of rows) {
    if (r.iEol === 'crlf' || r.iEol === 'mixed') {
      if (!isExempt(r.attr)) violations.push(r);
    }
    if (r.wEol === 'crlf' && r.iEol !== 'crlf') worktreeCrlf += 1;
  }

  if (violations.length > 0) {
    console.error(`[lineend-guard] FAIL: ${violations.length} 个文件 index 侧行尾非 LF（仓库约定 eol=lf）：`);
    for (const v of violations) {
      console.error(`  i/${v.iEol}  attr/${v.attr || '(none)'}  ${v.path}`);
    }
    console.error('[lineend-guard] 修复：把该文件改回 LF（Set-Content -NoNewline 或编辑器切 LF）后 git add 再跑。');
    process.exit(1);
  }
  if (worktreeCrlf > 0) {
    console.log(`[lineend-guard] PASS — index 侧全 LF（${rows.length} 文件）；worktree 侧 ${worktreeCrlf} 个 CRLF（正常 Windows checkout，不判红）`);
  } else {
    console.log(`[lineend-guard] PASS — index 与 worktree 侧全 LF（${rows.length} 文件）`);
  }
}

main();
