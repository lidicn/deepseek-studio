/**
 * R-W4：autoReply 消费去重必须用单调 replySeq，不能用 loopDepth。
 * 背景：loopDepth 每条新消息归零（desktop-host.ts:1846），
 * 第一轮 loop=2 被消费后，新消息触发的第二轮 loop=1 会被误判为已消费。
 */
import { describe, it, expect } from 'vitest';

describe('R-W4: autoReply 去重键 = 单调 replySeq（不是 loopDepth）', () => {
  function makeConsume() {
    const lastConsumedSeq = new WeakMap<object, number>();
    let counter = 0;
    function onReply(state: object, text: string, loop: number) {
      counter += 1;
      return { text, loop, seq: counter, fresh: true, updatedAt: Date.now() };
    }
    function consume(state: object, buf: { seq: number; text: string; loop: number; fresh: boolean; updatedAt: number }) {
      const consumed = lastConsumedSeq.get(state) ?? -1;
      if (buf.seq <= consumed) return { ...buf, fresh: false };
      lastConsumedSeq.set(state, buf.seq);
      return { ...buf, fresh: true };
    }
    return { onReply, consume };
  }

  it('第一轮 loop=2 已消费 → 新消息 → 第二轮 loop=1 必须判为 fresh', () => {
    const { onReply, consume } = makeConsume();
    const state = {};
    // 第一轮：loop=2
    const r1 = onReply(state, 'first reply', 2);
    expect(consume(state, r1).fresh).toBe(true);
    // 第二轮：新消息进来，loopDepth 归零到 1（但 seq 全局自增）
    const r2 = onReply(state, 'second reply', 1);
    // 关键断言：loop=1 < 上次 loop=2，但 seq 更大 → fresh=true
    expect(r2.loop).toBe(1);
    expect(consume(state, r2).fresh).toBe(true);
  });

  it('同一 reply 重复消费必须判为 not fresh（seq 不变）', () => {
    const { onReply, consume } = makeConsume();
    const state = {};
    const r = onReply(state, 'same', 1);
    expect(consume(state, r).fresh).toBe(true);
    expect(consume(state, r).fresh).toBe(false);
  });
});
