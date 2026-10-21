/**
 * 元宝注入层单元测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSignals,
  emptySignals,
  mergeSignals,
} from '../signal-detector';

test('检测 ROUND_N_DONE 轮次', () => {
  const s = detectSignals('ROUND_1_DONE 完成第一轮 ROUND_2_DONE 完成第二轮');
  assert.deepEqual([...s.rounds].sort(), [1, 2]);
});

test('检测 ALL_DONE', () => {
  const s = detectSignals('任务全部完成 ALL_DONE');
  assert.equal(s.allDone, true);
});

test('检测 NEED_DECISION 和 NEED_CONTINUE', () => {
  const s = detectSignals('需要决策 NEED_DECISION');
  assert.equal(s.needDecision, true);
  const s2 = detectSignals('需要继续 NEED_CONTINUE');
  assert.equal(s2.needContinue, true);
});

test('模板说明里的信号不计入', () => {
  const s = detectSignals('请在完成后输出 ROUND_1_DONE 标记，例如：ALL_DONE');
  // "请在" 和 "例如" 是模板提示词
  assert.equal(s.rounds.size, 0);
  assert.equal(s.allDone, false);
});

test('支持连字符格式 ROUND-3-DONE', () => {
  const s = detectSignals('ROUND-3-DONE');
  assert.deepEqual([...s.rounds], [3]);
});

test('支持空格格式 ROUND 4 DONE', () => {
  const s = detectSignals('ROUND 4 DONE');
  assert.deepEqual([...s.rounds], [4]);
});

test('mergeSignals 合并并返回新增轮次', () => {
  const current = emptySignals();
  const d1 = detectSignals('ROUND_1_DONE');
  const added1 = mergeSignals(current, d1);
  assert.deepEqual(added1, [1]);

  const d2 = detectSignals('ROUND_1_DONE ROUND_2_DONE');
  const added2 = mergeSignals(current, d2);
  assert.deepEqual(added2, [2]);
  assert.equal(current.rounds.size, 2);
});

test('空文本返回空信号', () => {
  const s = detectSignals('');
  assert.equal(s.rounds.size, 0);
  assert.equal(s.allDone, false);
});

test('真实输出与模板混合：只计真实信号', () => {
  const text = '系统提示：完成时输出 ALL_DONE 标记\n\n实际执行结果：\nROUND_5_DONE\nALL_DONE';
  const s = detectSignals(text);
  assert.deepEqual([...s.rounds], [5]);
  // 最后一个 ALL_DONE 是真实的（前面没有模板词）
  assert.equal(s.allDone, true);
});
