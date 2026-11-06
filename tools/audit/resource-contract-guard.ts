#!/usr/bin/env tsx
/**
 * tools/audit/resource-contract-guard.ts — bundle.resources ↔ main.ts 契约一致性守卫（20261106）
 *
 * 背景：C 卡发现 mcp-settings 壳三件资源在 main.ts 契约里（`:126-128` path.join(resourceRoot, …)）
 * 但未进 tauri.conf.json 的 bundle.resources → dev 能跑（resourceRoot=仓库根）、装版 500
 * （resource_dir 下没有这三件）。与 P0 竞态同族：dev 形态与装版形态路径解析不同。
 *
 * 判据（只做正向，不反向）：
 *   main.ts 里所有 path.join(resourceRoot, …) 字面量派生的仓库相对路径，
 *   必须全部出现在 src-tauri/tauri.conf.json 的 bundle.resources 里。
 *   缺一条 → FAIL exit 1，点名缺的那条 + main.ts 行号。
 *   孤儿条目（列了但 main.ts 不 join）→ INFO 不阻塞（如 host/main.mjs、node/node.exe 由 Rust 侧解析）。
 *
 * 先红后绿（真实缺陷上的红，无需造假源码）：
 *   当前树：10 条 join = 7 agent（全在）+ 3 mcp-settings（全缺）→ FAIL 点名 3 条；
 *   UI 把三行加进 bundle.resources 后 → PASS。
 *
 * 豁免面：只扫 path.join(resourceRoot, …) 的字面量派生；不扫 dev-only 路径、不扫 Rust 侧解析的条目。
 *
 * 用法（gate 阻塞级）：npx tsx tools/audit/resource-contract-guard.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// --root <path>：扫描目标仓根（负控测试用临时仓；缺省 = 本仓根）。
const argv = process.argv.slice(2);
const ri = argv.indexOf('--root');
const root = (ri !== -1 && argv[ri + 1]) ? resolve(argv[ri + 1]) : resolve(__dirname, '..', '..');
const mainTsPath = join(root, 'src', 'api', 'main.ts');
const tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json');

/** 从 main.ts 提取所有 path.join(resourceRoot, 'src'|'dist', …) 的仓库相对路径（POSIX slash）。 */
interface JoinEntry { relPath: string; line: number }

function extractResourceJoins(filePath: string): JoinEntry[] {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const entries: JoinEntry[] = [];
  // 匹配 path.join(resourceRoot, 'seg1', 'seg2', …) —— 只取字面量段，跳过变量/表达式。
  const re = /path\.join\(\s*resourceRoot\s*,\s*((?:"[^"]*"|'[^']*')(?:\s*,\s*(?:"[^"]*"|'[^']*'))*)\s*\)/g;
  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      const segsRaw = m[1];
      const segs: string[] = [];
      const segRe = /["']([^"']*)["']/g;
      let sm: RegExpExecArray | null;
      while ((sm = segRe.exec(segsRaw)) !== null) segs.push(sm[1]);
      if (segs.length > 0) entries.push({ relPath: segs.join('/'), line: i + 1 });
    }
  }
  return entries;
}

/** 从 tauri.conf.json bundle.resources 收集所有目标相对路径（POSIX slash、去 ../ 前缀）。
 *  tauri v2 resources 形态：对象 { "source": "target" } 或字符串数组（本仓用对象形态）。 */
function extractBundleResources(filePath: string): Set<string> {
  const conf = JSON.parse(readFileSync(filePath, 'utf8'));
  const set = new Set<string>();
  const resources = conf?.bundle?.resources;
  if (resources && typeof resources === 'object' && !Array.isArray(resources)) {
    // 对象形态：{ "../src/ui/agent.html": "src/ui/agent.html" } —— value 是装版目标路径
    for (const target of Object.values(resources as Record<string, string>)) {
      if (typeof target === 'string') {
        const clean = target.replace(/\\/g, '/').replace(/^\.\.\//, '');
        set.add(clean);
      }
    }
  } else if (Array.isArray(resources)) {
    for (const entry of resources) {
      const target = typeof entry === 'string' ? entry : (entry && typeof entry === 'object') ? Object.values(entry)[0] : null;
      if (typeof target === 'string') {
        const clean = target.replace(/\\/g, '/').replace(/^\.\.\//, '');
        set.add(clean);
      }
    }
  }
  return set;
}

function main(): void {
  // 装置自检：真读到两个文件且解析出有效内容（防路径写错导致永远绿）
  if (!existsSync(mainTsPath)) { console.error('[resource-contract-guard] ERROR: main.ts 不存在: ' + mainTsPath); process.exit(1); }
  if (!existsSync(tauriConfPath)) { console.error('[resource-contract-guard] ERROR: tauri.conf.json 不存在: ' + tauriConfPath); process.exit(1); }

  const joins = extractResourceJoins(mainTsPath);
  if (joins.length < 10) {
    console.error(`[resource-contract-guard] ERROR: 从 main.ts 提取出的 resourceRoot join 条数 = ${joins.length}（预期 ≥ 10），可能路径或解析逻辑变了，请核。`);
    process.exit(1);
  }

  const bundleSet = extractBundleResources(tauriConfPath);
  if (bundleSet.size === 0) {
    console.error('[resource-contract-guard] ERROR: tauri.conf.json bundle.resources 解析出 0 条，可能 JSON 结构变了，请核。');
    process.exit(1);
  }

  const missing: JoinEntry[] = [];
  for (const j of joins) {
    if (!bundleSet.has(j.relPath)) missing.push(j);
  }

  // 孤儿条目（列了但 main.ts 不 join）—— INFO 不阻塞
  const joinPaths = new Set(joins.map((j) => j.relPath));
  const orphans: string[] = [];
  for (const r of bundleSet) if (!joinPaths.has(r)) orphans.push(r);

  if (missing.length > 0) {
    console.error(`[resource-contract-guard] FAIL: ${missing.length} 条 resourceRoot join 派生的路径未出现在 tauri.conf.json bundle.resources（dev 能跑、装版 500）：`);
    for (const m of missing) {
      console.error(`  main.ts:${m.line}  →  ${m.relPath}  （bundle.resources 缺这条）`);
    }
    console.error('[resource-contract-guard] 修复：在 src-tauri/tauri.conf.json 的 bundle.resources 加上这些条目。');
    console.error(`[resource-contract-guard] INFO（不阻塞）：bundle.resources 里有 ${orphans.length} 条孤儿（main.ts 不 join，可能是 Rust 侧解析）：${orphans.join(', ')}`);
    process.exit(1);
  }

  console.log(`[resource-contract-guard] PASS — ${joins.length} 条 resourceRoot join 全部在 bundle.resources 里；孤儿 ${orphans.length} 条（INFO 不阻塞）`);
}

main();
