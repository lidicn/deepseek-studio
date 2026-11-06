/**
 * tests/desktop/jti-bounded.test.ts
 *
 * P0 卡 (A) 配套（PM 裁定三十三 3）：一次性 jti 记账必须有界。
 *
 * 为什么：批 N+1 之后发放口径从「一个窗口一张券」变成「一次连接一张券」，
 * 无界 `Set` 就是**单调增长**——本仓今天已经抓过四次「看着有上界、实际一直在涨」。
 *
 * 三条口径各自一条断言：过期清扫 / 1024 硬上界（按最旧 exp 淘汰）/ 触顶 `level=warn`。
 * **负控**：不是只断言「size ≤ 上限」，而是断言「过期项真的消失」「触顶真的打日志」。
 */
import { describe, it, expect } from 'vitest';
import { BoundedJtiSet, JTI_HARD_CAP } from '../../src/host/host-token';

function fixedClock(start = 1_000_000): { now: () => number; set: (v: number) => void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe('BoundedJtiSet：过期清扫', () => {
  it('过期项被清掉（不是只断言 size ≤ 上限）', () => {
    const clock = fixedClock();
    const set = new BoundedJtiSet(JTI_HARD_CAP, () => {}, clock.now);
    set.add('a', clock.now() + 1_000);
    set.add('b', clock.now() + 10_000);
    expect(set.size).toBe(2);

    clock.set(clock.now() + 2_000); // a 过期、b 未过期
    expect(set.has('a')).toBe(true); // 未清扫前仍在
    const removed = set.pruneExpired();
    expect(removed).toBe(1);
    expect(set.has('a')).toBe(false);
    expect(set.has('b')).toBe(true);
  });

  it('add 时顺带清扫（不需要外部调用 prune）', () => {
    const clock = fixedClock();
    const set = new BoundedJtiSet(JTI_HARD_CAP, () => {}, clock.now);
    set.add('old', clock.now() + 100);
    clock.set(clock.now() + 500);
    set.add('fresh', clock.now() + 10_000);
    expect(set.has('old')).toBe(false);
    expect(set.has('fresh')).toBe(true);
  });
});

describe('BoundedJtiSet：硬上界 + 触顶告警', () => {
  it('超过 cap 时按最旧 exp 淘汰，且 size 不超过 cap', () => {
    const clock = fixedClock();
    const logs: string[] = [];
    const set = new BoundedJtiSet(3, (l) => logs.push(l), clock.now);
    set.add('e1', clock.now() + 1_000);
    set.add('e2', clock.now() + 2_000);
    set.add('e3', clock.now() + 3_000);
    expect(set.size).toBe(3);
    set.add('e4', clock.now() + 4_000); // 触发淘汰
    expect(set.size).toBeLessThanOrEqual(3);
    expect(set.has('e1'), '最旧 exp 应被淘汰').toBe(false);
    expect(set.has('e4')).toBe(true);
    // 触顶必须打一行 level=warn（负控：静默淘汰要判红）
    expect(logs.join('\n')).toContain('level=warn');
    expect(logs.join('\n')).toContain('jti-cap-reached');
  });

  it('只告警一次（不刷屏）', () => {
    const clock = fixedClock();
    const logs: string[] = [];
    const set = new BoundedJtiSet(2, (l) => logs.push(l), clock.now);
    for (let i = 0; i < 10; i++) set.add(`k${i}`, clock.now() + 1000 + i);
    expect(logs.length).toBe(1);
  });
});

describe('BoundedJtiSet：默认上限常量化', () => {
  it('默认 cap = 1024，且大量写入后 size 有界', () => {
    const clock = fixedClock();
    const set = new BoundedJtiSet(undefined, () => {}, clock.now);
    for (let i = 0; i < JTI_HARD_CAP + 50; i++) set.add(`j${i}`, clock.now() + 60_000 + i);
    expect(set.size).toBeLessThanOrEqual(JTI_HARD_CAP);
  });
});
