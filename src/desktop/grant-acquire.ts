/**
 * 取券器（P0 卡 (A) 页端半，2026-11-06 裁定三十一/三十三/三十六/四十一）：
 * 页面每次连接/重连前，向宿主**现取一张** 60s/一次性/绑 aud 的 bootstrap grant。
 *
 * 契约（裁定三十三定稿，Rust 半由 Core 实现，两边同笔入库）：
 * - 取券入口 = Rust 注入闭包 `window.__studioRequestGrant(aud)`（远端页面拿不到裸 `invoke`）；
 *   返回**可辨识联合**（禁可选字段形态——`ok:true` 但字段缺失的隐式契约就是 fillPathRows
 *   那个坑的同族）：
 *     { ok: true;  grant: string; expMs: number }
 *     { ok: false; error: GrantError }
 * - `GrantError` 六枚举：`no-config` / `no-secret` / `sign-failed` / `bad-aud` / `host-down`
 *   / `rate-limited`。
 *
 * 页端纪律（裁定四十一 @UI 半）：
 * 1. **每次连接/重连前无条件现取新券**（不试旧券、不缓存）——`consumed`/`expired`
 *    结构上不再发生（L2/H1 消除）；
 * 2. **单飞**：同窗口并发（连接 + 重连 + 面板拉取同时触发）只发一次 IPC，复用 in-flight；
 * 3. **裁定三十六退避**：仅 `no-config` 可重试（首启竞态窗口：config.json 刚写完就取），
 *    指数退避 500ms→1s→2s→4s→8s（5 次重试、总预算 ~15.5s，覆盖实测 5s 竞态窗口留 3 倍余量）；
 *    `rate-limited` **一律停**（宿主明确拒绝续签，重试只会打爆限流）；
 *    `no-secret/sign-failed/bad-aud/host-down` 四支按不可重试回落（各带自己的日志行，不共用）；
 * 4. **耗尽才回落**：预算耗尽/不可重试错误 → 回落既有 URL（静态 grant 或裸连，仅 dev 合法），
 *    且回落**必须 fail-visible**（裁定三十二：调用方给可见提示，宿主侧一行可 grep 日志）；
 * 5. 闭包缺失（dev 形态/旧构建）→ 不碰按需取券路径，立即回落，**零等待、行为与改前一致**。
 */

export type GrantError =
  | 'no-config'
  | 'no-secret'
  | 'sign-failed'
  | 'bad-aud'
  | 'host-down'
  | 'rate-limited';

/** 可辨识联合：`ok:true` 分支字段必有、`ok:false` 分支 error 必有（编译期挡「ok:true 无 data」形态）。 */
export type GrantReply =
  | { ok: true; grant: string; expMs: number }
  | { ok: false; error: GrantError };

export type RequestGrantFn = (aud: string) => Promise<GrantReply>;

/** 裁定三十六：5 次重试（首试不计），总预算 500+1000+2000+4000+8000 = 15.5s。 */
export const GRANT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

/** 唯一可重试错误（首启竞态：宿主正在写 config.json）。其余一律不重试。 */
const RETRYABLE: ReadonlySet<GrantError> = new Set<GrantError>(['no-config']);

export interface GrantAcquireOptions {
  /** 与 Rust 签发口径逐字一致：`main` 或 `bot:<id>`。 */
  aud: string;
  /** 测试注入；缺省读 `globalThis.__studioRequestGrant`（Rust 注入闭包）。 */
  requestGrant?: RequestGrantFn | null;
  /** 测试注入；缺省 `GRANT_BACKOFF_MS`（传空数组 = 不重试）。 */
  backoffMs?: readonly number[];
  /** 可见状态钩子（裁定三十二：退避期间必须可见，不许静默等）：
   *  start = 本轮取券开始（含退避窗口）；attempt = 每次 IPC 回执后。结果由 Promise 给调用方。 */
  onState?: (state: 'start' | 'attempt', detail?: GrantReply) => void;
}

export interface GrantAcquireResult {
  /** 取到的券；null = 回落（闭包缺失 / 不可重试 / 预算耗尽）。 */
  grant: string | null;
  /** 本次共发了几次 IPC（0 = 闭包缺失，根本没进按需取券路径）。 */
  attempts: number;
  /** 回落原因（`attempts>0` 时必有）。 */
  lastError?: GrantError;
  /** 券的过期时刻（宿主报的 expMs；回落时为 undefined）。 */
  expMs?: number;
  /**
   * 裁定五十七 缺陷③（P0，v0.14.8 真机）：闭包**抛错 / 形状违例**时的**原文**原因
   * （如 `Command studio_request_grant not allowed by ACL`）。
   *
   * 宿主侧**结构上拿不到**这类失败——ACL / IPC 层拒绝发生在 Rust 函数执行**之前**，
   * (C) 的四分支日志 / GrantError 六枚举 / `grant_log` 全部被绕过。所以页端必须捕获
   * 原文，由调用方（entry.ts）写进可见横幅 + 页端可 grep 痕迹（`window.__studioGrantStatus`
   * + `console.error`）。`host-down` 的「停止、不重试」语义**不变**（本字段只补可见性）。
   *
   * 裁定五十八（0.14.9 必做）：取券**枚举失败回落**（非闭包抛错，如 `no-config` 退避耗尽 /
   * `rate-limited` / …）也**必带本字段** = 稳定字面量 `GRANT_FALLBACK_BARE_URL_CAUSE`
   * （`grant-fallback-bare-url`），指向「没拿到券所以裸连」，与 Core 侧 `host-token.ts` 的
   * `absent` reason 成对（宿主日志 `invalid bootstrap grant (absent)` ⇄ 页端 cause 该字面量）。
   * 负控：不许只留枚举 / 泛化 host-down。
   */
  cause?: string;
}

function readStudioRequestGrant(): RequestGrantFn | null {
  const fn = (globalThis as { __studioRequestGrant?: unknown }).__studioRequestGrant;
  return typeof fn === 'function' ? (fn as RequestGrantFn) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 裁定五十八（0.14.9 必做，Core 字符串契约）：取券失败（枚举，非闭包抛错）→ 页面回落**裸 URL**
 * 时，`__studioGrantStatus.cause` 必须写**稳定可 grep 字面量**（不是泛化 host-down、不是自由句式）。
 *
 * 与 Core 侧 `host-token.ts` 的 `absent` reason **成对**（两边各说各的、指同一件事＝ACL 已修好但
 * 取券失败导致裸连）：
 *   - 页端：`__studioGrantStatus.cause === GRANT_FALLBACK_BARE_URL_CAUSE`；
 *   - 宿主：sidecar 日志 `invalid bootstrap grant (absent)`（`host-token.ts` `presented` 为空 ⇒ `absent`）。
 * **改这一边必须同时改 Core 的 `absent` 侧配对断言**（tests/desktop/td02-bootstrap-grant.test.ts），
 * 别让下一个人只改一边（PM 裁定五十八 明令）。
 *
 * **三形态判读表**（0.14.9 现场 CDP 直读 `__studioGrantStatus`，按 `cause` 内容互斥可判）：
 *
 *   | `cause`                                  | 判读 |
 *   |------------------------------------------|------|
 *   | 含 `not allowed by ACL`（IPC 原文）       | 缺陷① 未修（IPC 层拒绝，Rust 未执行、宿主日志全被绕过） |
 *   | `grant-fallback-bare-url`                | ACL 已修、取券失败致裸连（宿主侧对应 `absent`） |
 *   | `grant-reply-shape-violation`（见下方常量） | 宿主回了非可辨识联合 ⇒ **宿主/页端版本不配对**（先核宿主版本号） |
 *
 * 负控（PM 原话）：`no-config` 退避耗尽 → `cause` 必非空且指向回落，不许只留枚举。
 */
export const GRANT_FALLBACK_BARE_URL_CAUSE = 'grant-fallback-bare-url';

/**
 * 裁定五十八 P3（形状违例稳定字面量）：取券闭包**正常返回但形状违反可辨识联合**
 * （`ok:true` 缺字段 / 非对象）时的 `cause`——**既非** ACL（① 原文）、**也非**枚举回落（② 字面量），
 * 而是宿主回了非可辨识联合 ⇒ **宿主/页端版本不配对**（宿主旧构建返回旧形状，或页端契约漂移改了闭包形状）。
 * 用稳定字面量而非自由句式，使 0.14.9 现场 CDP 直读可 grep 判定（与 `GRANT_FALLBACK_BARE_URL_CAUSE` 同族契约）。
 * 横幅文案须与 ①② 两形态**互异**（否则现场分不清）。
 */
export const GRANT_REPLY_SHAPE_VIOLATION_CAUSE = 'grant-reply-shape-violation';

/** 单飞表：同 aud 并发只发一次 IPC（重连/连接/面板拉取撞车时复用 in-flight，不自造请求风暴打红自己的限流）。
 *  结算即摘除——**不缓存结果**：下一轮连接/重连无条件现取新券（纪律 1）。 */
const inFlight = new Map<string, Promise<GrantAcquireResult>>();

export function acquireGrant(opts: GrantAcquireOptions): Promise<GrantAcquireResult> {
  const existing = inFlight.get(opts.aud);
  if (existing) return existing;

  const task: Promise<GrantAcquireResult> = (async (): Promise<GrantAcquireResult> => {
    const fn = opts.requestGrant !== undefined ? opts.requestGrant : readStudioRequestGrant();
    if (!fn) {
      // dev 形态 / 旧构建：无注入闭包 → 不进按需取券路径（零等待、零提示），回落既有语义。
      return { grant: null, attempts: 0 };
    }
    opts.onState?.('start');
    const backoff = opts.backoffMs ?? GRANT_BACKOFF_MS;
    for (let attempt = 0; ; attempt += 1) {
      let reply: GrantReply;
      try {
        reply = await fn(opts.aud);
      } catch (e) {
        // 闭包自身抛错 = 契约违反（宿主侧只该返回 {ok:false,error}）：按 host-down 停，不重试。
        // 裁定五十七 缺陷③：ACL / IPC 层拒绝（`Command … not allowed by ACL`）就落在这里——
        // Rust 函数根本没执行、宿主侧日志全被绕过。把**原文**捕获进 cause，页端 fail-visible
        // 依赖它（横幅 + 页端可 grep 痕迹）；停止不重试的语义不变。
        const cause = e instanceof Error ? e.message : String(e);
        opts.onState?.('attempt', { ok: false, error: 'host-down' });
        return { grant: null, attempts: attempt + 1, lastError: 'host-down', cause };
      }
      if (!reply || typeof reply !== 'object' || !('ok' in reply)) {
        // 返回形状违反可辨识联合（旧宿主/拼写漂移）：不猜、不静默，按 host-down 停。
        // 裁定五十八 P3：稳定字面量（宿主/页端版本不配对的信号），页端 fail-visible 可 grep。
        opts.onState?.('attempt');
        return {
          grant: null,
          attempts: attempt + 1,
          lastError: 'host-down',
          cause: GRANT_REPLY_SHAPE_VIOLATION_CAUSE,
        };
      }
      opts.onState?.('attempt', reply);
      if (reply.ok) {
        return { grant: reply.grant, attempts: attempt + 1, expMs: reply.expMs };
      }
      if (!RETRYABLE.has(reply.error)) {
        // rate-limited / no-secret / sign-failed / bad-aud / host-down：停，不重试。
        // 裁定五十八：回落裸连必带稳定 cause（与宿主 absent 成对），不只留枚举。
        return { grant: null, attempts: attempt + 1, lastError: reply.error, cause: GRANT_FALLBACK_BARE_URL_CAUSE };
      }
      const wait = backoff[attempt];
      if (wait === undefined) {
        // 预算耗尽（裁定三十六 5 次）：回落 + 调用方 fail-visible。
        // 裁定五十八：no-config 退避耗尽也回落裸连 → 稳定 cause（负控：不许只留 no-config 枚举）。
        return { grant: null, attempts: attempt + 1, lastError: reply.error, cause: GRANT_FALLBACK_BARE_URL_CAUSE };
      }
      await sleep(wait);
    }
  })();

  inFlight.set(opts.aud, task);
  return task.finally(() => {
    if (inFlight.get(opts.aud) === task) inFlight.delete(opts.aud);
  });
}
