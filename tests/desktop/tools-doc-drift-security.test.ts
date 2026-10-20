/** S20/S21 审计测试。 */
import { describe, it, expect } from 'vitest';
import { checkDrift } from '../../tools/audit/doc-drift';
import { checkFile } from '../../tools/audit/security';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('S20 doc-drift', () => {
  it('1. 真实仓库 ModelEngine 存在', () => {
    const issues = checkDrift(root);
    expect(issues.filter((i) => i.symbol === 'ModelEngine').length).toBe(0);
  });
  it('2. 文档期望的 4 个接口都在 src 中', () => {
    const issues = checkDrift(root);
    expect(issues.length).toBe(0);
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
