/**
 * QD-R8o 复现件 · 页端那把锁的「键」在同一段标签被重新解析时稳不稳
 * （运行副本请放 tests/desktop/，⛔ 本席改码）
 *
 * 背景：`qd-r8o-host-dedupe.test.ts` 的 CONTROL-A 已真跑证到「两枚不同 callId ⇒ 宿主真跑两次」，
 * 所以只剩这一半没证：重解析到底会不会造出两枚不同的 callId。若会，则页锁的射程＝
 * 「同一个已解析对象被 forward 两次」，而「同一段工具标签被解析两次」这条真在链上的形状
 * （fetch SSE 通道 `main-world-interceptor.ts:888/:910` 与 XHR 通道 `:1141/:1186` 各 new 一枚
 * parser、尾部重投 `:937`）谁都拦不住，宿主侧又⛔ 锁（见同轮 REPRO-A）。
 *
 * 断言写「应有行为」：重复的逻辑调用应该被 claim 拦下 ⇒ 红＝缺陷在场。
 */

import { describe, expect, it } from 'vitest';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';
import { createToolCallDedupe } from '../../src/shared/tool-call-dedupe';

const NAMES = ['local_file_write', 'shell_exec'] as const;
const TAG = '<local_file_write>{"path":"/tmp/a.txt","content":"hello"}</local_file_write>';

/** 把同一段文本各自解析一次（两枚独立 parser ＝ 两条拦截通道各读到同一段流）。 */
function parseTwiceIndependent(): { idA: string; idB: string } {
  const p1 = new StreamingToolCallParser(NAMES);
  const p2 = new StreamingToolCallParser(NAMES);
  const a = p1.feed(TAG).calls;
  const b = p2.feed(TAG).calls;
  expect(a.length).toBe(1);
  expect(b.length).toBe(1);
  return { idA: a[0].id, idB: b[0].id };
}

describe('QD-R8o · 去重键的可重现性', () => {
  it('REPRO-C：同一段标签被两条通道各解析一次 → 应有行为＝锁认得出是同一枚调用（claim 第二次=false）', () => {
    const { idA, idB } = parseTwiceIndependent();
    const dedupe = createToolCallDedupe();
    const first = dedupe.claim(idA);
    const second = dedupe.claim(idB);
    console.log(`[REPRO-C] idA=${idA} idB=${idB} 同段标签两次解析 id 相同=${idA === idB} claim(第1)=${first} claim(第2)=${second} size=${dedupe.size()}`);
    expect(second).toBe(false);
  });

  it('REPRO-D：同一个 parser 把同一段标签再喂一次 → 应有行为＝仍只认领一次', () => {
    const p = new StreamingToolCallParser(NAMES);
    const first = p.feed(TAG).calls[0];
    const again = p.feed(TAG).calls[0];
    const dedupe = createToolCallDedupe();
    dedupe.claim(first.id);
    const second = dedupe.claim(again.id);
    console.log(`[REPRO-D] first=${first.id} again=${again.id} claim(again)=${second} size=${dedupe.size()}`);
    expect(second).toBe(false);
  });

  it('CONTROL-C：同一个已解析对象 forward 两次 → 锁拦得住（正控：尺打得开，⛔ 是「键恒不同」的假红）', () => {
    const p = new StreamingToolCallParser(NAMES);
    const call = p.feed(TAG).calls[0];
    const dedupe = createToolCallDedupe();
    expect(dedupe.claim(call.id)).toBe(true);
    expect(dedupe.claim(call.id)).toBe(false);
    expect(dedupe.size()).toBe(1);
  });

  it('CONTROL-D：两枚真不同的调用 → 都该放行（正控：锁⛔ 误杀）', () => {
    const p = new StreamingToolCallParser(NAMES);
    const calls = p.feed(`${TAG}<shell_exec>{"command":"ls -la"}</shell_exec>`).calls;
    expect(calls.length).toBe(2);
    const dedupe = createToolCallDedupe();
    expect(dedupe.claim(calls[0].id)).toBe(true);
    expect(dedupe.claim(calls[1].id)).toBe(true);
    expect(dedupe.size()).toBe(2);
  });
});
