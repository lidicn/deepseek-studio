#!/usr/bin/env tsx
/**
 * tools/audit/ui-display-truth.ts — UI 展示值真实性门禁（20261105 Gate）
 *
 * 背景：发行版设置面板曾写死 `v1.0.0` 假版本号、`E:\NAS\deepseek-studio\tauri-real.log`
 * （陈旧未入库文件）、`archive/legacy/`（发行版没有这个目录）——三行假数据被用户肉眼发现。
 * 本门禁在 gate 里静态扫 `src/ui/**` 与 `src/inject/**`（注释先剥），命中以下**精确字符串**
 * 即阻塞（精确而非形态，保证零误报）：
 *
 *   - `lidicn`              — 本机用户名，在 UI/inject 代码里永远不该出现
 *   - `E:\\NAS` / `E:/NAS`  — 开发机路径根
 *   - `C:\\Users` / `C:/Users` — 用户家目录路径（发行版用户不是 lidicn）
 *   - `tauri-real.log`      — 那个陈旧的假日志文件名
 *   - `archive/legacy`      — 仓库内部目录名，发行版不含
 *   - `v1.0.0`              — 写死的假版本号（构建期应注入真值）
 *
 * 合法文案放行：说明文字、placeholder 示例用中性路径（如 `/path/to/project`）不命中；
 * 注释含这些字符串不命中（stripComments 先剥，复用 tools/contract/check.ts 同款）。
 *
 * 用法：npx tsx tools/audit/ui-display-truth.ts
 * 退出码：0=干净  1=有命中
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { stripComments } from '../contract/check';

export interface TruthViolation {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

/** 禁止字符串清单（精确匹配，非正则形态——保证零误报）。 */
export const FORBIDDEN_PATTERNS: readonly string[] = [
  'lidicn',
  'E:\\NAS',     // 单反斜杠（模板字面量 / 运行时文本形态）
  'E:\\\\NAS',   // 双反斜杠（源码字符串字面量的转义形态）
  'E:/NAS',
  'C:\\Users',
  'C:\\\\Users',
  'C:/Users',
  'tauri-real.log',
  'archive/legacy',
  'v1.0.0',
];

/**
 * 结构判据（PM 20261105 补充①）：src/ui 里写死的默认项目条目——
 * `path:` 属性赋盘符绝对路径字面量的对象形态。真实项目来自运行时
 * （project.list / folder.pick→project.create），不该有未经运行时发现的默认值。
 * 精确字符串清单（E:\\NAS 等）抓当前案例，本条抓将来换路径的同类。
 */
export const RE_HARDCODED_PROJECT_ENTRY = /\bpath\s*:\s*['"`][A-Za-z]:[\\/][^'"`]*['"`]/;

const SCAN_EXT = /\.(?:tsx|ts|mjs|js)$/;
const SCAN_ROOTS = ['src/ui', 'src/inject'];

// ---------------------------------------------------------------- docs 信息级（不进 gate blocking）

/**
 * docs 信息级闸（M3-1 附属，20261105 PM 口径）：
 *   - **信息级**（不进 blocking），挂在 run.ts infoSteps；
 *   - **只报新增/改动的 docs 文件**——用 git watermark（上次扫描时的 HEAD hash）圈定范围，
 *     不全量扫历史 190 处审计记录（那是真实取证，不该当红灯噪声）；
 *   - 判据 = 四条替换口径（`<repo-root>` / `<upstream-repo>` / `<install-dir>` / `<user-profile>`）；
 *   - 豁免：`github.com/lidicn/…` 仓库地址（§19.7 保留项）、`docs/**` 里合法引用的
 *     `v1.0.0` / `archive/legacy`（版本史与仓库目录——docs 豁免，与 src 侧不同）。
 */
export function scanDocsForNewLeaks(root: string): { file: string; line: number; matched: string; suggestion: string }[] {
  const DOCS_SCAN_EXT = /\.(?:md|html|txt|cjs)$/;
  const watermarkPath = join(root, 'logs', 'docs-sanitize-watermark.txt');

  // 1) 读 watermark（上次扫描时的 HEAD hash）
  let lastHead = '';
  try {
    lastHead = readFileSync(watermarkPath, 'utf8').trim();
  } catch { /* 首次运行 */ }

  // 2) 圈定要扫的文件：HEAD 推进后的新增/改动 + 工作树在途改动
  //    全部用 `-z`（NUL 分隔）——不依赖 core.quotepath，中文路径不会被八进制转义（20261105 PM 负控实证）
  const changedFiles = new Set<string>();
  try {
    const ranges: string[] = [];
    if (lastHead) ranges.push(`${lastHead}..HEAD`);
    const gitOpts = { cwd: root, encoding: 'utf8' } as const;
    for (const range of ranges) {
      try {
        // 修正（20261105）：revision range 不放 `--` 后面（`--` 后面是 path），否则 git 当路径解析 → 空
        const out = execSync(`git diff -z --name-only --diff-filter=AM "${range}" -- docs/`, gitOpts);
        for (const f of out.split('\0').filter(Boolean)) changedFiles.add(f.trim());
      } catch { /* range 可能无效（如 watermark 指向不存在的 commit），忽略 */ }
    }
    // 工作树在途（未 commit 的改动 + 未跟踪新文件）
    try {
      const out = execSync('git diff -z --name-only --diff-filter=AM -- docs/', gitOpts);
      for (const f of out.split('\0').filter(Boolean)) changedFiles.add(f.trim());
      const out2 = execSync('git ls-files -z --others --exclude-standard -- docs/', gitOpts);
      for (const f of out2.split('\0').filter(Boolean)) changedFiles.add(f.trim());
    } catch { /* git 不可用时跳过 */ }
  } catch { /* git 异常不崩闸门 */ }

  if (changedFiles.size === 0) return [];

  // 3) 逐文件扫描
  const RULES: { re: RegExp; suggestion: string }[] = [
    { re: /E:[\\/]NAS[\\/]deepseek-studio/g, suggestion: '<repo-root>' },
    { re: /E:[\\/]NAS[\\/]deepseek-pp/g, suggestion: '<upstream-repo>' },
    { re: /E:[\\/]NAS[\\/]_probe_\w+/g, suggestion: '<install-dir>' },
    { re: /E:[\\/]NAS[\\/]_install_\w+/g, suggestion: '<install-dir>' },
    { re: /E:[\\/]NAS[\\/]_td04_\w+/g, suggestion: '<install-dir>' },
    { re: /C:[\\/]Users[\\/]lidicn/g, suggestion: '<user-profile>' },
  ];
  const out: { file: string; line: number; matched: string; suggestion: string }[] = [];
  for (const rel of [...changedFiles].sort()) {
    if (!DOCS_SCAN_EXT.test(rel)) continue;
    const abs = join(root, rel);
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // 豁免：github.com/lidicn/... 仓库地址（§19.7 保留项）
      const line = lines[i].replace(/github\.com\/lidicn\/[^\s）)]*/g, '');
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (m) {
          out.push({ file: rel, line: i + 1, matched: m[0], suggestion: rule.suggestion });
        }
      }
    }
  }

  // 4) 更新 watermark
  try {
    const head = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
    mkdirSync(dirname(watermarkPath), { recursive: true });
    writeFileSync(watermarkPath, head, 'utf8');
  } catch { /* git 不可用时跳过 */ }

  return out;
}

/** 扫描单个文件的代码（注释先剥）正文，返回命中列表。 */
export function checkFile(filePath: string, content: string, root: string): TruthViolation[] {
  const rel = relative(root, filePath).replace(/\\/g, '/');
  const stripped = stripComments(content);
  const lines = stripped.split('\n');
  const violations: TruthViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    for (const pat of FORBIDDEN_PATTERNS) {
      if (text.includes(pat)) {
        violations.push({ file: rel, line: i + 1, pattern: pat, text: text.trim().slice(0, 120) });
      }
    }
    // 结构判据：写死的默认项目条目（path 属性赋盘符路径字面量）
    if (RE_HARDCODED_PROJECT_ENTRY.test(text)) {
      violations.push({ file: rel, line: i + 1, pattern: 'hardcoded-project-entry', text: text.trim().slice(0, 120) });
    }
  }
  return violations;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(e)) out.push(full);
  }
  return out;
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  // --docs 模式：只扫 docs/ 的新增/改动文件（信息级，watermark 圈范围），不扫 src/ui+inject
  const argv = process.argv.slice(2);
  if (argv.includes('--docs')) {
    const findings = scanDocsForNewLeaks(root);
    if (findings.length > 0) {
      // stdout + stderr 双通道：stdout 进 gate 汇总（execSync 捕获），stderr 进 gate-info.log
      const detail = [
        '=== docs 脱敏信息级：新增/改动文件含本机路径 ===',
        ...findings.map((f) => `  ${f.file}:${f.line}  ${f.matched} → 建议替换为 ${f.suggestion}`),
        `共 ${findings.length} 处（信息级不阻塞，脱敏后重跑即消失）。`,
      ].join('\n');
      console.log(detail); // stdout → gate 汇总可见
      console.error(detail); // stderr → gate-info.log 留档
    } else {
      console.log('docs 脱敏信息级：通过（新增/改动 docs 文件零命中）');
    }
    process.exit(0); // 信息级：不管红绿都不阻塞 gate
  }

  const all: TruthViolation[] = [];
  for (const r of SCAN_ROOTS) {
    const abs = join(root, r);
    for (const f of walk(abs)) {
      all.push(...checkFile(f, readFileSync(f, 'utf8'), root));
    }
  }

  if (all.length > 0) {
    console.error('=== UI 展示值真实性门禁：命中禁止字符串 ===');
    for (const v of all) {
      console.error(`  [${v.pattern}] ${v.file}:${v.line}  ${v.text}`);
    }
    console.error(`共 ${all.length} 处命中。修法：取运行时真值 / 改中性路径 / 删行；注释里的已剥。`);
    process.exit(1);
  }
  console.log('UI 展示值真实性门禁：通过（src/ui + src/inject 零命中）');
  process.exit(0);
}

const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('ui-display-truth.ts');
if (isDirectRun) main();
