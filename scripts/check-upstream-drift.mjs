#!/usr/bin/env node
/**
 * 上游漂移检测脚本（M7-2 / E2 判据升级 → 2026-11-14 改 (a) 定性登记表）
 *
 * 扫描 src 下带 @upstream-commit + @upstream-path 的移植文件，与上游 deepseek-pp 比对。
 *
 * 2026-11-14（群PM 出卡，Gate 执行）：从「SHA256 判漂移＋报红了事」升级为**三态定性登记表**：
 *   - 登记表 scripts/upstream-drift-registry.json：已定性漂移文件清单，每枚记
 *     {file, upstreamBlob16, localBlob16, verdictRef}（verdictRef 指 docs/dpp/上游漂移定性-20261114.md）；
 *   - 三态判定（M/K/A/D 四项定义，不许放宽）：
 *       identical  本地与上游逐字节一致（无漂移，绿）
 *       known      已登记且两侧 blob16 与登记值都一致 ⇒ 已知定性漂移，不报红
 *       stale      已登记但任一侧 blob16 变了 ⇒ 定性过期，FAIL（重新定性或更新登记表）
 *       new        未登记的漂移 ⇒ 新增漂移，FAIL
 *       anchor     上游文件不存在 / 锚点字段缺失 ⇒ 锚点异常，FAIL
 *   - 死移植（src 生产代码 0 引用）单独计数，同样 FAIL（要么接线，要么删件）。
 *
 * 上游路径真源（优先级）：--upstream > UPSTREAM_DIR > 登记表 upstreamPath。
 *
 * 用法：
 *   node scripts/check-upstream-drift.mjs
 *   node scripts/check-upstream-drift.mjs --upstream ../deepseek-pp
 *   UPSTREAM_DIR=../deepseek-pp node scripts/check-upstream-drift.mjs
 *
 * 退出码：0 = 无新增漂移、无定性过期、无锚点异常、无死移植（已知定性漂移不阻塞）；
 *         1 = 新增漂移 / 定性过期 / 锚点异常 / 死移植 任一存在。
 * 在 gate 中为**信息级**。
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
const REGISTRY_PATH = join(__dirname, 'upstream-drift-registry.json');

const argvUpstream = (() => {
  const i = process.argv.indexOf('--upstream');
  return i > -1 ? process.argv[i + 1] : null;
})();

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const blob16 = (buf) => sha256(buf).slice(0, 16);

/**
 * 登记表加载。缺失/损坏 ⇒ ok:false（所有漂移按「未登记」处理，fail-closed）。
 * 可注入 path 供测试。
 */
export function loadRegistry(path = REGISTRY_PATH) {
  if (!existsSync(path)) {
    return { ok: false, error: '登记表不存在', entries: new Map(), upstreamPath: null };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const entries = new Map();
    for (const e of raw.entries ?? []) entries.set(e.file, e);
    return { ok: true, error: null, entries, upstreamPath: raw.upstreamPath ?? null, updatedAt: raw.updatedAt ?? null };
  } catch (e) {
    return { ok: false, error: '解析失败: ' + e.message, entries: new Map(), upstreamPath: null };
  }
}

/** 上游目录解析优先级：--upstream > UPSTREAM_DIR > 登记表 upstreamPath。 */
export function resolveUpstreamDir({ cliArg, envDir, registry }) {
  if (cliArg) return cliArg;
  if (envDir) return envDir;
  if (registry && registry.upstreamPath) return registry.upstreamPath;
  return null;
}

/**
 * 三态分类（纯函数，供测试）。
 * @returns {'identical'|'known'|'stale'|'new'|'anchor'}
 */
export function classifyFile({ upstreamExists, anchorOk, identical, registered, localMatch, upstreamMatch }) {
  if (!upstreamExists || !anchorOk) return 'anchor';
  if (identical) return 'identical';
  if (!registered) return 'new';
  if (localMatch && upstreamMatch) return 'known';
  return 'stale';
}

/** 阻塞判定：新增漂移 / 定性过期 / 锚点异常 / 死移植 任一即阻塞（已知定性漂移不阻塞）。 */
export function hasBlockingFindings({ newDrift, stale, anchorIssues, deadPorts }) {
  return newDrift + stale + anchorIssues + deadPorts > 0;
}

/** 汇总计数行（判据③ 固定格式）。 */
export function formatSummaryLine({ identical, known, stale, newDrift, anchorIssues, deadPorts }) {
  return '一致: ' + identical + ' | 已知定性漂移: ' + known + ' | 新增漂移: ' + newDrift + ' | 定性过期: ' + stale + ' | 锚点异常: ' + anchorIssues + ' | 死移植: ' + deadPorts;
}

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

/**
 * 生产侧 importer 计数（死移植甄别）。
 * 计数方式：按 `from '<...>/<base>'` 的裸模块名匹配。tests/ 不算生产引用。
 */
function countProductionImporters(localPath, scanRoots, root) {
  const base = localPath.replace(/\\/g, '/').replace(/\.ts$/, '').split('/').pop();
  const re = new RegExp('from\\s+[\'"][^"\']*\\/' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\.ts)?[\'"]');
  const importers = [];
  for (const dir of scanRoots) {
    for (const f of walkTs(dir)) {
      if (f === localPath) continue;
      if (re.test(readFileSync(f, 'utf8'))) importers.push(f.slice(root.length + 1).replace(/\\/g, '/'));
    }
  }
  return { count: importers.length, importers };
}

/** 锚点之后该文件在上游被改动几次；-1 表示无法判定。 */
function upstreamChangesSince(gitRoot, repoPath, commit) {
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

function main() {
  let identical = 0;
  let known = 0;
  let stale = 0;
  let newDrift = 0;
  let anchorIssues = 0;
  let deadPorts = 0;

  const registry = loadRegistry();
  const upstreamDir = (() => {
    const d = resolveUpstreamDir({ cliArg: argvUpstream, envDir: process.env.UPSTREAM_DIR, registry });
    if (!d) {
      console.error('❌ 上游目录未定：--upstream / UPSTREAM_DIR / 登记表 upstreamPath 均未提供。');
      console.error('   登记表：' + REGISTRY_PATH);
      process.exit(1);
    }
    return d;
  })();

  if (!existsSync(upstreamDir)) {
    console.error('❌ 上游仓库不存在: ' + upstreamDir);
    console.error('   真源：scripts/upstream-drift-registry.json 的 upstreamPath（可用 --upstream / UPSTREAM_DIR 覆盖）。');
    process.exit(1);
  }

  const scanRoots = ['src/inject', 'src/shared', 'src/host', 'src/capabilities', 'src/desktop', 'src/ui']
    .map((d) => join(ROOT, d))
    .filter((d) => existsSync(d));
  const files = scanRoots.reduce((acc, d) => collectPortedFiles(d, acc), []).sort();

  /** 上游 git 根：dpp 现状是仓库根就在 src 子目录，也可能整体即仓库。 */
  const gitRoot = (() => {
    for (const cand of [upstreamDir, join(upstreamDir, 'src')]) {
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
  const toRepoPath = (upstreamPath) => {
    const norm = (gitRoot || '').replace(/\\/g, '/');
    if (norm.endsWith('/src')) return upstreamPath.replace(/^src\//, '');
    return upstreamPath;
  };

  console.log('=== 上游漂移检测（(a) 定性登记表）===');
  console.log('上游目录: ' + upstreamDir);
  console.log('git 根: ' + (gitRoot || '(未发现 git 仓库，仅做哈希比对)'));
  console.log('移植文件数: ' + files.length + '\n');

  for (const localPath of files) {
    const rel = localPath.slice(ROOT.length + 1).replace(/\\/g, '/');
    const content = readFileSync(localPath, 'utf8');
    const commit = content.match(/@upstream-commit\s+([0-9a-f]{7,40})/)?.[1];
    const upstreamPath = content.match(/@upstream-path\s+(\S+)/)?.[1];

    const imp = countProductionImporters(localPath, scanRoots, ROOT);
    if (imp.count === 0) deadPorts++;
    const impNote = imp.count === 0
      ? '☠️ 死移植：src 生产代码 0 引用'
      : 'importers ' + imp.count + ' (' + imp.importers.slice(0, 3).join(', ') + (imp.importers.length > 3 ? ' …' : '') + ')';

    const upstreamFull = join(upstreamDir, upstreamPath);
    const upstreamExists = existsSync(upstreamFull);
    const anchorOk = Boolean(commit && upstreamPath);

    const localHash = upstreamExists && anchorOk ? sha256(readFileSync(localPath, 'utf8')) : null;
    const upHash = upstreamExists && anchorOk ? sha256(readFileSync(upstreamFull)) : null;
    const entry = registry.entries.get(rel);
    const identicalBytes = Boolean(localHash && upHash && localHash === upHash);
    const localMatch = Boolean(localHash && entry && entry.localBlob16 === localHash.slice(0, 16));
    const upstreamMatch = Boolean(upHash && entry && entry.upstreamBlob16 === upHash.slice(0, 16));

    const state = classifyFile({
      upstreamExists,
      anchorOk,
      identical: identicalBytes,
      registered: Boolean(entry),
      localMatch,
      upstreamMatch,
    });

    if (state === 'identical') {
      identical++;
      console.log('✅ ' + rel + ' 与上游当前版本一致 | ' + impNote);
      continue;
    }
    if (state === 'known') {
      known++;
      console.log('🟡 ' + rel + ' 已知定性漂移（不阻塞） | ' + impNote);
      console.log('   定性结论：' + (entry.verdictRef || '(未注明出处)'));
      continue;
    }
    if (state === 'stale') {
      stale++;
      const changed = [];
      if (!localMatch) changed.push('本地 blob 变化（登记 ' + entry.localBlob16 + ' ≠ 现 ' + localHash.slice(0, 16) + '）');
      if (!upstreamMatch) changed.push('上游 blob 变化（登记 ' + entry.upstreamBlob16 + ' ≠ 现 ' + upHash.slice(0, 16) + '）');
      console.log('📊 ' + rel + ' 定性过期 → 需重新定性或更新登记表 | ' + impNote);
      console.log('   ' + changed.join('；'));
      continue;
    }
    if (state === 'new') {
      newDrift++;
      const changes = upstreamChangesSince(gitRoot, toRepoPath(upstreamPath), commit);
      console.log('📊 ' + rel + ' 未登记的新漂移 → 需定性并入登记表 | ' + impNote);
      console.log('   锚点 ' + (commit || '?').slice(0, 7) + ' | 本地 ' + localHash.slice(0, 12) + ' | 上游 ' + upHash.slice(0, 12) + ' | 上游自锚点后改动 ' + (changes < 0 ? '?' : changes) + ' 次');
      continue;
    }
    // state === 'anchor'
    anchorIssues++;
    console.log('⚠️  ' + rel + (upstreamExists ? ' 锚点字段缺失（@upstream-commit/@upstream-path）' : ' 上游不存在 ' + upstreamPath + '（上游已改名/删除，需人工订正锚点）') + ' | ' + impNote);
  }

  console.log('\n=== 汇总 ===');
  console.log(formatSummaryLine({ identical, known, stale, newDrift, anchorIssues, deadPorts }));
  console.log('   登记表: ' + REGISTRY_PATH + (registry.ok ? '（updatedAt ' + (registry.updatedAt ?? '?') + '，登记 ' + registry.entries.size + ' 枚）' : '（⚠ 缺失/不可读：' + registry.error + '——漂移按未登记处理）'));
  if (deadPorts > 0) {
    console.log('   （死移植 = 已移植但 src 生产代码 0 引用；要么接线，要么删件，别继续背漂移债）');
  }

  if (hasBlockingFindings({ newDrift, stale, anchorIssues, deadPorts })) {
    console.log('\n❌ 上游漂移哨兵：存在需处理项（新增漂移/定性过期/锚点异常/死移植）。已知定性漂移不阻塞，出处见登记表 verdictRef。');
    process.exit(1);
  }
  console.log('\n✅ 上游漂移哨兵：无新增漂移、无定性过期、无锚点异常、无死移植。已知定性漂移 ' + known + ' 枚（见登记表 verdictRef），不阻塞。');
  process.exit(0);
}

const isDirectRun =
  typeof process.argv[1] === 'string' && process.argv[1].replace(/\\/g, '/').endsWith('scripts/check-upstream-drift.mjs');
if (isDirectRun) main();
