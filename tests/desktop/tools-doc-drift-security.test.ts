/** S20/S21 审计测试。doc-drift 部分随 20261031 重写同步改版（PM 授权的 tests/desktop 例外）。 */
import { describe, it, expect } from 'vitest';
import { checkDocDrift, DOC_DIRS } from '../../tools/audit/doc-drift';
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
  it('6. 引用指向 gitignore 目录内不存在的文件 → 豁免（warn，不 fail）', () => {
    // logs/ 是 gitignore 目录（.gitignore 末段），CI 环境天然没有
    withTempDocs({ 'g.md': '见 logs/verify-exit/nonexistent-evidence.mjs:12\n' }, (dir) => {
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
