/** S20/S21 审计测试。doc-drift 部分随 20261031 重写同步改版（PM 授权的 tests/desktop 例外）。 */
import { describe, it, expect } from 'vitest';
import { checkDocDrift } from '../../tools/audit/doc-drift';
import { checkFile } from '../../tools/audit/security';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
