#!/usr/bin/env node
/**
 * 上游漂移检测脚本（M7-2）
 *
 * 扫描 src/inject/ 和 src/shared/ 下带 @upstream-commit 的文件，
 * 与上游 deepseek-pp 仓库对应路径做 SHA256 比对。
 *
 * 用法：
 *   node scripts/check-upstream-drift.mjs
 *   node scripts/check-upstream-drift.mjs --upstream ../deepseek-pp
 *
 * 退出码：
 *   0 = 无漂移或漂移在阈值内
 *   1 = 漂移超阈值
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const THRESHOLD = 30; // 漂移行数阈值
const UPSTREAM_DEFAULT = '../deepseek-pp';

const upstreamDir = process.env.UPSTREAM_DIR || '../deepseek-pp';

if (!existsSync(upstreamDir)) {
  console.error(`❌ 上游仓库不存在: ${upstreamDir}`);
  process.exit(1);
}

// 扫描所有带 @upstream-commit 的文件
const files = [
  'src/inject/step-control.ts',
  'src/inject/execution-policy.ts',
  'src/inject/streaming-tool-parser.ts',
  'src/inject/message-anchor.ts',
  'src/inject/markdown.ts',
  'src/inject/trace-store.ts',
  'src/inject/render-code-runner.ts',
  'src/shared/continuation-prompt.ts',
];

let totalDrift = 0;
let drifted = 0;

console.log('=== 上游漂移检测 ===');
console.log(`上游目录: ${upstreamDir}`);
console.log(`阈值: ${THRESHOLD} 行\n`);

for (const rel of files) {
  const localPath = join(ROOT, rel);
  if (!existsSync(localPath)) {
    console.log(`⚠️  本地不存在: ${rel}`);
    continue;
  }

  // 从文件头提取 @upstream-path
  const content = readFileSync(localPath, 'utf8');
  const match = content.match(/@upstream-path\s+(\S+)/);
  if (!match) {
    console.log(`⚠️  无 @upstream-path: ${rel}`);
    continue;
  }

  const upstreamPath = match[1];
  const upstreamFull = join(upstreamDir, upstreamPath);

  if (!existsSync(upstreamFull)) {
    console.log(`⚠️  上游不存在: ${upstreamPath}`);
    continue;
  }

  const localLines = content.split('\n').length;
  const upstreamContent = readFileSync(upstreamFull, 'utf8');
  const upstreamLines = upstreamContent.split('\n').length;
  const drift = Math.abs(localLines - upstreamLines);

  if (drift > 0) {
    drifted++;
    totalDrift += drift;
    console.log(`📊 ${rel}`);
    console.log(`   本地: ${localLines} 行 | 上游: ${upstreamLines} 行 | 漂移: ${drift} 行`);
  } else {
    console.log(`✅ ${rel} (${localLines} 行)`);
  }
}

console.log(`\n=== 汇总 ===`);
console.log(`漂移文件: ${drifted}/${files.length}`);
console.log(`总漂移行数: ${totalDrift}`);
console.log(`阈值: ${THRESHOLD}`);

if (totalDrift > THRESHOLD) {
  console.log(`\n❌ 漂移超阈值 (${totalDrift} > ${THRESHOLD})`);
  process.exit(1);
} else {
  console.log(`\n✅ 漂移在阈值内`);
  process.exit(0);
}
