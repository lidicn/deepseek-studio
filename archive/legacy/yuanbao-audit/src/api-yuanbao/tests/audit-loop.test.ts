import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuditLoop, isCommandName, type CommandName, type RoundOutcome } from '../audit-loop';

function fakeScheduler() {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    get size() {
      return timers.size;
    },
    async fireAll() {
      const fns = [...timers.values()].map((t) => t.fn);
      timers.clear();
      for (const fn of fns) fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

test('初始状态：idle / 0 / target / null', () => {
  const loop = createAuditLoop({ target: 3, intervalMs: 10, runRound: () => ({ ok: true }) });
  assert.deepEqual(loop.status(), { state: 'idle', rounds: 0, target: 3, lastRound: null });
});

test('continue 立即入队并生效（队列有记录、状态转 running、调度器被排上）', () => {
  const scheduler = fakeScheduler();
  const loop = createAuditLoop({
    target: 3,
    intervalMs: 10,
    runRound: () => ({ ok: true }),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  const res = loop.enqueue('continue');
  assert.deepEqual(res, { ok: true, command: 'continue', queueDepth: 1 });
  assert.equal(loop.status().state, 'running');
  assert.equal(loop.queueDepth(), 1);
  assert.deepEqual(loop.pending(), [], '空闲时命令应已被应用');
  assert.equal(loop.history(1)[0].command, 'continue');
  assert.equal(loop.history(1)[0].applied, true);
  assert.equal(scheduler.size, 1, 'continue 后应有 1 个待触发定时器');
});

test('tick 执行一轮：rounds 1、lastRound 取 now()、runRound 收到 round/target', async () => {
  const seen: number[] = [];
  let clock = 1000;
  const loop = createAuditLoop({
    target: 2,
    intervalMs: 5,
    now: () => clock,
    runRound: (ctx) => {
      seen.push(ctx.round);
      assert.equal(ctx.target, 2);
      clock += 7;
      return { ok: true, summary: `r${ctx.round}` };
    },
  });
  loop.enqueue('continue');
  const st = await loop.tick();
  assert.deepEqual(seen, [1]);
  assert.deepEqual(st, { state: 'running', rounds: 1, target: 2, lastRound: 1007 });
});

test('达到 target 转 done，后续 tick 不再跑轮次', async () => {
  let calls = 0;
  const loop = createAuditLoop({
    target: 1,
    intervalMs: 5,
    runRound: () => {
      calls += 1;
      return { ok: true };
    },
  });
  loop.enqueue('continue');
  const st = await loop.tick();
  assert.equal(st.state, 'done');
  assert.equal(st.rounds, 1);
  await loop.tick();
  assert.equal(calls, 1);
  // done 之后 continue 不重启
  loop.enqueue('continue');
  assert.equal(loop.status().state, 'done');
});

test('pause 阻断轮次；continue 恢复', async () => {
  let calls = 0;
  const loop = createAuditLoop({
    target: 5,
    intervalMs: 5,
    runRound: () => {
      calls += 1;
      return { ok: true };
    },
  });
  loop.enqueue('continue');
  loop.enqueue('pause');
  assert.equal(loop.status().state, 'paused');
  await loop.tick();
  assert.equal(calls, 0, 'paused 状态不应跑轮次');
  loop.enqueue('continue');
  await loop.tick();
  assert.equal(calls, 1);
  assert.equal(loop.status().rounds, 1);
});

test('轮次进行中到达的命令排队，轮次收尾才生效（safe point）', async () => {
  let release: ((o: RoundOutcome) => void) | null = null;
  const loop = createAuditLoop({
    target: 5,
    intervalMs: 5,
    runRound: () => new Promise<RoundOutcome>((resolve) => (release = resolve)),
  });
  loop.enqueue('continue');
  const tickPromise = loop.tick();
  await new Promise((r) => setTimeout(r, 0));

  const res = loop.enqueue('pause');
  assert.equal(res.ok, true);
  assert.equal(res.queueDepth, 2);
  assert.equal(loop.status().state, 'running', '轮次在飞时状态暂不切换');
  assert.equal(loop.pending().length, 1, '命令在队列里等待');
  assert.equal(loop.pending()[0].command, 'pause');

  (release as unknown as (o: RoundOutcome) => void)({ ok: true });
  await tickPromise;
  assert.equal(loop.status().state, 'paused');
  assert.deepEqual(loop.pending(), []);
  assert.equal(loop.status().rounds, 1);
});

test('reset 清零进度与失败计数', async () => {
  const loop = createAuditLoop({ target: 5, intervalMs: 5, runRound: () => ({ ok: true }) });
  loop.enqueue('continue');
  await loop.tick();
  loop.enqueue('reset');
  assert.deepEqual(loop.status(), { state: 'idle', rounds: 0, target: 5, lastRound: null });
});

test('连续失败达到阈值 → stopped 并记录 lastError（fail-safe 不空转）', async () => {
  const logs: string[] = [];
  const loop = createAuditLoop({
    target: 5,
    intervalMs: 5,
    maxConsecutiveFailures: 3,
    log: (m) => logs.push(m),
    runRound: () => ({ ok: false, error: 'upstream 401' }),
  });
  loop.enqueue('continue');
  await loop.tick();
  await loop.tick();
  assert.equal(loop.status().state, 'running');
  await loop.tick();
  assert.deepEqual(loop.status(), { state: 'stopped', rounds: 0, target: 5, lastRound: null });
  assert.equal(loop.lastError(), 'upstream 401');
  assert.equal(logs.length, 3);
});

test('失败后成功会清零连续失败计数', async () => {
  let call = 0;
  const loop = createAuditLoop({
    target: 5,
    intervalMs: 5,
    maxConsecutiveFailures: 2,
    runRound: () => {
      call += 1;
      return call === 1 ? { ok: false, error: 'e1' } : { ok: true };
    },
  });
  loop.enqueue('continue');
  await loop.tick();
  await loop.tick();
  await loop.tick();
  assert.equal(loop.status().state, 'running');
  assert.equal(loop.status().rounds, 2);
  assert.equal(loop.lastError(), null);
});

test('runRound 抛异常/返回非法结果都按失败处理', async () => {
  const loop = createAuditLoop({
    target: 1,
    intervalMs: 5,
    maxConsecutiveFailures: 1,
    runRound: () => {
      throw new Error('boom');
    },
  });
  loop.enqueue('continue');
  const st = await loop.tick();
  assert.deepEqual(st, { state: 'stopped', rounds: 0, target: 1, lastRound: null });
  assert.equal(loop.lastError(), 'boom');
});

test('重入保护：并发 tick 只跑一轮', async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const loop = createAuditLoop({
    target: 5,
    intervalMs: 5,
    runRound: async () => {
      calls += 1;
      await new Promise<void>((r) => (release = r));
      return { ok: true };
    },
  });
  loop.enqueue('continue');
  const a = loop.tick();
  const b = loop.tick();
  await new Promise((r) => setTimeout(r, 0));
  (release as unknown as () => void)();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(loop.status().rounds, 1);
});

test('恢复 checkpoint：四字段原样断点续跑（验收 7 的 loop 层）', async () => {
  const loop = createAuditLoop({
    target: 99,
    intervalMs: 5,
    restored: { state: 'running', rounds: 2, target: 3, lastRound: 1234 },
    runRound: () => ({ ok: true }),
    setTimer: fakeScheduler().setTimer,
    clearTimer: fakeScheduler().clearTimer,
  });
  assert.deepEqual(loop.status(), { state: 'running', rounds: 2, target: 3, lastRound: 1234 });
  const st = await loop.tick();
  assert.equal(st.rounds, 3);
  assert.equal(st.state, 'done');
});

test('非法命令被拒并给出原因', () => {
  const loop = createAuditLoop({ target: 1, intervalMs: 5, runRound: () => ({ ok: true }) });
  const res = loop.enqueue('reboot' as CommandName);
  assert.equal(res.ok, false);
  assert.equal(res.queueDepth, 0);
  assert.match(String(res.reason), /unknown command: reboot/);
  assert.equal(isCommandName('reset'), true);
  assert.equal(isCommandName(1), false);
});

test('onSettled 抛异常不影响轮次（fail-open）', async () => {
  let calls = 0;
  const loop = createAuditLoop({
    target: 2,
    intervalMs: 5,
    runRound: () => ({ ok: true }),
    onSettled: () => {
      throw new Error('disk full');
    },
  });
  loop.enqueue('continue');
  await loop.tick();
  calls = loop.status().rounds;
  assert.equal(calls, 1);
  assert.equal(loop.status().state, 'running');
});
