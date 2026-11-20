/**
 * 单轮工具串行护栏（卡 ㊿-b ①）的行为级测试。
 *
 * 现场依据（装版真机 turn 4922ceac，落盘 storage.json）：
 *   `local_file_read{smoke_out.log}` start dt=10494 ＋ `local_file_read{_core_gates.log}`
 *   start dt=10600，两个 result dt=10752／10758 ⇒ 两个**不同参数**的标签并发执行。
 *   页端 `claimSignature` 只拦同名同参 ⇒ 签名不同时它放行。
 *
 * 本文件钉四件事：
 *   ① 只读并发 → 按到达顺序串行；
 *   ② 写类/执行类并发 → 后到者被拒（带 terminate），不静默排队；
 *   ③ 同签名本轮已有结果 → 熔断（前缀 `duplicate-tool-signature:`）；
 *   ④ 中间发生过变更后重读同一目标 → 放行（合法复查，不是重复）。
 */
import { describe, expect, it } from 'vitest';
import { createTurnSerialGuard, stableSignature, turnGuardRejection } from '../../src/host/turn-serial-guard';

const KEY = 'conv-1|turn-1';

describe('单轮串行护栏 · 只读并发按到达顺序串行', () => {
  it('第二枚只读必须等第一枚 release 之后才拿到执行权', async () => {
    const guard = createTurnSerialGuard();
    const order: string[] = [];

    const first = await guard.acquire({ key: KEY, tool: 'file.read', signature: 'file.read:A', mutating: false });
    expect(first.kind).toBe('run');
    order.push('first:run');

    // 第二枚并发到达：此时还没轮到它（Promise 未 settle）
    let secondSettled = false;
    const secondPromise = guard
      .acquire({ key: KEY, tool: 'file.read', signature: 'file.read:B', mutating: false })
      .then((d) => {
        secondSettled = true;
        order.push(`second:${d.kind}`);
        return d;
      });

    await Promise.resolve();
    expect(secondSettled, '第一枚未 release 时，第二枚不得拿到执行权').toBe(false);
    expect(guard.stats().inFlight).toBe(1);

    (first as { release: () => void }).release(); // 模拟第一枚执行完毕
    const second = await secondPromise;
    expect(second.kind).toBe('run');
    expect(order).toEqual(['first:run', 'second:run']);
    (second as { release: () => void }).release();
    expect(guard.stats().inFlight).toBe(0);
  });

  it('FIFO：三枚只读按到达顺序排队', async () => {
    const guard = createTurnSerialGuard();
    const first = await guard.acquire({ key: KEY, tool: 'file.read', signature: 's1', mutating: false });
    const order: string[] = [];
    const p2 = guard.acquire({ key: KEY, tool: 'file.read', signature: 's2', mutating: false }).then((d) => {
      order.push('s2');
      return d;
    });
    const p3 = guard.acquire({ key: KEY, tool: 'file.read', signature: 's3', mutating: false }).then((d) => {
      order.push('s3');
      return d;
    });
    (first as { release: () => void }).release();
    const d2 = (await p2) as { release: () => void };
    expect(order).toEqual(['s2']);
    d2.release();
    const d3 = (await p3) as { release: () => void };
    expect(order).toEqual(['s2', 's3']);
    d3.release();
  });
});

describe('单轮串行护栏 · 写类/执行类并发必须被拒', () => {
  it.each([
    ['file.write'],
    ['file.edit'],
    ['shell.exec'],
  ])('%s 在另一枚在跑时并发到达 ⇒ concurrent-mutation-blocked（带 terminate）', async (tool) => {
    const guard = createTurnSerialGuard();
    const first = await guard.acquire({ key: KEY, tool: 'file.read', signature: 'r1', mutating: false });
    const blocked = await guard.acquire({
      key: KEY,
      tool,
      signature: `${tool}:x`,
      mutating: true,
    });
    expect(blocked.kind).toBe('reject');
    const r = blocked as { code: string; terminate: boolean; message: string };
    expect(r.code).toBe('concurrent-mutation-blocked');
    expect(r.terminate).toBe(true);
    expect(r.message).toContain('未被执行'); // 可行动回执，不是静默排队
    (first as { release: () => void }).release();
  });

  it('空闲时写类照常执行（护栏只拦并发，不拦正常写）', async () => {
    const guard = createTurnSerialGuard();
    const d = await guard.acquire({ key: KEY, tool: 'file.write', signature: 'w1', mutating: true });
    expect(d.kind).toBe('run');
    (d as { release: () => void }).release();
  });
});

describe('单轮串行护栏 · 同签名重复熔断', () => {
  it('本轮已有结果且此后无变更 ⇒ duplicate-tool-signature（前缀不许改）', async () => {
    const guard = createTurnSerialGuard();
    const sig = stableSignature('file.read', { path: 'E:/a.txt' });
    const first = await guard.acquire({ key: KEY, tool: 'file.read', signature: sig, mutating: false });
    (first as { release: () => void }).release();

    const dup = await guard.acquire({ key: KEY, tool: 'file.read', signature: sig, mutating: false });
    expect(dup.kind).toBe('reject');
    const r = dup as { code: string; message: string; terminate: boolean };
    expect(r.code).toBe('duplicate-tool-signature');
    expect(r.message.startsWith('duplicate-tool-signature:')).toBe(true);
    expect(r.terminate).toBe(true);
  });

  it('中间发生过变更后重读同一目标 ⇒ 放行（合法复查，不是重复）', async () => {
    const guard = createTurnSerialGuard();
    const readSig = stableSignature('file.read', { path: 'E:/a.txt' });
    const r1 = await guard.acquire({ key: KEY, tool: 'file.read', signature: readSig, mutating: false });
    (r1 as { release: () => void }).release();

    const w = await guard.acquire({
      key: KEY,
      tool: 'file.edit',
      signature: stableSignature('file.edit', { path: 'E:/a.txt' }),
      mutating: true,
    });
    expect(w.kind).toBe('run');
    (w as { release: () => void }).release();

    const r2 = await guard.acquire({ key: KEY, tool: 'file.read', signature: readSig, mutating: false });
    expect(r2.kind, '读→写→再读同一文件必须放行').toBe('run');
    (r2 as { release: () => void }).release();
  });

  it('同一写调用重复发一次 ⇒ 熔断（变更类也要拦）', async () => {
    const guard = createTurnSerialGuard();
    const sig = stableSignature('file.write', { path: 'E:/a.txt', content: 'x' });
    const w1 = await guard.acquire({ key: KEY, tool: 'file.write', signature: sig, mutating: true });
    (w1 as { release: () => void }).release();
    const w2 = await guard.acquire({ key: KEY, tool: 'file.write', signature: sig, mutating: true });
    expect(w2.kind).toBe('reject');
    expect((w2 as { code: string }).code).toBe('duplicate-tool-signature');
  });

  /**
   * 卡 ㊿-b ② 收口补锁：`dedupe:false`（no-turn 退化键）。
   *
   * 现场成因：没有 turn 身份时 `completed` 永不重置 ⇒ 熔断会把宿主内部路径
   * （HTTP toolExecutor / dispatch / 多 bot invokeTool 全共享 `host-agent|no-turn`）
   * 里第二次**完全合法**的相同调用误杀成重复 —— `page-runtime-multibot` 两枚 echo 就这么红的。
   * 语义：读不到 turn ⇒ 熔断关、**串行仍开**（并发保护不放松）。
   */
  it('dedupe:false（no-turn 退化键）⇒ 同签名重复放行，但并发仍被串行约束', async () => {
    const guard = createTurnSerialGuard();
    const sig = stableSignature('echo', {});
    const a = await guard.acquire({ key: 'host-agent|no-turn', tool: 'echo', signature: sig, mutating: false, dedupe: false });
    expect(a.kind).toBe('run');

    // 并发：第二枚必须等第一枚释放（串行未放松）
    let secondSettled = false;
    const pending = guard
      .acquire({ key: 'host-agent|no-turn', tool: 'echo', signature: sig, mutating: false, dedupe: false })
      .then((d) => {
        secondSettled = true;
        return d;
      });
    await Promise.resolve();
    expect(secondSettled, '第一枚未释放前第二枚不得拿到执行权').toBe(false);

    (a as { release: () => void }).release();
    const b = await pending;
    expect(b.kind, 'no-turn 下同签名第二次属于合法调用，必须放行').toBe('run');
    (b as { release: () => void }).release();

    // 第三枚同样放行（证明 completed 记忆未参与 no-turn 判定）
    const c = await guard.acquire({ key: 'host-agent|no-turn', tool: 'echo', signature: sig, mutating: false, dedupe: false });
    expect(c.kind).toBe('run');
    (c as { release: () => void }).release();
  });

  /**
   * 卡 P2-a（验收提案）：排队出队按 **HTTP 边界到达序号**，不按 acquire 完成序。
   *
   * 现场（cell12）：acquire 在两条 await 之后才跑 ⇒ 完成序≠到达序 ⇒ 后到者先执行。
   * 修法：调用方在边界取单调序号传入；release 交接时按序号最小的等待者放行。
   */
  it('arrivalSeq：晚 acquire 但序号小者先拿执行权（出队按到达戳，不按 push 序）', async () => {
    const guard = createTurnSerialGuard();
    // g2 先 acquire（seq 2）占住空闲位；g1 后 acquire（seq 1）进队列——
    // 复现 cell12 的「acquire 完成序 ≠ 到达序」：g2 完成在前、到达在后。
    const g2 = await guard.acquire({ key: KEY, tool: 'file.read', signature: 'sig-2', mutating: false, arrivalSeq: 2 });
    expect(g2.kind, 'g2 空闲位上直接执行').toBe('run');

    let g1Started = false;
    const g1p = guard
      .acquire({ key: KEY, tool: 'file.read', signature: 'sig-1', mutating: false, arrivalSeq: 1 })
      .then((d) => {
        g1Started = true;
        return d;
      });
    const g3p = guard.acquire({ key: KEY, tool: 'file.read', signature: 'sig-3', mutating: false, arrivalSeq: 3 });
    await Promise.resolve();
    expect(g1Started, 'g1 必须在排队（g2 在飞），未拿执行权').toBe(false);

    // g2 释放 ⇒ 下一枚必须是 g1（seq 1 < seq 3），即便 g3 的 acquire 调用在 g1 之后。
    (g2 as { release: () => void }).release();
    const g1d = await g1p;
    expect(g1d.kind).toBe('run');
    (g1d as { release: () => void }).release();
    const g3d = await g3p;
    expect(g3d.kind).toBe('run');
    (g3d as { release: () => void }).release();
  });

  it('release 交接也按到达戳出队：先释放后的两次交接序号单调（g1→g2→g3）', async () => {
    const guard = createTurnSerialGuard();
    const order: string[] = [];
    const mk = (name: string, seq: number) =>
      guard
        .acquire({ key: KEY, tool: 'file.read', signature: `s-${name}`, mutating: false, arrivalSeq: seq })
        .then((d) => {
          if (d.kind === 'run') {
            order.push(name);
            d.release();
          }
          return d.kind;
        });
    // 全部发起后：g0 占位，g1/g2/g3 排队；逐次交接必须按 seq 升序。
    const first = await mk('g0', 0);
    expect(first).toBe('run');
    const p1 = mk('g1', 1);
    const p2 = mk('g2', 2);
    const p3 = mk('g3', 3);
    await p1; await p2; await p3;
    // g0.release 已在 mk 内调用 ⇒ 队列按 seq 依次放行。
    expect(order).toEqual(['g0', 'g1', 'g2', 'g3']);
  });

  /**
   * P2-a 证伪力核心格：**push 序与 arrivalSeq 相反**——
   * g1 后 acquire（seq 1）却排在 g2（seq 2，先 acquire）前面；旧行为（按 push 序）
   * 会放行 g2，新行为放行 g1。这条是负控判据的靶心（push 序＝到达序的用例证伪不了旧行为）。
   */
  it('arrivalSeq 与 push 序相反：seq 小但后 push 者必须先执行', async () => {
    const guard = createTurnSerialGuard();
    const order: string[] = [];
    const holder = await guard.acquire({ key: KEY, tool: 'file.read', signature: 'hold', mutating: false, arrivalSeq: 0 });
    expect(holder.kind).toBe('run');

    // g2 先 acquire（seq 2）先 push；g1 后 acquire（seq 1）后 push。
    const p2 = guard
      .acquire({ key: KEY, tool: 'file.read', signature: 's2', mutating: false, arrivalSeq: 2 })
      .then((d) => { if (d.kind === 'run') { order.push('g2'); d.release(); } return d.kind; });
    const p1 = guard
      .acquire({ key: KEY, tool: 'file.read', signature: 's1', mutating: false, arrivalSeq: 1 })
      .then((d) => { if (d.kind === 'run') { order.push('g1'); d.release(); } return d.kind; });
    await Promise.resolve();
    // 队列 push 序＝[g2, g1]；到达序＝[g1(seq1), g2(seq2)]。
    (holder as { release: () => void }).release();
    await p2; await p1;
    expect(order, '交接必须按到达戳（g1 先于 g2），不是按 push 序').toEqual(['g1', 'g2']);
  });
});

describe('单轮串行护栏 · 边界', () => {
  it('不同 turn 互不阻塞（按 turn 重置，不按流）', async () => {
    const guard = createTurnSerialGuard();
    const a = await guard.acquire({ key: 'conv-1|turn-1', tool: 'file.read', signature: 's', mutating: false });
    const b = await guard.acquire({ key: 'conv-1|turn-2', tool: 'file.read', signature: 's', mutating: false });
    expect(a.kind).toBe('run');
    expect(b.kind, '新回合不得被上一回合的在途调用阻塞（也不得被其签名熔断）').toBe('run');
    (a as { release: () => void }).release();
    (b as { release: () => void }).release();
  });

  it('只读排队超上限 ⇒ turn-concurrent-queue-full（fail-closed，不静默挂起）', async () => {
    const guard = createTurnSerialGuard({ maxQueued: 2 });
    const first = await guard.acquire({ key: KEY, tool: 'file.read', signature: 's0', mutating: false });
    const p1 = guard.acquire({ key: KEY, tool: 'file.read', signature: 's1', mutating: false });
    const p2 = guard.acquire({ key: KEY, tool: 'file.read', signature: 's2', mutating: false });
    const overflow = await guard.acquire({ key: KEY, tool: 'file.read', signature: 's3', mutating: false });
    expect(overflow.kind).toBe('reject');
    expect((overflow as { code: string }).code).toBe('turn-concurrent-queue-full');

    (first as { release: () => void }).release();
    (await p1 as { release: () => void }).release();
    (await p2 as { release: () => void }).release();
  });

  it('reset() 会把排队者全部以可行动拒绝收口（不留悬空 Promise）', async () => {
    const guard = createTurnSerialGuard();
    const first = await guard.acquire({ key: KEY, tool: 'file.read', signature: 's0', mutating: false });
    const pending = guard.acquire({ key: KEY, tool: 'file.read', signature: 's1', mutating: false });
    guard.reset();
    const d = await pending;
    expect(d.kind).toBe('reject');
    expect((d as { code: string }).code).toBe('turn-concurrent-queue-full');
    // 原 first 的 release 在 reset 后仍幂等、不产生负数
    (first as { release: () => void }).release();
    expect(guard.stats().inFlight).toBe(0);
  });

  it('release 幂等：重复调用不会让 inFlight 变负', async () => {
    const guard = createTurnSerialGuard();
    const d = await guard.acquire({ key: KEY, tool: 'file.read', signature: 's', mutating: false });
    const release = (d as { release: () => void }).release;
    release();
    release();
    expect(guard.stats().inFlight).toBe(0);
  });
});

describe('拒绝回执形态', () => {
  it('turnGuardRejection 带 terminate/isError/可读正文（模型能读到为什么没执行）', () => {
    const r = turnGuardRejection({ code: 'concurrent-mutation-blocked', message: 'concurrent-mutation-blocked: x' });
    expect(r.ok).toBe(false);
    expect(r.terminate).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.reason).toContain('concurrent-mutation-blocked');
    expect(Array.isArray(r.content) && r.content.length > 0).toBe(true);
  });
});
