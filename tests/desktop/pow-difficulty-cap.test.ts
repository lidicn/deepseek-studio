/**
 * QD-R23 #2（PM 06:5x 派 UI，不阻塞 0.14.9）：PoW difficulty 封顶。
 *
 * 缺陷（PM 亲读源码 + Verify 只读复验）：`src/inject/pow.ts:95` `difficulty: Number(challenge.difficulty)`
 * 完全来自服务端响应、本地零上界校验（`Number()` 可出 NaN/Infinity）⇒ 直接喂 `:64` WASM 求解循环
 * ⇒ 服务端/改写方给极大 difficulty ⇒ 主线程长期占住 ⇒ 页面卡死。`:68-70` 只在求解失败才抛
 * （「算不出」≠「不该算」）。
 *
 * 依据（标注「推断」）：真实观测值 = `logs/cdp-chat-capture/` 9 份抓包全部 `difficulty: 144000`；
 * 上游 deepseek++ `core/deepseek/pow.ts:92` 只验下界/类型（`Number.isSafeInteger && > 0`）、**无上界**。
 * 上界 `POW_DIFFICULTY_MAX = 2_000_000` 为**保守取值**（≈14× 观测值余量），非权威最大下发值。
 *
 * 判据（Verify 台账 L115 四条，一条不松）：
 *  ① 四类非法 difficulty（超界 / NaN（单独一条）/ Infinity / 负数 / 小数）逐个被拒；
 *  ② 负控真打在「上界拦截」层而非「网络失败」——装置自检证「请求确实发出 + challenge 确实被解析」，
 *     注入层 = `globalThis.fetch`（网络请求层），断言错误码 = `pow-invalid-difficulty`（上界码，非网络错）；
 *  ③ 错误走既有 `pow-expired` 同族通道（code-string + `ui-error-codes.ts` 映射 + 调用方 `includes` 识别），
 *     没另造并行机制；正控 = 真实值 144000 过守卫、行为与改前逐位一致（求解前守卫不拦合法值）；
 *  ④ 双处 entry.js 指纹（交卷最后动作 = build:inject，见交卷）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createPowHeaders,
  isPowDifficultyValid,
  POW_DIFFICULTY_MAX,
} from '../../src/inject/pow';

/** 造一份真实的 PoW challenge 响应体（形状对齐 cdp-chat-capture 抓包），difficulty 可注入。 */
function challengeFetch(difficulty: unknown): ReturnType<typeof vi.fn> {
  const body = {
    code: 0,
    msg: '',
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: {
        challenge: {
          algorithm: 'DeepSeekHashV1',
          challenge: 'a'.repeat(64),
          salt: 'b'.repeat(16),
          signature: 'c'.repeat(64),
          difficulty,
          expire_at: Date.now() + 60_000, // 未过期（ms，> 1e12 走 ms 分支）
          expire_after: 0,
          target_path: '/api/v0/chat/completion',
        },
      },
    },
  };
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QD-R23 #2 · PoW difficulty 封顶（isPowDifficultyValid 守卫）', () => {
  // 守卫存在性负控（PM 裁，2026-11-07 07:3x）：
  // 旧码（HEAD）**没有**这两个导出 ⇒ 本组其余用例在旧码上是「调用不存在」而红
  // （`not a function`），**不是**「导出缺失 ⇒ 断言红」这个可读形态。
  // 这两枚把「守卫缺失」单独钉成一条断言负控：在旧码副本上实测为
  // `expected 'undefined' to be 'function'` / `expected undefined to be 2000000`，
  // **19ms、零 IO、零卡死**（PM 用 `git show HEAD:` 造旧码副本到临时目录实测，临时目录已清理；
  //  第 1 版探针因临时目录缺 `./pow-wasm` 收集期炸（`Tests no tests`）⇒ 作废，
  //  教训＝装置失败 ≠ 装置通过）。
  it('负控 0：守卫与上界是公开导出（负控能抓到「守卫缺失」这一形态）', () => {
    expect(typeof isPowDifficultyValid).toBe('function');
    expect(POW_DIFFICULTY_MAX).toBe(2_000_000);
  });

  it('正控：真实观测值 144000 过守卫（不拦合法值 ⇒ 行为与改前逐位一致）', () => {
    expect(isPowDifficultyValid(144000)).toBe(true);
    // 上界含端点
    expect(isPowDifficultyValid(POW_DIFFICULTY_MAX)).toBe(true);
    expect(isPowDifficultyValid(1)).toBe(true);
  });

  it('负控 1：超界值被拒（不是「大于某阈值」单一判据，是上界 + 合法整数联合）', () => {
    expect(isPowDifficultyValid(POW_DIFFICULTY_MAX + 1)).toBe(false);
    expect(isPowDifficultyValid(999_999_999)).toBe(false);
  });

  it('负控 2a：NaN 单独一条（NaN 过所有大小比较、必须显式拒，不能混进「超界」里一起断）', () => {
    expect(isPowDifficultyValid(Number.NaN)).toBe(false);
    // NaN 特证：它同时「不大于 MAX」也「不小于 0」，只有整数/有限判据能钉死
    expect(Number.NaN > 0).toBe(false);
    expect(Number.NaN < 0).toBe(false);
    expect(Number.isFinite(Number.NaN)).toBe(false);
  });

  it('负控 2b：Infinity / -Infinity 被拒（非有限）', () => {
    expect(isPowDifficultyValid(Infinity)).toBe(false);
    expect(isPowDifficultyValid(-Infinity)).toBe(false);
  });

  it('负控 2c：负数被拒', () => {
    expect(isPowDifficultyValid(-5)).toBe(false);
  });

  it('负控 2d：小数被拒（非整数）', () => {
    expect(isPowDifficultyValid(3.5)).toBe(false);
  });

  it('负控 2e：0 被拒（非正，对齐上游 `> 0`）', () => {
    expect(isPowDifficultyValid(0)).toBe(false);
  });
});

describe('QD-R23 #2 · 装置自检（负控真打在「上界拦截」层，非网络失败；注入层 = globalThis.fetch）', () => {
  it('超界 difficulty：fetch 确实发出（×1）+ challenge 确实被解析 + 抛上界码 pow-invalid-difficulty（不是「算不出」、不是网络错）', async () => {
    const fetchMock = challengeFetch(999_999_999);
    vi.stubGlobal('fetch', fetchMock);
    let err: unknown;
    try {
      await createPowHeaders({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined(); // 必须抛错（不是静默、不是进求解循环）
    expect((err as Error).message).toContain('pow-invalid-difficulty'); // 上界码，可辨识（非「No PoW solution found」）
    expect((err as Error).message).not.toContain('No PoW solution found'); // 不是「算不出」
    // 装置自检：请求确实发出（网络层注入点被真调到）+ challenge 确实被解析（走到了难度判据，不是 fetch 失败）
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('NaN difficulty：同样走 fetch 发出 + 上界拦截（证明非「fetch 失败」，而是难度判据拦下）', async () => {
    const fetchMock = challengeFetch(Number.NaN);
    vi.stubGlobal('fetch', fetchMock);
    let err: unknown;
    try {
      await createPowHeaders({});
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('pow-invalid-difficulty');
    expect(fetchMock).toHaveBeenCalledTimes(1); // 请求发出、challenge 解析、判据拦下
  });

  it('正控（集成层）：合法 difficulty 144000 过守卫、进 WASM 阶段（哨兵桩证「没被上界拦」，不真跑求解）', async () => {
    const fetchMock = challengeFetch(144000);
    vi.stubGlobal('fetch', fetchMock);
    // 哨兵：让 loadWasm 在 WASM 阶段就 reject（不真跑 144000 求解），用以证明「合法值过了上界守卫、已进求解阶段」。
    vi.stubGlobal('WebAssembly', { instantiate: vi.fn(async () => { throw new Error('wasm-sentinel'); }) });
    let err: unknown;
    try {
      await createPowHeaders({});
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain('wasm-sentinel'); // 走到了 WASM 阶段（= 上界守卫没拦 144000）
    expect((err as Error)?.message ?? '').not.toContain('pow-invalid-difficulty'); // 合法值绝不被当「难度非法」
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
