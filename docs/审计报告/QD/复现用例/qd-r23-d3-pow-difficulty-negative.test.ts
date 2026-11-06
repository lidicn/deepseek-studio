// QD-R23-D3（健壮性缺口负控）：PoW difficulty 来自服务端响应（Number(challenge.difficulty)），
// 无上限/时间预算，原样喂给同步 WASM solve（页端主线程）。服务端异常或中间人放大
// difficulty → DeepSeek 标签页主线程长时间冻结（页级 DoS 面）。
// 负控：静态断言 pow.ts 存在 difficulty 封顶/预算表达。修复前红。
// 修复建议：const d = Math.min(Number(challenge.difficulty) || 0, MAX_POW_DIFFICULTY)
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('QD-R23-D3 PoW difficulty 无上限 负控', () => {
  it('pow.ts 应存在 difficulty 封顶/预算（当前无 → 红）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../src/inject/pow.ts'), 'utf8');
    const hasCap =
      /Math\.min\(\s*(?:Number\()?(?:challenge\.)?difficulty/i.test(src) ||
      /MAX_?POW_?DIFFICULT|POW_?DIFF_?MAX/i.test(src);
    expect(hasCap, 'pow.ts 未见 difficulty 封顶/预算：服务端可放大难度冻结页端主线程').toBe(true);
  });
});