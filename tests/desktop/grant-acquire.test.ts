// @vitest-environment jsdom
/**
 * P0 卡 (A) 页端半（2026-11-06 裁定三十一/三十三/三十六/四十一）：取券器 `grant-acquire`。
 *
 * 三枚负控按实测竞态窗口（宿主首启写 config.json 的 5s 级窗口）定标。
 * 裁定三十六退避时刻表 = 尝试发生在 t=0 / 0.5s / 1.5s / 3.5s / 7.5s / 15.5s（共 6 次 IPC），
 * 实测就绪时刻映射到「第几次尝试成功」：
 *   - 5s  → config 在第 4 试（7.5s）前就绪 → **第 4 试成功**；
 *   - 12s → config 在第 5 试（7.5s）后、第 6 试（15.5s）前就绪 → **压预算最后一格成功**；
 *   - 20s → 最后尝试（15.5s）仍早于就绪时刻 → **预算耗尽回落**（fail-visible）。
 * 另锁：rate-limited 一律停（不重试打爆宿主限流）、非 no-config 错误不重试、
 * 无闭包（dev 形态）零等待回落、单飞（并发一次 IPC）、每轮新券（不缓存）。
 * 宿主侧静默裸连判红由 UI 横幅 + 宿主可 grep 行承接（裁定三十二），本文件锁页端状态机。
 */
import { describe, expect, it, vi, afterEach, type Mock } from 'vitest';
import {
  acquireGrant,
  GRANT_BACKOFF_MS,
  GRANT_FALLBACK_BARE_URL_CAUSE,
  GRANT_REPLY_SHAPE_VIOLATION_CAUSE,
  type GrantAcquireResult,
  type GrantError,
  type GrantReply,
  type RequestGrantFn,
} from '../../src/desktop/grant-acquire';
import { createHostClient, type WebSocketLike } from '../../src/desktop/host-client';

/** 宿主侧 mock：前 n-1 次调用 no-config（config 还没写出来），第 n 次起现签出券。
 *  用调用序号而非墙钟做判定（vitest 2.x 无 getFakeTimers().now()），时刻表由退避表唯一确定。 */
function mockHostGrantSucceedsFromCall(n: number): Mock<(aud: string) => Promise<GrantReply>> {
  let call = 0;
  const fn: Mock<(aud: string) => Promise<GrantReply>> = vi.fn(
    async (aud: string): Promise<GrantReply> => {
      call += 1;
      if (call < n) return { ok: false, error: 'no-config' };
      return { ok: true, grant: `g-${aud}#${call}`, expMs: 60_000 };
    },
  );
  vi.stubGlobal('__studioRequestGrant', fn);
  return fn;
}

/** 宿主侧 mock：固定错误（不可重试形态）。 */
function mockHostGrantError(error: GrantError): Mock<(aud: string) => Promise<GrantReply>> {
  const fn: Mock<(aud: string) => Promise<GrantReply>> = vi.fn(async (): Promise<GrantReply> => ({ ok: false, error }));
  vi.stubGlobal('__studioRequestGrant', fn);
  return fn;
}

/** 一次推进过整个裁定三十六预算（15.5s）+ 余量，再取结果。 */
async function runThroughBudget(p: Promise<GrantAcquireResult>): Promise<GrantAcquireResult> {
  await vi.advanceTimersByTimeAsync(20_000);
  return p;
}

describe('grant-acquire：按需取券状态机（P0 卡 (A) 页端半）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('负控①（实测 5s）：config 第 4 试前就绪 → 退避预算内拿到券（7.5s 第 4 试），回落不发生', async () => {
    vi.useFakeTimers();
    const fn = mockHostGrantSucceedsFromCall(4);
    const r = await runThroughBudget(acquireGrant({ aud: 'main' }));
    expect(r.grant).toBe('g-main#4');
    expect(r.attempts).toBe(4);
    expect(r.lastError).toBeUndefined();
    expect(fn.mock.calls.length).toBe(4);
  });

  it('负控②（实测 12s）：config 压预算最后一格才就绪 → 第 6 试（15.5s）成功，仍判「拿到」', async () => {
    vi.useFakeTimers();
    const fn = mockHostGrantSucceedsFromCall(6);
    const r = await runThroughBudget(acquireGrant({ aud: 'main' }));
    expect(r.grant).toBe('g-main#6');
    expect(r.attempts).toBe(6);
    expect(fn.mock.calls.length).toBe(6);
  });

  it('负控③（实测 20s）：15.5s 预算耗尽 config 仍未就绪 → 回落 + lastError=no-config（fail-visible 依据）', async () => {
    vi.useFakeTimers();
    const fn = mockHostGrantSucceedsFromCall(99); // 预算内永远 no-config
    const r = await runThroughBudget(acquireGrant({ aud: 'main' }));
    expect(r.grant).toBeNull();
    expect(r.attempts).toBe(6);
    expect(r.lastError).toBe('no-config');
    expect(fn.mock.calls.length).toBe(6); // 恰好 6 次 IPC（1 首试 + 5 退避），不多发一次
    // 裁定五十八：no-config 退避耗尽回落裸连 → cause 必带稳定字面量（与宿主 absent 成对），不许只留枚举。
    expect(r.cause).toBe(GRANT_FALLBACK_BARE_URL_CAUSE);
  });

  it('裁定五十八 负控：no-config 退避耗尽（backoffMs=[] 立即耗尽）→ cause=回落裸连字面量，非仅枚举', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      '__studioRequestGrant',
      vi.fn(async (): Promise<GrantReply> => ({ ok: false, error: 'no-config' })),
    );
    const r = await acquireGrant({ aud: 'main', backoffMs: [] });
    expect(r.grant).toBeNull();
    expect(r.attempts).toBe(1);
    expect(r.lastError).toBe('no-config');
    // 可读 cause（指向回落裸连、与 Core absent 成对），且非空、非「只留枚举」。
    expect(r.cause).toBe(GRANT_FALLBACK_BARE_URL_CAUSE);
    expect(r.cause).toBe('grant-fallback-bare-url');
  });

  it('裁定五十八：rate-limited（不可重试枚举）回落裸连 → 同样带稳定 cause（不是泛化 host-down）', async () => {
    vi.useFakeTimers();
    mockHostGrantError('rate-limited');
    const r = await acquireGrant({ aud: 'main', backoffMs: [] });
    expect(r.grant).toBeNull();
    expect(r.lastError).toBe('rate-limited');
    expect(r.cause).toBe(GRANT_FALLBACK_BARE_URL_CAUSE);
  });

  it('rate-limited 一律停：第一回就回落（attempts=1、不重试），不拿重试去打爆宿主限流', async () => {
    vi.useFakeTimers();
    const fn = mockHostGrantError('rate-limited');
    const r = await runThroughBudget(acquireGrant({ aud: 'main' }));
    expect(r.grant).toBeNull();
    expect(r.attempts).toBe(1);
    expect(r.lastError).toBe('rate-limited');
    expect(fn.mock.calls.length).toBe(1); // 20s 预算窗口内没有第二次 IPC
  });

  it('no-secret / sign-failed / bad-aud / host-down：不可重试，第一回即回落（各带自己的枚举，不共用「回落」）', async () => {
    vi.useFakeTimers();
    for (const error of ['no-secret', 'sign-failed', 'bad-aud', 'host-down'] as GrantError[]) {
      vi.unstubAllGlobals();
      const fn = mockHostGrantError(error);
      const r = await runThroughBudget(acquireGrant({ aud: 'main' }));
      expect(r.grant).toBeNull();
      expect(r.attempts).toBe(1);
      expect(r.lastError).toBe(error);
      expect(fn.mock.calls.length).toBe(1);
    }
  });

  it('无 Rust 注入闭包（dev 形态/旧构建）：零等待、零 IPC 回落（attempts=0），行为与改前一致、不挂可见横幅', async () => {
    vi.useFakeTimers();
    // 不 stub __studioRequestGrant → readStudioRequestGrant() = null
    const r = await acquireGrant({ aud: 'main' });
    expect(r).toEqual({ grant: null, attempts: 0 });
  });

  it('单飞：同 aud 并发两次取券只发一次 IPC（不自造请求风暴打红自己的限流）', async () => {
    vi.useFakeTimers();
    const fn = mockHostGrantSucceedsFromCall(1);
    const [a, b] = await Promise.all([acquireGrant({ aud: 'main' }), acquireGrant({ aud: 'main' })]);
    expect(fn.mock.calls.length).toBe(1);
    expect(a.grant).toBe('g-main#1');
    expect(a.grant).toBe(b.grant);
  });

  it('每轮新券（不缓存）：上一轮结算后，下一轮取券再发 IPC（重连语义 = 每次现签）', async () => {
    vi.useFakeTimers();
    const fn = mockHostGrantSucceedsFromCall(1);
    const r1 = await acquireGrant({ aud: 'main' });
    const r2 = await acquireGrant({ aud: 'main' });
    expect(fn.mock.calls.length).toBe(2);
    expect(r1.grant).toBe('g-main#1');
    expect(r2.grant).toBe('g-main#2'); // 不复用旧券
  });

  it('闭包返回形状违反可辨识联合（旧宿主/漂移）：不猜不静默，按 host-down 回落', async () => {
    vi.useFakeTimers();
    const bad: RequestGrantFn = async () => ({ grant: 'x' } as unknown as { ok: true; grant: string; expMs: number });
    vi.stubGlobal('__studioRequestGrant', bad);
    const r = await runThroughBudget(acquireGrant({ aud: 'main' }));
    expect(r.grant).toBeNull();
    expect(r.lastError).toBe('host-down');
    // 裁定五十八 P3：形状违例改稳定字面量（宿主/页端版本不配对的信号），非自由句式、可 grep。
    expect(r.cause).toBe(GRANT_REPLY_SHAPE_VIOLATION_CAUSE);
    expect(r.cause).toBe('grant-reply-shape-violation');
  });

  it('裁定五十七 缺陷③ 负控：闭包抛 ACL 拒绝（IPC 层）→ host-down 停、不重试，cause 捕获原文', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const throwing: RequestGrantFn = async () => {
      calls += 1;
      throw new Error('Command studio_request_grant not allowed by ACL');
    };
    vi.stubGlobal('__studioRequestGrant', throwing);
    const r = await runThroughBudget(acquireGrant({ aud: 'main' }));
    expect(r.grant).toBeNull();
    expect(r.attempts).toBe(1); // 停、不重试（20s 预算窗口内没有第二次 IPC）
    expect(r.lastError).toBe('host-down');
    expect(r.cause).toBe('Command studio_request_grant not allowed by ACL'); // 原文捕获（非泛化枚举）
    expect(calls).toBe(1);
  });

  it('退避表锁死为裁定三十六数值：500→1s→2s→4s→8s（防有人改节奏不留痕）', () => {
    expect(GRANT_BACKOFF_MS).toEqual([500, 1000, 2000, 4000, 8000]);
  });
});

describe('host-client × urlResolver：每轮连接/重连都是新 URL（L2/H1 的消除）', () => {
  class FakeSocket implements WebSocketLike {
    static instances: FakeSocket[] = [];
    readonly url: string;
    readyState = 1;
    onopen: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      FakeSocket.instances.push(this);
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeSocket.instances = [];
  });

  it('重连轮次不复用旧 URL：断开后下一轮 resolve 出新券 URL（token 值不同）', async () => {
    vi.useFakeTimers();
    const fallback = 'ws://127.0.0.1:8760/studio';
    mockHostGrantSucceedsFromCall(1); // config 已就绪：每轮取券立即成功、且每轮都是新券
    const host = createHostClient({
      url: fallback,
      urlResolver: async () => {
        const r = await acquireGrant({ aud: 'main' });
        return r.grant ? `${fallback}?token=${encodeURIComponent(r.grant)}&aud=main` : fallback;
      },
      capabilities: [],
      wsFactory: (url) => new FakeSocket(url),
    });
    host.connect();
    await vi.advanceTimersByTimeAsync(100); // 第 1 轮 resolver 出券 + make()
    expect(FakeSocket.instances.length).toBe(1);
    const first = /token=([^&]+)/.exec(FakeSocket.instances[0]!.url);
    expect(first?.[1]).toBe(encodeURIComponent('g-main#1'));
    // 断开 → 500ms 后第 2 轮：新取一张券（token 值不同 = 不缓存、不复用旧券）
    FakeSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeSocket.instances.length).toBe(2);
    const second = /token=([^&]+)/.exec(FakeSocket.instances[1]!.url);
    expect(second?.[1]).toBe(encodeURIComponent('g-main#2'));
    host.disconnect();
  });

  it('取券失败回落：resolver 返回 fallback URL（既有语义），不断言静默', async () => {
    vi.useFakeTimers();
    vi.unstubAllGlobals(); // 无闭包 → 立即回落（dev 形态）
    const fallback = 'ws://127.0.0.1:8760/studio';
    const host = createHostClient({
      url: fallback,
      urlResolver: async () => {
        const r = await acquireGrant({ aud: 'main' });
        return r.grant ? `${fallback}?token=${encodeURIComponent(r.grant)}` : fallback;
      },
      capabilities: [],
      wsFactory: (url) => new FakeSocket(url),
    });
    host.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(FakeSocket.instances[0]!.url).toBe(fallback);
    host.disconnect();
  });

  it('不传 urlResolver = 行为与改前逐位一致（固定 url，重连仍用同一 URL）', async () => {
    vi.useFakeTimers();
    const fixed = 'ws://fixed/studio';
    const host = createHostClient({
      url: fixed,
      capabilities: [],
      wsFactory: (url) => new FakeSocket(url),
    });
    host.connect();
    await vi.advanceTimersByTimeAsync(10);
    FakeSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeSocket.instances.length).toBe(2);
    expect(FakeSocket.instances[0]!.url).toBe(fixed);
    expect(FakeSocket.instances[1]!.url).toBe(fixed);
    host.disconnect();
  });
});
