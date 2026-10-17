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

  it('4. continuation-prompt import → 被抓出', () => {
    const v = checkFile(join(root, 'src/x.ts'), "import { f } from '../shared/continuation-prompt';", root);
    expect(v.some((r) => r.symbol === 'continuation-prompt')).toBe(true);
  });

  it('5. 注释行 → 不抓出', () => {
    const v = checkFile(join(root, 'src/x.ts'), '// MAX_NUDGES removed', root);
    expect(v.length).toBe(0);
  });
});
