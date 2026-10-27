#!/usr/bin/env node
/**
 * 上游漂移检测脚本（M7-2 / E2 判据升级）
 *
 * 扫描 src 下带 @upstream-commit + @upstream-path 的移植文件，与上游 deepseek-pp 比对。
 *
 * E2（2026-10-27）：旧版用「行数差」判漂移，既分不清谁改了、也分不清是本地裁剪还是
 * 上游新增（移植文件有意取子集，行数天然不等）。现以 **SHA256 不等** 判「有漂移」，
 * 再用上游 git 查锚点之后该文件的**变更次数**判「谁改的」——这才是可行动信号。
 * 同时把硬编码清单改为动态扫描：旧清单曾长期挂着本地已不存在的 execution-policy.ts。
 *
 * 用法：
 *   node scripts/check-upstream-drift.mjs
 *   node scripts/check-upstream-drift.mjs --upstream ../deepseek-pp
 *   UPSTREAM_DIR=../deepseek-pp node scripts/check-upstream-drift.mjs
 *
 * 退出码：0 = 全部与上游当前版本逐字节一致；1 = 存在漂移或锚点异常。
 * 在 gate 中为**信息级**：移植文件与上游有意分叉，红是真实待办而非噪音。
 *
 * 本脚本读真实上游，不依赖 studio 仓库内的任何拷贝
 * （内嵌 deepseek-pp/ 快照已于 2026-10-27 删除）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const argvUpstream = (() => {
  const i = process.argv.indexOf('--upstream');
  return i > -1 ? process.argv[i + 1] : null;
})();
const upstream = argvUpstream || process.env.UPSTREAM_DIR || '../deepseek-pp';

if (!existsSync(upstream)) {
  console.error('❌ 上游仓库不存在: ' + upstream);
  console.error('   本脚本需能读到 E:\\NAS\\deepseek-pp（或用 --upstream 指定）。');
  process.exit(1);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 动态收集移植文件（硬编码清单会漏新文件）。 */
function collectPortedFiles(dir, acc) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      collectPortedFiles(full, acc);
    } else if (e.name.endsWith('.ts')) {
      const head = readFileSync(full, 'utf8').slice(0, 2400);
      if (/@upstream-commit\s+[0-9a-f]{7,40}/.test(head) && /@upstream-path\s+\S+/.test(head)) acc.push(full);
    }
  }
  return acc;
}

const scanRoots = ['src/inject', 'src/shared', 'src/host', 'src/capabilities', 'src/desktop', 'src/ui']
  .map((d) => join(ROOT, d))
  .filter((d) => existsSync(d));
const files = scanRoots.reduce((acc, d) => collectPortedFiles(d, acc), []).sort();

/** 上游 git 根：dpp 现状是仓库根就在 src 子目录，也可能整体即仓库。 */
const gitRoot = (() => {
  for (const cand of [join(upstream, 'src'), upstream]) {
    try {
      execSync('git -C "' + cand + '" rev-parse --git-dir', { stdio: 'ignore' });
      return cand;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
})();

/** @upstream-path 以 src/ 起头，而 git 根就是 src 时需剥掉该前缀。 */
function toRepoPath(upstreamPath) {
  const norm = (gitRoot || '').replace(/\\/g, '/');
  if (norm.endsWith('/src')) return upstreamPath.replace(/^src\//, '');
  return upstreamPath;
}

/** 锚点之后该文件在上游被改动几次；-1 表示无法判定。 */
function upstreamChangesSince(repoPath, commit) {
  if (!gitRoot) return -1;
  try {
    const out = execSync('git -C "' + gitRoot + '" rev-list --count ' + commit + '..HEAD -- "' + repoPath + '"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const n = Number.parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/**
 * 生产侧 importer 计数（死移植甄别）。
 *
 * 移植进来但**没有任何 src 生产代码引用**的文件，是纯负债：既要跟上游漂移，又不产出功能。
 * 计数方式：按 `from '<...>/<base>'` 的**裸模块名**匹配（import 路径写法五花八门——相对深度、
 * 扩展名有无——只认 basename，避免漏计）。tests/ 不算生产引用：测试单向喂不叫"接线"。
 *
 * @returns {{count:number, importers:string[]}}
 */
function countProductionImporters(localPath) {
  const base = localPath.replace(/\\/g, '/').replace(/\.ts$/, '').split('/').pop();
  const re = new RegExp('from\\s+[\'"][^"\']*\\/' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\.ts)?[\'"]');
  const importers = [];
  for (const dir of scanRoots) {
    for (const f of walkTs(dir)) {
      if (f === localPath) continue;
      if (re.test(readFileSync(f, 'utf8'))) importers.push(f.slice(ROOT.length + 1).replace(/\\/g, '/'));
    }
  }
  return { count: importers.length, importers };
}

/** 递归列出目录下所有 .ts（跳过 node_modules）。 */
function* walkTsIter(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      yield* walkTsIter(full);
    } else if (e.name.endsWith('.ts')) {
      yield full;
    }
  }
}
function walkTs(dir) {
  return [...walkTsIter(dir)];
}

let drifted = 0;
let unchanged = 0;
let anchorIssues = 0;
let deadPorts = 0;

console.log('=== 上游漂移检测（E2：SHA256 判据）===');
console.log('上游目录: ' + upstream);
console.log('git 根: ' + (gitRoot || '(未发现 git 仓库，仅做哈希比对)'));
console.log('移植文件数: ' + files.length + '\n');

for (const localPath of files) {
  const rel = localPath.slice(ROOT.length + 1).replace(/\\/g, '/');
  const content = readFileSync(localPath, 'utf8');
  const commit = content.match(/@upstream-commit\s+([0-9a-f]{7,40})/)?.[1];
  const upstreamPath = content.match(/@upstream-path\s+(\S+)/)?.[1];

  const imp = countProductionImporters(localPath);
  if (imp.count === 0) deadPorts++;
  const impNote = imp.count === 0
    ? '☠️ 死移植：src 生产代码 0 引用'
    : 'importers ' + imp.count + ' (' + imp.importers.slice(0, 3).join(', ') + (imp.importers.length > 3 ? ' …' : '') + ')';

  const upstreamFull = join(upstream, upstreamPath);
  if (!existsSync(upstreamFull)) {
    console.log('⚠️  ' + rel + ': 上游不存在 ' + upstreamPath + '（上游已改名/删除，需人工订正锚点）');
    console.log('   ' + impNote);
    anchorIssues++;
    drifted++;
    continue;
  }

  const localHash = sha256(content);
  const upHash = sha256(readFileSync(upstreamFull));
  if (localHash === upHash) {
    unchanged++;
    console.log('✅ ' + rel + ' 与上游当前版本一致 | ' + impNote);
    continue;
  }

  drifted++;
  const changes = upstreamChangesSince(toRepoPath(upstreamPath), commit);
  const note = changes < 0
    ? '无法判定上游变更次数（git 查询失败或锚点不在本仓库）'
    : changes === 0
      ? '上游自锚点后未改此文件 → 差异全部来自本地改动，应核对本地改动是否该回灌上游'
      : '上游自锚点后改动 ' + changes + ' 次 → 本地可能缺上游修复，优先核对';
  console.log('📊 ' + rel);
  console.log('   ' + impNote);
  console.log('   锚点 ' + (commit || '?').slice(0, 7) + ' | 本地 ' + localHash.slice(0, 12) + ' | 上游 ' + upHash.slice(0, 12));
  console.log('   ' + note);
}

console.log('\n=== 汇总 ===');
console.log('一致: ' + unchanged + ' | 漂移: ' + drifted + ' | 锚点/路径异常: ' + anchorIssues + ' | 死移植: ' + deadPorts);
if (deadPorts > 0) {
  console.log('   （死移植 = 已移植但 src 生产代码 0 引用；要么接线，要么删件，别继续背漂移债）');
}

if (drifted > 0) {
  console.log('\n❌ 存在上游漂移（gate 信息级：不阻塞提交，待办见 docs/dpp/上游快照锚点-UPSTREAM.md）');
  process.exit(1);
}
console.log('\n✅ 所有移植文件与上游当前版本逐字节一致');
process.exit(0);
