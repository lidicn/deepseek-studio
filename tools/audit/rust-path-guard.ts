#!/usr/bin/env tsx
/**
 * tools/audit/rust-path-guard.ts — Rust 侧配置路径硬编码断言（P0 卡 (B) 判据，20261106）
 *
 * 背景：P1 路径漂移之一 = `load_host_grant_script` 硬编码 `home/.config/deepseek-studio/config.json`，
 * 逃出了批 N+1 的 env 注入（宿主读写 `%APPDATA%\com.deepseek.studio\config`，它仍读旧路径）→
 * 全新安装 grant 恒空串 → 页面通道永久断链。修法 = 抽 `resolve_config_dir()` 全仓唯一入口。
 *
 * 判据（裁定四十 修正后口径）：
 *   src-tauri/src 下（递归）全部 .rs 文件里 `.join(".config")` 只允许出现在——
 *   ① 注释行（`//` 开头）；② `fn resolve_config_dir` 函数体内（全仓唯一入口，含其 dev 分支）；
 *   ③ `#[cfg(test)]` 测试模块内的断言。其余任何位置出现 = FAIL。
 *
 * 先红后绿（实测，非推断）：
 *   红 = `b147ca5`（P0 卡修复前）→ 3 处真违规（`main.rs:479/:532/:825`，含 P1 路径漂移行）；
 *   绿 = HEAD（`ee4b149`）→ 2 处命中全豁免（`:570` 注释 + `:585` 唯一入口 dev 分支）。
 *
 * 已知边界（如实声明）：本判据只盯 `.join(".config")` 这半个字面量；`dirs::config_dir().join("deepseek-studio")`
 * 形态的 dev 回落（`main.rs:382/:1666`、`sidecar.rs:604`）**不在此判据内**——它们是批 N+1 段 2 注入
 * `STUDIO_LOG_DIR`/`STUDIO_CONFIG_DIR` 后要收敛的既有 dev 行为，由设计稿 §8.1 表格跟踪，不归本闸。
 *
 * 用法（gate 阻塞级）：npx tsx tools/audit/rust-path-guard.ts
 * 可选 --root <path>：扫指定目录（负控测试用临时仓，缺省扫本仓 src-tauri/src）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ri = argv.indexOf('--root');
const root = (ri !== -1 && argv[ri + 1]) ? resolve(argv[ri + 1]) : resolve(__dirname, '..', '..', 'src-tauri', 'src');

const PATTERN = /\.join\("\.config"\)/;

interface Violation { file: string; line: number; text: string }

/** 收集 *.rs（递归）。 */
function collectRustFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) acc.push(...collectRustFiles(full, acc));
    else if (e.name.endsWith('.rs')) acc.push(full);
  }
  return acc;
}

/** 去掉字符串字面量再数花括号，防字符串里的不平衡括号干扰深度。 */
function stripStrings(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function scanFile(file: string, rel: string): Violation[] {
  const violations: Violation[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');

  let depth = 0;
  let inResolve = false;
  let resolveStartDepth = 0;
  let pendingTest = false;
  let inTest = false;
  let testStartDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();
    const code = stripStrings(raw);
    const opens = (code.match(/\{/g) || []).length;
    const closes = (code.match(/\}/g) || []).length;

    // #[cfg(test)] 之后的 mod 块 = 测试区（到其闭合花括号为止）
    if (pendingTest && /\bmod\b/.test(trimmed) && trimmed.includes('{')) {
      inTest = true;
      testStartDepth = depth;
      pendingTest = false;
    }
    if (/^#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(trimmed)) pendingTest = true;

    if (!inResolve && /\bfn resolve_config_dir\b/.test(code)) {
      inResolve = true;
      resolveStartDepth = depth; // 函数签名行自身的大括号在下方才计入
    }

    const isCommentLine = trimmed.startsWith('//');
    if (PATTERN.test(raw) && !isCommentLine && !inResolve && !inTest) {
      violations.push({ file: rel, line: lineNo, text: trimmed });
    }

    depth += opens - closes;
    if (inResolve && depth <= resolveStartDepth) inResolve = false; // 函数体闭合
    if (inTest && depth <= testStartDepth) inTest = false;          // 测试 mod 闭合
  }
  return violations;
}

function main(): void {
  if (!statSync(root).isDirectory()) {
    console.error(`[rust-path-guard] ERROR: root 不存在或不是目录: ${root}`);
    process.exit(1);
  }
  const files = collectRustFiles(root);
  const violations: Violation[] = [];
  for (const f of files) {
    const rel = f.slice(root.length + 1).replace(/\\/g, '/');
    violations.push(...scanFile(f, rel));
  }

  if (violations.length > 0) {
    console.error(`[rust-path-guard] FAIL: ${violations.length} 处硬编码 .join(".config") 越出豁免区（唯一入口 resolve_config_dir / 注释 / 单测）：`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error('[rust-path-guard] 修复：改调 resolve_config_dir()（全仓唯一入口），不得自拼 ~/.config 路径。');
    process.exit(1);
  }
  console.log(`[rust-path-guard] PASS — ${files.length} 个 .rs 文件，硬编码 .join(".config") 零越区（豁免：resolve_config_dir 函数体 / 注释 / 单测断言）`);
}

main();
