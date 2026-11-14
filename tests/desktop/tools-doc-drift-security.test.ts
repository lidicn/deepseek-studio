/** S20/S21 审计测试。doc-drift 部分随 20261031 重写同步改版（PM 授权的 tests/desktop 例外）。 */
import { describe, it, expect } from 'vitest';
import { checkDocDrift, DOC_DIRS, isArtifactPath, isGitignoredArtifactWarn, isTrackedArtifactWarn } from '../../tools/audit/doc-drift';
import { checkFile } from '../../tools/audit/security';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 建一个仓库外临时"文档目录"，跑完即删，不落仓库文件。 */
function withTempDocs(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'docdrift-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8');
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('doc-drift（20261031 重写版契约：文档↔代码引用校验）', () => {
  it('1. 真实仓库：设计稿/验收报告的引用零阻塞级漂移', () => {
    const { issues } = checkDocDrift(root);
    const fails = issues.filter((i) => i.severity === 'fail');
    expect(fails).toEqual([]);
  });
  it('2. 合成注入：不存在的 file:line 引用会被抓出（fail）', () => {
    withTempDocs({ 'a.md': '见 src/no-such-file-xyz.ts:12\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(
        issues.some((i) => i.severity === 'fail' && i.ref.includes('src/no-such-file-xyz.ts')),
      ).toBe(true);
    });
  });
  it('3. 合成注入：行号越界会被抓出（fail）', () => {
    // vitest.config.ts 在仓库根一定存在，99999 行必然越界
    withTempDocs({ 'b.md': '见 vitest.config.ts:99999\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(
        issues.some((i) => i.severity === 'fail' && i.ref.includes('vitest.config.ts:99999')),
      ).toBe(true);
    });
  });
  it('4. 规划中模块（不带行号的 src/ 路径）只警告不阻塞', () => {
    withTempDocs({ 'c.md': '规划新建 src/capabilities/not-built-yet.ts\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(
        issues.some((i) => i.severity === 'warn' && i.ref.includes('src/capabilities/not-built-yet.ts')),
      ).toBe(true);
      expect(issues.some((i) => i.severity === 'fail')).toBe(false);
    });
  });
  it('5. 代码围栏内的示例路径不算引用', () => {
    withTempDocs({ 'd.md': '```\nsrc/also/not-here.ts:1\n```\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(issues.some((i) => i.ref.includes('src/also/not-here.ts'))).toBe(false);
    });
  });

  // ── 20261105 CI 环境对齐：gitignore 目录/未跟踪文件的豁免（PM 裁定）──────────────
  it('6. 引用指向 gitignore 目录内不存在的文件（不带行号）→ 豁免（warn，不 fail）', () => {
    // logs/ 是 gitignore 目录（.gitignore 末段），CI 环境天然没有。
    // 20261114 B 段后带行号形态已升阻塞（用例 18）——豁免语义只对无行号引用成立，fixture 随之收窄。
    withTempDocs({ 'g.md': '见 logs/verify-exit/nonexistent-evidence.mjs（取证脚本，无行号）\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      const fail = issues.find((i) => i.severity === 'fail' && i.ref.includes('nonexistent-evidence.mjs'));
      expect(fail).toBeUndefined();
      expect(issues.some((i) => i.severity === 'warn' && i.ref.includes('nonexistent-evidence.mjs'))).toBe(true);
    });
  });

  it('7. 引用指向 gitignore 目录内真实存在的文件 → 行号校验仍跑（不豁免行号越界）', () => {
    // 不依赖本机任何取证文件真实存在——在 logs/ 下临时造一个两行 .mjs，
    // 引用它的第 99999 行（越界）→ 豁免只管「可解析性」，行号越界仍 fail。
    // logs/ 已 gitignore，造文件不污染仓；CI 上 logs/ 不存在时 mkdirSync recursive 兜底。
    const evidenceDir = join(root, 'logs', 'verify-exit');
    const evidenceFile = join(evidenceDir, 'drift-test-fixture.mjs');
    const existed = existsSync(evidenceFile);
    try {
      mkdirSync(evidenceDir, { recursive: true });
      if (!existed) writeFileSync(evidenceFile, '// line 1\n// line 2\n', 'utf8');
      withTempDocs({ 'h.md': '见 logs/verify-exit/drift-test-fixture.mjs:99999\n' }, (dir) => {
        const { issues } = checkDocDrift(root, [dir]);
        expect(
          issues.some((i) => i.severity === 'fail' && i.ref.includes('drift-test-fixture.mjs:99999')),
        ).toBe(true);
      });
    } finally {
      if (!existed) rmSync(evidenceFile, { force: true });
    }
  });

  it('8. 引用指向非 gitignore 且不存在的文件 → 仍 fail（真漂移不豁免）', () => {
    withTempDocs({ 'i.md': '见 tools/audit/ghost-file-that-never-existed.mjs:1\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(
        issues.some((i) => i.severity === 'fail' && i.ref.includes('ghost-file-that-never-existed.mjs')),
      ).toBe(true);
    });
  });
});

// ── 20261114 目录语义分流（PM 派卡）：设计稿「路径不存在」单列待落点，不混进漂移数 ──
describe('doc-drift 设计稿待落点分流（20261114）', () => {
  it('9. 真实仓库：设计稿的路径不存在全进 designPending，issues 里不再混入', () => {
    const { issues, designPending } = checkDocDrift(root);
    expect(designPending.length).toBeGreaterThanOrEqual(41);
    expect(designPending.every((p) => p.docFile.startsWith('docs/设计稿/'))).toBe(true);
    expect(
      issues.some((i) => i.severity === 'warn' && i.docFile.startsWith('docs/设计稿/') && i.detail.startsWith('路径不存在')),
    ).toBe(false);
  });

  it('10. 合成：设计目录内的规划路径 → designPending；实证目录内同类 → issues 照旧报', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'docdrift-evidence-'));
    const dirB = mkdtempSync(join(tmpdir(), 'docdrift-design-'));
    try {
      writeFileSync(join(dirA, 'a.md'), '规划新建 src/capabilities/not-built-evidence.ts\n', 'utf8');
      writeFileSync(join(dirB, 'b.md'), '规划新建 src/capabilities/not-built-design.ts\n', 'utf8');
      const { issues, designPending } = checkDocDrift(root, [dirA, dirB], [dirB]);
      expect(issues.some((i) => i.severity === 'warn' && i.ref.includes('not-built-evidence.ts'))).toBe(true);
      expect(issues.some((i) => i.ref.includes('not-built-design.ts'))).toBe(false);
      expect(designPending.some((p) => p.ref.includes('not-built-design.ts'))).toBe(true);
      expect(designPending.some((p) => p.ref.includes('not-built-evidence.ts'))).toBe(false);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('11. 设计目录内行号越界仍 fail（豁免不放松实证：文件在、行不对＝真漂移）', () => {
    withTempDocs({ 'j.md': '见 vitest.config.ts:99999\n' }, (dir) => {
      const { issues, designPending } = checkDocDrift(root, [dir], [dir]);
      expect(issues.some((i) => i.severity === 'fail' && i.ref.includes('vitest.config.ts:99999'))).toBe(true);
      expect(designPending).toHaveLength(0);
    });
  });
});

// ── 20261114 覆盖集补缺口（docs/验收）＋上游仓前缀约定（PM 裁定）─────────────────
describe('doc-drift 覆盖集与上游前缀（20261114）', () => {
  it('12. 覆盖集契约：默认 DOC_DIRS 含 docs/验收（实证目录，此前 33 枚 md 在射程外）', () => {
    expect(DOC_DIRS).toContain('docs/验收');
    expect(DOC_DIRS).toContain('docs/验收报告');
    expect(DOC_DIRS).toContain('docs/harness');
    expect(DOC_DIRS).toContain('docs/设计稿');
  });

  it('13. `<upstream-repo>/src/...:N` 上游引用不入本仓射程（不产生 fail）', () => {
    withTempDocs({ 'u.md': '见 <upstream-repo>/src/core/usage/stats.ts:140\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(issues.filter((i) => i.severity === 'fail')).toHaveLength(0);
    });
  });

  it('14. 同路径去掉上游前缀 → 照旧 fail（前缀豁免是精确的，不是路径白名单）', () => {
    withTempDocs({ 'u2.md': '见 src/core/usage/stats.ts:140\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(issues.some((i) => i.severity === 'fail' && i.ref.includes('src/core/usage/stats.ts'))).toBe(true);
    });
  });
});

// ── 20261114 A 段：gitignored 产物引用计数（两树 warn 数换算）─────────────────────
describe('doc-drift gitignored 产物计数（20261114 A 段）', () => {
  it('15. 引用 logs/ 下实存文件（不带行号）→ 计入「本机独有」计数（warn）', () => {
    // logs/ 已 gitignore；**不带行号**——带 :N 的产物引用已被 B 段升阻塞（用例 18），两段互斥。
    // 分类问 git ls-files（20261114 PM 修正裁定）：logs/ 未跟踪 ⇒ 本机独有（干净树不可见）。
    const evidenceDir = join(root, 'logs', 'verify-f1f2');
    const evidenceFile = join(evidenceDir, 'drift-artifact-count-fixture.mjs');
    const existed = existsSync(evidenceFile);
    try {
      mkdirSync(evidenceDir, { recursive: true });
      if (!existed) writeFileSync(evidenceFile, '// line 1\n// line 2\n', 'utf8');
      withTempDocs({ 'k.md': '见 logs/verify-f1f2/drift-artifact-count-fixture.mjs（取证脚本）\n' }, (dir) => {
        const { issues } = checkDocDrift(root, [dir]);
        const counted = issues.find(
          (i) => isGitignoredArtifactWarn(i) && i.ref.includes('drift-artifact-count-fixture.mjs'),
        );
        expect(counted, 'gitignored 产物引用必须计入「本机独有」（warn）').toBeDefined();
      });
    } finally {
      if (!existed) rmSync(evidenceFile, { force: true });
    }
  });

  it('15b. 引用 git 跟踪产物（src-tauri/inject/entry.js，不带行号）→ 入库产物类、不计入本机独有', () => {
    // entry.js 是 git 跟踪文件（20261114 PM 实测：ls-files 命中）——两树都可见，不是两树差。
    // 旧版按路径形态把它误计入 N（58 枚虚高 56% 即此因）；分类必须问 ls-files。
    withTempDocs({ 'k2.md': '见 src-tauri/inject/entry.js（注入 bundle，git 跟踪）\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(issues.some((i) => isTrackedArtifactWarn(i) && i.ref.includes('entry.js'))).toBe(true);
      expect(issues.some((i) => isGitignoredArtifactWarn(i) && i.ref.includes('entry.js'))).toBe(false);
    });
  });

  it('16. 真实仓库：两类计数互斥且带行号引用不入任何计数面（B 段管 fail）', () => {
    // B 段阻塞级落地后，带行号的产物引用直接 fail、不进计数 ⇒ 存量清完后 N=0 是**合法稳态**；
    // 这枚锁的是「计数面无行号污染」＋两分类谓词互斥（tracked ≠ local-only）。
    const { issues } = checkDocDrift(root);
    const localOnly = issues.filter(isGitignoredArtifactWarn);
    const tracked = issues.filter(isTrackedArtifactWarn);
    expect(localOnly.every((i) => !i.ref.includes(':'))).toBe(true); // 带行号的产物引用不许出现在计数面（那是 fail）
    expect(tracked.every((i) => !i.ref.includes(':'))).toBe(true);
  });

  it('17. CI 语义锁：解析不到＋ignore 目标的引用不计入 N（干净树上 N 恒 0，计数是本机读数）', () => {
    // 引用 gitignore 目录内**不存在**的文件：CI（干净树）上产物不存在 ⇒ 走「解析不到→豁免」分支
    // ⇒ detail 是「指向 gitignore 目录或未跟踪文件」而**非**「引用 gitignored 产物」⇒ 不计入 N。
    // 本机上该文件也不存在 ⇒ 同样走豁免分支 ⇒ 也不计数——两侧一致地不计入，锁死换算方向语义。
    withTempDocs({ 'ci.md': '见 logs/verify-f1f2/never-existed-ci-semantics.mjs（取证脚本，无行号）\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(
        issues.some((i) => i.detail.startsWith('引用 gitignored 产物') && i.ref.includes('never-existed-ci-semantics')),
      ).toBe(false);
      expect(
        issues.some((i) => i.severity === 'warn' && i.detail.startsWith('指向 gitignore') && i.ref.includes('never-existed-ci-semantics')),
      ).toBe(true);
    });
  });
});

// ── 20261114 B 段：文档不得引产物行号（阻塞级，与存在性无关）─────────────────────
describe('doc-drift 产物行号规约（2026114 B 段，阻塞级）', () => {
  it('18. 引用不存在产物路径＋行号 → 仍 fail（判据与存在性无关——CI 侧也咬，负控锁死）', () => {
    // src-tauri/host/** 在干净 checkout 天然不存在；「能否解析」式判据在 CI 永不咬。
    // 本判据按路径前缀判，fixture 故意用**不存在**的产物路径——本机红＝CI 也红。
    withTempDocs({ 'p.md': '见 src-tauri/host/main.mjs:18950\n' }, (dir) => {
      const { issues } = checkDocDrift(root, [dir]);
      expect(
        issues.some((i) => i.severity === 'fail' && i.ref.includes('main.mjs:18950') && i.detail.includes('产物行号')),
      ).toBe(true);
    });
  });

  it('19. isArtifactPath 前缀面：产物集合内 true、源码路径 false', () => {
    expect(isArtifactPath('src-tauri/host/main.mjs')).toBe(true);
    expect(isArtifactPath('src-tauri/inject/entry.js')).toBe(true);
    expect(isArtifactPath('logs/verify-f1f2/prewarm-e2e-verify.mjs')).toBe(true);
    expect(isArtifactPath('src/host/memory-store.ts')).toBe(false);
    expect(isArtifactPath('tools/audit/doc-drift.ts')).toBe(false);
  });
});

describe('S21 security', () => {
  it('3. eval() 被抓出', () => {
    const v = checkFile(join(root, 'src/x.ts'), 'eval(userInput);', root);
    expect(v.some((i) => i.pattern === 'eval()')).toBe(true);
  });
  it('4. innerHTML 赋值被抓出', () => {
    const v = checkFile(join(root, 'src/x.ts'), 'el.innerHTML = "<p>hi</p>";', root);
    expect(v.some((i) => i.pattern === 'innerHTML 赋值')).toBe(true);
  });
  it('5. tests/ 白名单跳过', () => {
    const v = checkFile(join(root, 'tests/x.ts'), 'eval("test");', root);
    expect(v.length).toBe(0);
  });
  it('6. 注释行跳过', () => {
    const v = checkFile(join(root, 'src/x.ts'), '// eval example', root);
    expect(v.length).toBe(0);
  });
  it('7. 未消毒的动态 innerHTML 是阻断项', () => {
    const v = checkFile(join(root, 'src/x.ts'), 'el.innerHTML = `<p>${userInput}</p>`;', root);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });
  it('8. escapeHtml 包装的动态 innerHTML 是提示项', () => {
    const v = checkFile(join(root, 'src/x.ts'), 'el.innerHTML = `<p>${escapeHtml(userInput)}</p>`;', root);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });
  it('9. security-ok 可把人工确认项降为提示', () => {
    const content = '// security-ok: 测试调试端点已默认关闭\nconst result = eval(code);';
    const v = checkFile(join(root, 'src/x.ts'), content, root);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
  });
});
