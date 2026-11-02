/** S12 M3 全仓符号清零测试。 */
import { describe, it, expect } from 'vitest';
import { checkFile } from '../../tools/audit/m3-clean';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('S12 m3-clean', () => {
  it('1. src 里出现 MAX_NUDGES → 被抓出', () => {
    const v = checkFile(join(root, 'src/x.ts'), 'const x = MAX_NUDGES;', root);
    expect(v.some((r) => r.symbol === 'MAX_NUDGES')).toBe(true);
  });

  it('2. tools/ 目录里的符号 → 白名单跳过', () => {
    const v = checkFile(join(root, 'tools/x.ts'), 'MAX_NUDGES', root);
    expect(v.length).toBe(0);
  });

  it('3. tests/ 目录 → 白名单跳过', () => {
    const v = checkFile(join(root, 'tests/x.ts'), 'stripRawToolTags', root);
    expect(v.length).toBe(0);
  });

  it('4. continuation-prompt import → 有意豁免，不抓出', () => {
    // 20261102 判据（Studio-PM 授权、豁免理由见 tools/audit/m3-clean.ts 头注）：
    // 该模块已演进为页端续跑协议的单一真相源，import 7/7 符号全有真实使用，
    // 「清零」目标对它不再适用——import 行应当返回空，而不是被抓出。
    const v = checkFile(join(root, 'src/x.ts'), "import { f } from '../shared/continuation-prompt';", root);
    expect(v.filter((r) => r.symbol === 'continuation-prompt')).toEqual([]);
  });

  it('5. 注释行 → 不抓出', () => {
    const v = checkFile(join(root, 'src/x.ts'), '// MAX_NUDGES removed', root);
    expect(v.length).toBe(0);
  });

  it('6. 防回潮负控：src 里出现已删的包装壳 stripRawToolTags → 必须被抓出', () => {
    // 豁免只针对 continuation-prompt；stripRawToolTags（stripRawToolText 的等价包装壳，
    // UI 已删）若被重新引入，审计必须立刻再红——这是护栏，不是凑数。
    const v = checkFile(join(root, 'src/x.ts'), 'export function stripRawToolTags(s: string) { return s; }', root);
    expect(v.some((r) => r.symbol === 'stripRawToolTags')).toBe(true);
  });

  it('7. 块注释行 /* … */ → 不抓出', () => {
    // 20261102 新增的 /* 跳过逻辑（原先只跳 // 与 *，顶置 JSDoc 提到符号会被误计）。
    // 这条盯着该行为：谁把它改回去，这里先红。
    const v = checkFile(join(root, 'src/x.ts'), '/* MAX_NUDGES */', root);
    expect(v.length).toBe(0);
  });
});
