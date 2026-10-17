/**
 * S7 符号清零审计测试。
 */

import { describe, it, expect } from 'vitest';
import { checkFile } from '../../tools/audit/symbols';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

describe('S7 符号清零审计', () => {
  it('1. MAX_NUDGES 出现 → 被抓出', () => {
    const f = join(root, 'src/fake.ts');
    const v = checkFile(f, 'const x = MAX_NUDGES;', root);
    expect(v.some((r) => r.symbol === 'MAX_NUDGES')).toBe(true);
  });

  it('2. stripRawToolTags 出现 → 被抓出', () => {
    const f = join(root, 'src/fake.ts');
    const v = checkFile(f, 'stripRawToolTags(input);', root);
    expect(v.some((r) => r.symbol === 'stripRawToolTags')).toBe(true);
  });

  it('3. 注释里的符号 → 不抓出', () => {
    const f = join(root, 'src/fake.ts');
    const v = checkFile(f, '// MAX_NUDGES removed in M3\nconst x = 1;', root);
    expect(v.length).toBe(0);
  });

  it('4. shouldNudge 函数定义 → 不抓出', () => {
    const f = join(root, 'src/fake.ts');
    const v = checkFile(f, 'export function shouldNudge(t: string): boolean { return false; }', root);
    expect(v.filter((r) => r.symbol.startsWith('shouldNudge'))).toHaveLength(0);
  });

  it('5. shouldNudge 被调用 → 被抓出', () => {
    const f = join(root, 'src/fake.ts');
    const v = checkFile(f, 'if (shouldNudge(text)) { nudge(); }', root);
    expect(v.some((r) => r.symbol === 'shouldNudge(call)')).toBe(true);
  });

  it('6. MAX_LOOPS 出现 → 被抓出', () => {
    const f = join(root, 'src/fake.ts');
    const v = checkFile(f, 'for (let i = 0; i < MAX_LOOPS; i++) {}', root);
    expect(v.some((r) => r.symbol === 'MAX_LOOPS')).toBe(true);
  });
});
