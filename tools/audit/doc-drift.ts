/**
 * tools/audit/doc-drift.ts — 文档↔代码漂移审计（S20 重写 / 门禁接线 2026-10-31）
 *
 * 旧版只查 4 个硬编码符号名是否出现在 src 全文里，一个文档都不读（CI 绿是假绿）。
 * 那个符号存在性检查已由 tools/contract/check.ts 的静态契约断言覆盖，这里不再重复。
 *
 * 现版扫描 docs/设计稿、docs/验收报告、docs/harness 下的 Markdown（剔除代码围栏）：
 *
 * 阻塞（发现即 exit 1）：
 *   1) `file.ts:N` / `file.ts:N-M` 行号引用（含 `dir/file.ts:N` 相对写法）——
 *      basename 须能在 src/ tools/ src-tauri/ scripts/ tests/ 下解析到文件
 *      （先精确匹配，找不到按 `*<basename>` 后缀匹配，容纳
 *      `sse-frame-decoder.ts` ↔ `deepseek-sse-frame-decoder.ts` 这类缩写引用），
 *      且引用行号不得超过文件实际行数；
 *   2) `src/...` / `tools/...` 带行号的路径引用 —— 同上，按路径精确解析。
 *
 * 豁免（20261105 CI 环境对齐）：引用指向 gitignore 目录（logs/、.studio-tmp/、
 *   .screenshots/ 等）或未跟踪文件时，**可解析性检查跳过**——这些是本机取证产物，
 *   CI 环境天然没有，不该挡 CI（本地 gate 绿、CI 红的差异正是这个）。行号越界仍查
 *   （若该文件在本地存在则按实际行数查；不存在则跳过，不判 fail）。
 *   真漂移（该在库里却不在的，如 src/xxx.ts 被删但文档还在引用）仍红，不受影响。
 *
 * 信息（打印，不阻塞）：
 *   - `src/...` / `tools/...` 不带行号但文件不存在 —— 设计稿引用"规划中/已裁撤"
 *     模块属文档侧待办（20261031 实测 14 处，见 docs/Audit/20261031-门禁接线.md），
 *     修文档归文档所有者，不阻塞合并。
 *
 * 口径备注：
 *   - 行数 = 全文按 `\n` 切分（与 PowerShell `(Get-Content).Count` 一致；比
 *     `Measure-Object -Line` 多计空行——20261031 实测 policy.ts 300 vs 271，
 *     用后者会把合法引用误判成漂移）。
 *   - 代码围栏（``` / ~~~）内不算引用；`file.ts:N` 的 N-M 区间两端都校验。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

/**
 * 判断一个仓库相对路径是否「本地存在但不会进 CI」——即落在 gitignore 目录内、
 * 或文件本身未跟踪。CI 环境天然没有这些文件，doc-drift 对它们的可解析性检查
 * 不该挡 CI（本地有、CI 没有 = 假红）。
 *
 * 口径（PM 20261105 裁定）：
 *   - 豁免只限「目标路径落在已忽略目录或文件未跟踪」；
 *   - 真漂移（该在库里却不在的）仍红，不受影响。
 */
function isIgnoredOrUntracked(root: string, rel: string): boolean {
  // 去掉行号尾巴，取纯路径
  const pathOnly = rel.replace(/:\d+(?:-\d+)?$/, '');
  if (existsSync(join(root, pathOnly))) {
    // 本地有这个文件 → 看它是不是已跟踪
    try {
      execSync(`git ls-files --error-unmatch -- "${pathOnly}"`, {
        cwd: root,
        stdio: 'ignore',
      });
      return false; // 已跟踪，不豁免
    } catch {
      return true; // 本地有但未跟踪 → 豁免
    }
  }
  // 本地也没有 → 看路径是否落在已忽略目录内
  try {
    const out = execSync(`git check-ignore -- "${pathOnly}"`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false; // 不是 ignored 且本地不存在 → 走原 fail 逻辑（真漂移）
  }
}

export interface DocDriftIssue {
  severity: 'fail' | 'warn';
  ref: string;
  docFile: string;
  detail: string;
}

/** 扫描的文档目录（仓库相对路径；目录不存在则跳过并注明）。
 *  20261114 补缺口（PM 派卡）：`docs/验收/` 是实证文本目录（Verify 取证报告落点），
 *  此前不在覆盖集 → 其 `path:line` 引用从无人校验。加入后语义与其他实证目录一致。 */
export const DOC_DIRS = ['docs/设计稿', 'docs/验收', 'docs/验收报告', 'docs/harness'];

/**
 * 设计稿目录（20261114 目录语义分流，PM 派卡）：设计稿是**设计时命名**——
 * 先起的名、实现换了落点（如 `src/host/reply-source/*.ts`、`src/host/memory/*.ts`）。
 * 其「引用不存在路径」不混进漂移数，单列「设计稿待落点」计数（可见、不静默）；
 * `docs/验收报告/**`、`docs/harness/**` 是实证文本，同类引用照旧报真漂移。
 * 豁免只覆盖「路径不存在」类；行号越界（文件在、行不对＝代码已改动文档未跟）
 * 与阻塞级判定在任何目录都不放松。
 */
export const DESIGN_DIRS = ['docs/设计稿'];

/** basename 解析索引覆盖的代码根（仓库相对路径）。 */
export const INDEX_ROOTS = ['src', 'tools', 'src-tauri', 'scripts', 'tests'];

const CODE_EXT = /\.(?:tsx|ts|mjs|js)$/;

interface Ref {
  /** 原文写法（用于报告）。 */
  raw: string;
  /** 带 src/、tools/ 或相对目录前缀的路径；纯 basename 引用为 null。 */
  path: string | null;
  /** 文件 basename（解析 key）。 */
  base: string;
  /** 引用行号（区间两端都记）。 */
  lines: number[];
  docFile: string;
  /** true = 阻塞级；false = 信息级（不带行号的规划路径）。 */
  blocking: boolean;
}

// ---------------------------------------------------------------- 扫描工具

function walkFiles(dir: string, test: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, test, out);
    else if (test(e)) out.push(full);
  }
  return out;
}

/** 代码围栏内的内容不是"仓库现状声明"，剔除后再抽引用。 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
}

function baseOf(p: string): string {
  const seg = p.split('/').pop() ?? p;
  return seg;
}

function lineList(a: string, b?: string): number[] {
  return b ? [Number(a), Number(b)] : [Number(a)];
}

// ---------------------------------------------------------------- 引用抽取

// 带行号：src/tools 前缀路径（阻塞级）
const RE_PREFIXED_LINE =
  /((?:src|tools)\/[A-Za-z0-9_\-./]+\.(?:tsx|ts|mjs|js)):(\d+)(?:-(\d+))?/g;
// 不带行号：src/tools 前缀路径（信息级）
const RE_PREFIXED_PATH =
  /((?:src|tools)\/[A-Za-z0-9_\-./]+\.(?:tsx|ts|mjs|js))(?![A-Za-z0-9_.:])/g;
// 带行号：裸 basename 或相对路径（阻塞级；允许 .test.ts 这类多点 basename）
const RE_LINE_REF =
  /(?<![A-Za-z0-9_\-./])((?:[A-Za-z0-9_\-]+\/)*[A-Za-z0-9_\-.]+\.(?:tsx|ts|mjs|js)):(\d+)(?:-(\d+))?/g;
// 不带行号：已知产物路径（20261114 A 段：gitignored 产物计数面——logs/、src-tauri/{host,inject}/ 等
// 不以 src|tools 起头、RE_PREFIXED_PATH 不认；无行号 ⇒ 不进 B 段 fail 面，只计数可见）
const RE_ARTIFACT_PATH =
  /(?<![A-Za-z0-9_\-./])((?:src-tauri\/(?:host|inject|target)|logs)\/[A-Za-z0-9_\-./]+\.(?:tsx|ts|mjs|js))(?![A-Za-z0-9_.:])/g;

/** 上游仓路径约定前缀（20261114 PM 裁定）：`<upstream-repo>/src/...` 指上游 deepseek-pp
 * 仓的文件（四枚占位符纪律，真实先例＝docs/验收/20261106-硬化卡 L192），不指本仓——
 * 解析器按本仓根解析必然失败，不学习此前缀会把上游引用误判成死锚。
 * 实测：RE_PREFIXED_LINE 无左锚定，`<upstream-repo>/src/...` 的内层 `src/...` 会被
 * 直接抠出判死锚（硬化卡 L192 即真实案例），故在抽取层按前缀精确跳过。
 * 跳过是精确的：同一路径**不带**该前缀仍照旧判死锚（契约测试锁双面）。
 */
const UPSTREAM_PREFIX = '<upstream-repo>/';

/**
 * 已知构建产物路径前缀（20261114 B 段，PM 裁定）：文档引用产物**带行号**＝一律 fail，
 * **与存在性无关**——产物行号随每次构建漂移，且本机/CI 存在性差异会让「能否解析」式判据
 * 只在一侧咬（本机绿 CI 红的反向变体：CI 上产物不存在→走豁免→永不红）。
 * 目前仓库的产物落点：宿主 bundle、注入 bundle、取证目录。
 */
const ARTIFACT_PATH_PREFIXES = ['src-tauri/host/', 'src-tauri/inject/', 'src-tauri/target/', 'logs/'];

/** 引用路径是否落在已知产物集合内（裸 basename 由解析候选判定，见 checkDocDrift 主循环）。 */
export function isArtifactPath(path: string): boolean {
  return ARTIFACT_PATH_PREFIXES.some((p) => path === p || path.startsWith(p));
}

function isUpstreamRef(text: string, offset: number): boolean {
  return offset >= UPSTREAM_PREFIX.length && text.slice(offset - UPSTREAM_PREFIX.length, offset) === UPSTREAM_PREFIX;
}

function extractRefs(mdText: string, docRel: string): Ref[] {
  const refs: Ref[] = [];
  let t = stripFences(mdText);

  t = t.replace(RE_PREFIXED_LINE, (m, p: string, a: string, b?: string, offset?: number) => {
    if (offset !== undefined && isUpstreamRef(t, offset)) return ' '.repeat(m.length);
    refs.push({ raw: m, path: p, base: baseOf(p), lines: lineList(a, b), docFile: docRel, blocking: true });
    return ' '.repeat(m.length);
  });
  t = t.replace(RE_PREFIXED_PATH, (m, p: string, offset?: number) => {
    if (offset !== undefined && isUpstreamRef(t, offset)) return ' '.repeat(m.length);
    refs.push({ raw: m, path: p, base: baseOf(p), lines: [], docFile: docRel, blocking: false });
    return ' '.repeat(m.length);
  });
  for (const m of t.matchAll(RE_LINE_REF)) {
    const base = baseOf(m[1]);
    if (!CODE_EXT.test(base)) continue; // 排除 .json 等被 `.js` 前缀误捕的尾巴
    // 相对路径引用（如 `gate/run.ts:89`）保留完整 path，供路径后缀解析；
    // 只丢给 basename 会撞名（20261031 实测 gate/run.ts 被错解析成 tools/bench/run.ts）。
    refs.push({ raw: m[0], path: m[1], base, lines: lineList(m[2], m[3]), docFile: docRel, blocking: true });
  }
  for (const m of t.matchAll(RE_ARTIFACT_PATH)) {
    refs.push({ raw: m[0], path: m[1], base: baseOf(m[1]), lines: [], docFile: docRel, blocking: false });
  }
  return refs;
}

// ---------------------------------------------------------------- 解析与校验

function buildBasenameIndex(root: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const r of INDEX_ROOTS) {
    const abs = join(root, r);
    if (!existsSync(abs)) continue;
    for (const f of walkFiles(abs, (n) => CODE_EXT.test(n))) {
      const base = f.split(/[\\/]/).pop() as string;
      const rel = relative(root, f).split('\\').join('/');
      const list = idx.get(base);
      if (list) list.push(rel);
      else idx.set(base, [rel]);
    }
  }
  return idx;
}

/**
 * 解析引用 → 候选文件列表（仓库相对路径）。
 * 链路：精确路径 → 路径后缀（`gate/run.ts` → `tools/gate/run.ts`）→
 * basename 精确 → basename 后缀（`sse-frame-decoder.ts` → `deepseek-sse-frame-decoder.ts`）。
 * 同名多候选全保留：行号校验"任一候选满足即可"，避免 `run.ts` 这类撞名误报。
 */
function resolveCandidates(ref: Ref, root: string, idx: Map<string, string[]>): string[] {
  if (ref.path !== null) {
    if (existsSync(join(root, ref.path))) return [ref.path];
    const suffix = '/' + ref.path;
    const hits = new Set<string>();
    for (const rels of idx.values()) {
      for (const rel of rels) {
        if (rel === ref.path || rel.endsWith(suffix)) hits.add(rel);
      }
    }
    if (hits.size > 0) return [...hits];
  }
  const exact = idx.get(ref.base);
  if (exact && exact.length > 0) return [...exact];
  for (const [base, rels] of idx) {
    if (base !== ref.base && base.endsWith(ref.base)) return [...rels];
  }
  return [];
}

export interface DocDriftScan {
  dir: string;
  exists: boolean;
  files: number;
}

/** 判定一条 issue 是否＝「引用 gitignored 产物」（20261114 A 段：两树 warn 数换算行）。 */
export function isGitignoredArtifactWarn(i: DocDriftIssue): boolean {
  return i.severity === 'warn' && i.detail.startsWith('本机独有产物引用');
}

/** 判定一条 issue 是否＝「入库构建产物引用」（git 跟踪产物，两树都可见——不是两树差）。 */
export function isTrackedArtifactWarn(i: DocDriftIssue): boolean {
  return i.severity === 'warn' && i.detail.startsWith('入库构建产物引用');
}

export function checkDocDrift(
  root: string,
  docDirs: readonly string[] = DOC_DIRS,
  designDirs: readonly string[] = DESIGN_DIRS,
): { issues: DocDriftIssue[]; scanned: DocDriftScan[]; refCount: number; designPending: DocDriftIssue[] } {
  const idx = buildBasenameIndex(root);
  const issues: DocDriftIssue[] = [];
  const designPending: DocDriftIssue[] = [];
  const scanned: DocDriftScan[] = [];
  const lineCountCache = new Map<string, number>();
  const artifactTrackedCache = new Map<string, boolean>();
  let refCount = 0;

  // 设计目录判定：目录级（整棵 设计稿/ 树都是设计时命名语义）。
  const designAbs = new Set(designDirs.map((d) => resolve(isAbsolute(d) ? d : join(root, d))));

  for (const dir of docDirs) {
    const abs = isAbsolute(dir) ? dir : join(root, dir);
    const isDesignDir = designAbs.has(resolve(abs));
    const exists = existsSync(abs);
    const mds = exists ? walkFiles(abs, (n) => n.endsWith('.md')) : [];
    scanned.push({ dir, exists, files: mds.length });

    for (const md of mds) {
      const docRel = relative(root, md).split('\\').join('/');
      const refs = extractRefs(readFileSync(md, 'utf8'), docRel);
      refCount += refs.length;

      for (const ref of refs) {
        if (!ref.blocking) {
          // 信息级：src/、tools/ 前缀路径按字面路径判断存在性；产物路径（logs/、src-tauri/{host,inject}/）
          // 走 20261114 A 段计数面（见下）。
          if (ref.path !== null && isArtifactPath(ref.path)) {
            // A 段计数：产物路径引用（无行号——带 :N 的在 blocking 面被 B 段 fail）。
            // **分类问 git ls-files（PM 20261114 定，修正版）**：路径形态不等于两树差——
            // `src-tauri/inject/entry.js` 是**跟踪文件**（干净 checkout 天然存在，两树都可见），
            // 只有 **未跟踪/gitignored 的产物**（host bundle、target/debug、logs/）才是「本机独有」。
            //   本机独有（干净树不可见）＝本机 N → 预期 CI warn 增量；入库产物引用＝两树都可见、行号照旧禁。
            //   判据＝`git ls-files --error-unmatch`（tracked ⇒ 非本机独有）；0 枚也印行。
            let tracked = artifactTrackedCache.get(ref.path);
            if (tracked === undefined) {
              try {
                execSync(`git ls-files --error-unmatch -- "${ref.path}"`, { cwd: root, stdio: 'ignore' });
                tracked = true;
              } catch {
                tracked = false;
              }
              artifactTrackedCache.set(ref.path, tracked);
            }
            if (tracked) {
              issues.push({
                severity: 'warn',
                ref: ref.raw,
                docFile: docRel,
                detail: '入库构建产物引用（git 跟踪、两树都可见；行号照旧禁——见 B 段判据）',
              });
            } else if (existsSync(join(root, ref.path))) {
              issues.push({
                severity: 'warn',
                ref: ref.raw,
                docFile: docRel,
                detail: '本机独有产物引用（gitignored/未跟踪、干净树不可见）——干净树上此引用走豁免分支，两树 warn 数按此换算',
              });
            } else {
              issues.push({
                severity: 'warn',
                ref: ref.raw,
                docFile: docRel,
                detail: '指向 gitignore 目录或未跟踪文件（本机取证产物），CI 环境没有——豁免可解析性检查',
              });
            }
            continue;
          }
          if (ref.path !== null && !existsSync(join(root, ref.path))) {
            const issue: DocDriftIssue = {
              severity: 'warn',
              ref: ref.raw,
              docFile: docRel,
              detail: '路径不存在——设计稿引用规划中/已裁撤模块，文档侧待办（不阻塞）',
            };
            if (isDesignDir) {
              // 20261114 目录语义分流：设计稿的「路径不存在」单列待落点计数（可见不静默），
              // 不混进漂移数；实证目录（验收报告/harness）照旧进 issues。
              designPending.push({
                ...issue,
                detail: '设计稿待落点：路径不存在（设计稿先起名、实现换了落点；豁免漂移计数，不静默）',
              });
            } else {
              issues.push(issue);
            }
          }
          continue;
        }

        // 20261114 B 段（PM 裁定，阻塞级）：引用路径落在已知产物集合且带行号 ⇒ 一律 fail，
        // **与存在性无关**（存在性判据在 CI 上永不咬——产物不存在走豁免，本机绿 CI 红的反向变体）。
        // 产物行号随每次构建漂移；文档引产物必须去行号＋描述性引用（存量已清，见硬化卡/UI-R4 两注记）。
        if (ref.path !== null && ref.lines.length > 0 && isArtifactPath(ref.path)) {
          issues.push({
            severity: 'fail',
            ref: ref.raw,
            docFile: docRel,
            detail: '文档引用构建产物行号（产物随每次构建漂移，行号不作定位锚）——去行号改描述性引用，原行号留痕注记',
          });
          continue;
        }

        const cands = resolveCandidates(ref, root, idx);
        if (cands.length === 0) {
          // 豁免判定（20261105 CI 对齐）：目标落在 gitignore 目录或未跟踪 → 不挡 CI
          if (isIgnoredOrUntracked(root, ref.path ?? ref.raw)) {
            issues.push({
              severity: 'warn',
              ref: ref.raw,
              docFile: docRel,
              detail: '指向 gitignore 目录或未跟踪文件（本机取证产物），CI 环境没有——豁免可解析性检查',
            });
            continue;
          }
          issues.push({
            severity: 'fail',
            ref: ref.raw,
            docFile: docRel,
            detail: '引用的文件在 src/tools/src-tauri/scripts/tests 下解析不到（精确与后缀匹配均失败）',
          });
          continue;
        }

        // 行号越界校验：撞名多候选时"任一候选满足即可"
        let maxLines = 0;
        for (const cand of cands) {
          const full = join(root, cand);
          let n = lineCountCache.get(full);
          if (n === undefined) {
            n = readFileSync(full, 'utf8').split('\n').length;
            lineCountCache.set(full, n);
          }
          if (n > maxLines) maxLines = n;
        }
        for (const ln of ref.lines) {
          if (ln > maxLines) {
            issues.push({
              severity: 'fail',
              ref: ref.raw,
              docFile: docRel,
              detail: `引用第 ${ln} 行，但候选 [${cands.join(', ')}] 最多只有 ${maxLines} 行（代码已改动、文档未跟）`,
            });
          }
        }
      }
    }
  }
  return { issues, scanned, refCount, designPending };
}

// ---------------------------------------------------------------- 入口

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { issues, scanned, refCount, designPending } = checkDocDrift(root);

  const scanLine = scanned
    .map((s) => `${s.dir}(${s.exists ? `${s.files} md` : '不存在，跳过'})`)
    .join(', ');
  const fails = issues.filter((i) => i.severity === 'fail');
  const warns = issues.filter((i) => i.severity === 'warn');

  console.log('=== 文档↔代码漂移审计（20261031 重写版）===');
  console.log(`扫描: ${scanLine} | 引用共 ${refCount} 处`);

  // 20261114 目录语义分流：设计稿「路径不存在」豁免漂移计数，但必须可见（不许静默 0）。
  console.log(`\n📋 设计稿待落点（豁免漂移计数，可见）: ${designPending.length} 处`);
  for (const p of designPending) console.log(`  ${p.ref}  (${p.docFile})`);

  // 20261114 A 段（修正版，PM 裁定）：分类问 git ls-files，不问路径形态——
  //   本机独有（gitignored/未跟踪产物）＝本机 N → 预期 CI warn 增量（干净树上走豁免分支）；
  //   入库构建产物引用（git 跟踪，如 src-tauri/inject/entry.js）＝两树都可见、不是两树差，行号照旧禁（B 段判据）。
  // 判据谓词见 isGitignoredArtifactWarn / isTrackedArtifactWarn；清单默认上限 15 行＋--verbose 全列
  // （可见性靠计数行，逐条清单是排查工具——同 designPending 逻辑，20261114 PM 裁定）。
  const verbose = process.argv.includes('--verbose');
  const localOnly = issues.filter(isGitignoredArtifactWarn);
  const trackedArtifact = issues.filter(isTrackedArtifactWarn);
  console.log(`\n📎 本机独有（干净树不可见）: ${localOnly.length} 枚＝本机 N → 预期 CI warn 增量`);
  for (const g of localOnly.slice(0, verbose ? undefined : 15)) console.log(`  ${g.ref}  (${g.docFile})`);
  if (!verbose && localOnly.length > 15) console.log(`  …其余 ${localOnly.length - 15} 枚用 --verbose 全列`);
  console.log(`🗄 入库构建产物引用（两树都可见，行号照旧禁）: ${trackedArtifact.length} 枚`);

  if (warns.length > 0) {
    console.log(`\n⚠️ 信息级（不阻塞）${warns.length} 处：`);
    for (const w of warns.slice(0, verbose ? undefined : 15)) console.log(`  ${w.ref}  (${w.docFile})`);
    if (!verbose && warns.length > 15) console.log(`  …其余 ${warns.length - 15} 枚用 --verbose 全列`);
  }
  if (fails.length > 0) {
    console.error(`\n❌ 阻塞级漂移 ${fails.length} 处：`);
    for (const f of fails) console.error(`  ${f.ref}  (${f.docFile})\n    ${f.detail}`);
    process.exit(1);
  }
  console.log('\n✅ 文档引用校验通过');
  process.exit(0);
}

if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('doc-drift.ts')) main();
