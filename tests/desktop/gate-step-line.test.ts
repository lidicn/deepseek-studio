import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stepLine } from '../../tools/gate/step-line';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/**
 * 0.14.11 卡 C 守卫：progress 行同源产出。
 *
 * 判据打在产出面上（用户口径「同一解析式只对同一产出函数保证一致」）：
 * ① round-trip——stepLine 产一行、步头正则解回名字；
 * ② 源码里旧式手写模板 `[PASS] ${…}` / `[FAIL] ${…}` 只许出现在 stepLine 函数内
 *    （经 stepLine 产出形态为 `[${name}] ${kind}`，字面 KIND 不在括号内 ⇒ 此正则 0 命中；
 *    谁再手写第二处 ⇒ 立刻红）。
 */
describe('gate step-line（0.14.11 卡 C：同源产出）', () => {
  it('round-trip: FAIL 行 → 步头正则解回名字', () => {
    const line = stepLine('FAIL', 'vitest', '741.0', '阻塞，闸终止');
    const m = /^\[([^\]]+)\] FAIL/.exec(line);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('vitest');
  });

  it('round-trip: PASS 行不被 FAIL 正则误命中', () => {
    const line = stepLine('PASS', 'typecheck', '30.8', '');
    expect(/^\[([^\]]+)\] FAIL/.test(line)).toBe(false);
  });

  it('round-trip: 无 tail 时形态为 [name] KIND  secs', () => {
    const line = stepLine('PASS', 'typecheck', '30.8', '');
    expect(line).toBe('[typecheck] PASS  30.8s');
  });

  it('源码无手写 [PASS]/[FAIL] 模板（只许经 stepLine）', () => {
    const runSrc = readFileSync(resolve(root, 'tools', 'gate', 'run.ts'), 'utf8');
    const stepSrc = readFileSync(resolve(root, 'tools', 'gate', 'step-line.ts'), 'utf8');
    const re = /\[(PASS|FAIL)\]\s*\$\{/g;
    expect([...runSrc.matchAll(re)]).toHaveLength(0);
    expect([...stepSrc.matchAll(re)]).toHaveLength(0);
  });
});
