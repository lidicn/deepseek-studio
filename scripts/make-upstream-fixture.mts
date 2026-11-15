/**
 * scripts/make-upstream-fixture.mts — 上游引用夹具仓生成器（④②c，20261115 PM 派卡）
 *
 * 背景：CI（windows runner）上没有 `E:\NAS\deepseek-pp`，doc-drift 的上游强校验
 * 正判据分支（isFile/isDir＋行号界内）此前一次都没在干净 checkout 上判过——绿的只是
 * N/A 那半条链。本脚本从 docs **现算** `<upstream-repo>/` 引用集（与闸抽取同口径），
 * 在目标目录生成一枚夹具上游仓：文件型按该路径被引最大行号 +20 行生成，目录型 mkdir。
 * **自维护**：docs 新增/修改上游引用后重跑即跟上，夹具不会滞后于引用面。
 *
 * 用法：
 *   npx tsx scripts/make-upstream-fixture.mts <目标目录>          # 好夹具（界内引用全绿）
 *   npx tsx scripts/make-upstream-fixture.mts <目标目录> --broken # 坏夹具（最大行号引用必越界）
 *
 * 负控语义（--broken）：把引用行号最大的那枚文件砍到 3 行 ⇒ 闸必红
 * （「上游引用第 N 行，但 … 最多只有 3 行」），供 CI 负控 job 断言 exit 1、红输出留档。
 * 夹具只写目标目录（RUNNER_TEMP），不触碰 docs/**、无删除分支。
 *
 * **口径（PM 20261115 记账）**：CI 上好夹具绿＝证明「正判据分支被执行过」，
 * **不证明**「上游真漂移能被抓到」——夹具行数是按 docs 声称造的（自指），
 * 真漂移检测仍只在本机真仓（`E:\NAS\deepseek-pp`）跑；**红半那发（--broken 负控）
 * 才是判据有效性的证据**。后来者不得把 CI 绿读成「上游可比对」。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_DIRS } from '../tools/audit/doc-drift';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2];
const broken = process.argv.includes('--broken');
if (!outDir) {
  console.error('用法: npx tsx scripts/make-upstream-fixture.mts <目标目录> [--broken]');
  process.exit(2);
}

// 1) 收集 docs 目录下的全部 md（与闸扫描同集合）
const files: string[] = [];
const walk = (dir: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full);
    else if (e.endsWith('.md')) files.push(full);
  }
};
for (const d of DOC_DIRS) walk(join(scriptRoot, d));

// 2) 现算 upstream 引用的 distinct path + 最大行号（与 doc-drift 抽取同口径：
//    剥围栏 → RE_UPSTREAM_ANY 同形正则 → parseUpstreamCap 同形剥行号）
const pathMax = new Map<string, number>();
const re = /<upstream-repo>\/([A-Za-z0-9_\-./:]+)/g;
let total = 0;
for (const f of files) {
  const t = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
  for (const m of t.matchAll(re)) {
    const pm = /^(.*?)(?::(\d+(?:-\d+)?(?:\/\d+(?:-\d+)?)*))?$/.exec(m[1]);
    const rel = (pm?.[1] ?? m[1]).replace(/[.:]+$/, '');
    if (rel.replace(/[./]+$/, '') === '') continue; // 残缺形态归闸守卫管，不进夹具
    total++;
    const nums = pm?.[2] ? pm[2].split('/').flatMap((s) => s.split('-').map(Number)) : [];
    const max = Math.max(pathMax.get(rel) ?? 0, ...(nums.length ? nums : [0]));
    pathMax.set(rel, max);
  }
}

// 3) 生成夹具仓
const HEAD_PAD = 20;
mkdirSync(outDir, { recursive: true });
let made = 0;
for (const [rel, max] of [...pathMax].sort((a, b) => a[0].localeCompare(b[0]))) {
  const abs = join(outDir, rel);
  if (max === 0) {
    mkdirSync(abs, { recursive: true }); // 目录型引用（cd <upstream-repo>/src 等）
    made++;
    continue;
  }
  const lines = broken && max === Math.max(...pathMax.values())
    ? 3 // 坏夹具：把最大行号引用的那枚砍到 3 行 ⇒ 必越界
    : max + HEAD_PAD;
  mkdirSync(dirname(abs), { recursive: true });
  const body = Array.from({ length: lines }, (_, i) => `// fixture line ${i + 1}`).join('\n');
  writeFileSync(abs, body + '\n', 'utf8');
  made++;
}
console.log(`fixture@${outDir} broken=${broken} 引用=${total} distinct=${pathMax.size} 生成=${made}`);
