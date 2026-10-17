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
});
