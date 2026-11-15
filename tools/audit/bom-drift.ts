/**
 * tools/audit/bom-drift.ts — BOM 漂移检测（⑥，20261115 PM 派卡）
 *
 * 判据：**同一批次**（工作树 vs HEAD 的 git diff 覆盖文件）内，同一文件 BOM 有↔无翻转
 * ⇒ 阻塞级红。**不设「禁止 BOM」**——HEAD 自带 BOM 的历史件（现算 31 枚：18 .md／13 .ts）
 * 是存量不是缺陷，两边一致（有有／无无）一律绿。
 * 今晚实弹：三枚 .md 的 BOM 被 edit 工具吃掉（9113cbd 复原两枚、M3 剥净一枚）——
 * 就是本闸要拦的形态。
 *
 * 语义分叉（交卷口径）：闸跑在**本机提交前**（工作树 vs HEAD）＝判据效力面；
 * CI 上 push 后 `git diff HEAD` 为空 ⇒ scanned=0 ⇒ 步骤绿为常态（no-op 不崩即达意）。
 *
 * 字节安全：HEAD 版头 3 字节用 `git cat-file blob` + `encoding:'buffer'` 取
 * （execSync 字符串模式会经编码破坏 BOM 判定）。
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BomDriftIssue {
  file: string;
  direction: 'added' | 'removed';
}

const TEXT_EXT = /\.(?:md|ts|tsx|mjs|js|cjs|json|yml|yaml|html|txt|py|rs|css)$/;

function hasBom(head: Buffer): boolean {
  return head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
}

/** 本批改动文件清单：默认＝工作树 vs HEAD（本机提交前闸）；给 base（CI 推送基线）＝
 *  `base HEAD` 两 ref diff（CI 侧复判面——⑤-补2 同款「干净 checkout 真跑到」纪律的 ⑥ 版）。 */
export function collectChangedFiles(root: string, base?: string): string[] {
  const range = base ? `${base} HEAD` : 'HEAD';
  const out = execSync(`git -c core.quotepath=false diff --name-only -z ${range}`, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/** 任意 ref 的文件头 3 字节；ref 无此文件 ⇒ null。 */
function refHeadBytes(root: string, ref: string, rel: string): Buffer | null {
  try {
    const buf = execSync(`git -c core.quotepath=false cat-file blob "${ref}:${rel.split('\\').join('/')}"`, {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    return buf.subarray(0, 3);
  } catch {
    return null;
  }
}

/** ⑥ 甲案：解析推送基线——raw 为空/全零（新分支首推）回落 HEAD~1；仍无父提交 ⇒ undefined
 *  （scanned=0，步骤绿——首推无批可扫是语义内的空）。 */
export function resolveBase(root: string, raw?: string): string | undefined {
  let ref = raw && raw.length > 0 ? raw : undefined;
  if (!ref || /^0{40}$/.test(ref)) ref = 'HEAD~1';
  try {
    execSync(`git cat-file -e "${ref}^{commit}"`, { cwd: root, stdio: 'ignore' });
    return ref;
  } catch {
    return undefined;
  }
}

/**
 * ⑥-补（群PM 判据）：判据面决策抽成可注入纯函数（decideDryRun 同款）——env 层只决
 * 「哪个面」，**可达性**（GHOST：浅检出下基线对象不存在）由调用方在 resolveBase 后判。
 *   - CI（process.env.CI 真）＋ BOM_BASE 有值 ⇒ 'base'（复判面；对象不可达时调用方打 N/A）；
 *   - CI ＋ BOM_BASE 未设/全零 ⇒ 'na'（**缺失≠干净**——host-freshness 同族，不许打「通过」）；
 *   - 非 CI ⇒ 'work'（本机预检面：工作树 vs HEAD——回落链不许吃掉本机射程）。
 */
export function decideBomFace(env?: { CI?: string; BOM_BASE?: string }): {
  mode: 'work' | 'base' | 'na';
  reason: string;
} {
  const isCI = env?.CI === 'true' || env?.CI === '1';
  const raw = env?.BOM_BASE;
  if (isCI) {
    if (!raw || /^0{40}$/.test(raw)) {
      return { mode: 'na', reason: 'CI 上无推送基线可比对（BOM_BASE 未设或全零）——本步未判，缺失≠干净' };
    }
    return { mode: 'base', reason: `CI 推送基线复判面：${raw} vs HEAD` };
  }
  return { mode: 'work', reason: '本机预检面：工作树 vs HEAD（提交前拦截）' };
}

/** 纯判据：逐文件比对两侧 BOM 状态，只报翻转。 */
export function detectBomDrift(
  entries: { path: string; headHasBom: boolean | null; workHasBom: boolean }[],
): BomDriftIssue[] {
  const issues: BomDriftIssue[] = [];
  for (const e of entries) {
    if (e.headHasBom === null) continue; // 新增文件：无 HEAD 版
    if (e.headHasBom !== e.workHasBom) {
      issues.push({ file: e.path, direction: e.workHasBom ? 'added' : 'removed' });
    }
  }
  return issues;
}

export function scanBomDrift(root: string, opts?: { base?: string }): { issues: BomDriftIssue[]; scanned: number } {
  const issues: BomDriftIssue[] = [];
  let scanned = 0;
  const base = opts?.base;
  for (const rel of collectChangedFiles(root, base)) {
    if (!TEXT_EXT.test(rel)) continue;
    let oldBom: boolean | null;
    let newBom: boolean | null;
    if (base) {
      // CI 侧复判面：base 版 BOM vs HEAD 版 BOM（两侧都走 cat-file，工作树不参与）
      const ob = refHeadBytes(root, base, rel);
      if (ob === null) continue; // base 无此文件（base..HEAD 新增）→ 无翻转概念
      const nb = refHeadBytes(root, 'HEAD', rel);
      if (nb === null) continue; // HEAD 已删 → 不判
      oldBom = hasBom(ob);
      newBom = hasBom(nb);
    } else {
      // 本机预检面：HEAD 版 BOM vs 工作区版 BOM
      const abs = join(root, rel);
      if (!existsSync(abs)) continue; // 删除面：无工作区版，不判
      const hb = refHeadBytes(root, 'HEAD', rel);
      if (hb === null) continue; // 新增文件
      oldBom = hasBom(hb);
      newBom = hasBom(readFileSync(abs).subarray(0, 3));
    }
    scanned++;
    // detectBomDrift 字段语义在此复用：headHasBom＝旧版、workHasBom＝新版
    issues.push(...detectBomDrift([{ path: rel, headHasBom: oldBom, workHasBom: newBom }]));
  }
  return { issues, scanned };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  // ⑥-补：判据面由 decideBomFace 决策（可注入纯函数），main 只调它。
  const face = decideBomFace(process.env);
  let base: string | undefined;
  if (face.mode === 'na') {
    console.log(`[bom-drift] N/A——${face.reason}（本步未判）`);
    process.exit(0);
  }
  if (face.mode === 'base') {
    const baseRaw = process.argv.includes('--base')
      ? process.argv[process.argv.indexOf('--base') + 1]
      : process.env.BOM_BASE;
    base = resolveBase(root, baseRaw);
    if (!base) {
      // GHOST：浅检出下基线对象不可达——显式 N/A，绝不演成「判过了、很干净」
      console.log('[bom-drift] N/A——CI 上推送基线对象不可达（fetch-depth 浅检出未取到 before），本步未判');
      process.exit(0);
    }
  }
  const { issues, scanned } = scanBomDrift(root, { base });
  console.log(`[bom-drift] 本批（${base ? `基线 ${base.slice(0, 12)} vs HEAD` : '工作树 vs HEAD'}）改动文本文件 ${scanned} 枚`);
  if (issues.length > 0) {
    console.error('=== BOM 漂移（同批内同一文件 BOM 有↔无翻转）===');
    for (const i of issues) {
      console.error(`  [${i.direction === 'added' ? '加了 BOM' : '剥了 BOM'}] ${i.file}`);
    }
    console.error(`共 ${issues.length} 处。存量 BOM（HEAD 自带）不在此列、本闸不设「禁止 BOM」。`);
    process.exit(1);
  }
  console.log('[bom-drift] 通过（本批零 BOM 翻转）');
  process.exit(0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('bom-drift.ts')) {
  main();
}
