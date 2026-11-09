/**
 * tests/desktop/consent-queue.test.ts — K2 宿主侧审批队列的行为锁。
 *
 * 这个文件只测**队列本身**（纯逻辑、不碰 HTTP、不碰 host），覆盖四件事：
 *   1. `shown` 的三来源（窗口没起 / 用户没答 / 用户答了）——这是 `desktop-host` 越界支
 *      判 fail-closed 的依据，写错就会把"超时"读成"允许"；
 *   2. nonce 一次性 + 常数时间比对（伪造回执不改结论）；
 *   3. `drain()` 的 fail-closed 结算（宿主停止时在途请求必须当场 deny，不许悬挂）；
 *   4. **同一引用**反证：两个队列实例并存时，A 登记的待决在 B 上永远取不到回执
 *      （这正是"两处各 new 一个"会造成静默死锁的形状）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createConsentQueue, type PendingConsentView } from '../../src/host/consent-queue';

/** 造一条待审批视图（默认非越界、允许一次/拒绝）。 */
function view(over: Partial<Omit<PendingConsentView, 'requestedAt'>> = {}): Omit<PendingConsentView, 'requestedAt'> {
  return {
    callId: 'c1',
    tool: 'file.write',
    summary: '写 A.txt',
    riskReason: '',
    mode: 'auto',
    target: 'file:C:/ws/A.txt',
    outside: false,
    allowedDecisions: ['allow-once', 'deny'],
    ...over,
  };
}

describe('consent-queue · shown 三来源', () => {
  it('窗口没起（无人轮询）⇒ shown:false + deny（不白等满 timeout）', async () => {
    vi.useFakeTimers();
    try {
      const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = q.request(view());
      // 宽限窗内没有任何人调 pending() ⇒ 到期即收口为 shown:false
      vi.advanceTimersByTime(601);
      await expect(p).resolves.toEqual({ shown: false, decision: 'deny' });
      expect(q.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('窗口起了、用户没答（超时）⇒ shown:true + **deny**（绝不是 allow）', async () => {
    vi.useFakeTimers();
    try {
      const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = q.request(view());
      // Rust 轮询来取 ⇒ 证明"窗口侧活着"
      expect(q.pending()).toHaveLength(1);
      vi.advanceTimersByTime(60_001);
      await expect(p).resolves.toEqual({ shown: true, decision: 'deny' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('用户答了 ⇒ shown:true + 该决议', async () => {
    vi.useFakeTimers();
    try {
      const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = q.request(view());
      const [entry] = q.pending();
      expect(entry).toBeDefined();
      const r = q.reply({ callId: 'c1', decision: 'allow-once', nonce: entry.nonce });
      expect(r).toEqual({ ok: true, decision: 'allow-once' });
      await expect(p).resolves.toEqual({ shown: true, decision: 'allow-once' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('consent-queue · nonce 一次性', () => {
  it('错误 nonce ⇒ 不结算（请求保持挂起）', async () => {
    vi.useFakeTimers();
    try {
      const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = q.request(view());
      q.pending();
      expect(q.reply({ callId: 'c1', decision: 'allow-once', nonce: 'wrong' })).toEqual({
        ok: false,
        code: 'bad-nonce',
      });
      expect(q.size()).toBe(1); // 仍挂起
      vi.advanceTimersByTime(60_001);
      await expect(p).resolves.toEqual({ shown: true, decision: 'deny' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一条回执不能用两次（第二次 unknown-call）', async () => {
    vi.useFakeTimers();
    try {
      const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = q.request(view());
      const [entry] = q.pending();
      expect(q.reply({ callId: 'c1', decision: 'allow-once', nonce: entry.nonce }).ok).toBe(true);
      expect(q.reply({ callId: 'c1', decision: 'allow-once', nonce: entry.nonce })).toEqual({
        ok: false,
        code: 'unknown-call',
      });
      await expect(p).resolves.toEqual({ shown: true, decision: 'allow-once' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('非法 decision ⇒ bad-decision，不结算', async () => {
    vi.useFakeTimers();
    try {
      const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = q.request(view());
      const [entry] = q.pending();
      expect(q.reply({ callId: 'c1', decision: 'always-allow', nonce: entry.nonce })).toEqual({
        ok: false,
        code: 'bad-decision',
      });
      expect(q.size()).toBe(1);
      vi.advanceTimersByTime(60_001);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('consent-queue · drain 是 fail-closed', () => {
  it('宿主停止 ⇒ 在途请求当场 deny（shown:false）且队列清空，**不悬挂**', async () => {
    const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
    const p = q.request(view({ callId: 'c-drain', outside: true }));
    q.pending(); // 模拟窗口已起来
    q.drain();
    // 立刻 await：若 drain 没结算，这里会挂到 timeout（测试超时 ⇒ 红）
    await expect(p).resolves.toEqual({ shown: false, decision: 'deny' });
    expect(q.size()).toBe(0);
  });

  it('drain 后再来的回执 ⇒ unknown-call（迟到的同意不能用）', async () => {
    const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
    const p = q.request(view({ callId: 'c-late' }));
    const [entry] = q.pending();
    q.drain();
    await p;
    expect(q.reply({ callId: 'c-late', decision: 'allow-once', nonce: entry.nonce })).toEqual({
      ok: false,
      code: 'unknown-call',
    });
  });
});

describe('consent-queue · 同一引用（两实例反证）', () => {
  it('负控：A 登记、B 回执 ⇒ B 永远取不到（这正是"两处各 new 一个"的形状）', async () => {
    vi.useFakeTimers();
    try {
      const a = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const b = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = a.request(view({ callId: 'c-shared' }));
      const [entry] = a.pending();
      // 用 A 的 nonce 去 B 回执 —— 两个实例时必然 404
      expect(b.reply({ callId: 'c-shared', decision: 'allow-once', nonce: entry.nonce })).toEqual({
        ok: false,
        code: 'unknown-call',
      });
      // A 侧仍挂起，最终按超时 deny（证明"症状"是永远拿不到回执）
      vi.advanceTimersByTime(60_001);
      await expect(p).resolves.toEqual({ shown: true, decision: 'deny' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('正控：同一实例上登记与回执相遇 ⇒ 决议生效（证明上面那枚负控不是"回执永远不通"）', async () => {
    vi.useFakeTimers();
    try {
      const q = createConsentQueue({ timeoutMs: 60_000, pollerGraceMs: 600 });
      const p = q.request(view({ callId: 'c-one' }));
      const [entry] = q.pending();
      expect(q.reply({ callId: 'c-one', decision: 'deny', nonce: entry.nonce }).ok).toBe(true);
      await expect(p).resolves.toEqual({ shown: true, decision: 'deny' });
    } finally {
      vi.useRealTimers();
    }
  });
});
