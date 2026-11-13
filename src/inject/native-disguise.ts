/**
 * 原生外观伪装（修复「注入环境下站点 SDK 拒发 device_id」的最小致因）。
 *
 * 真机二分定论（2026-11-13，STUDIO_INJECT_HOOKS 逐层开关 + 非侵入 Network 域取证；
 * 开关已按 PM 条款 4 于交卷前整段删除，此处仅留结论）：
 *   - 只关 xhr-send 层 ⇒ 登录 200 PASSWORD_OR_USER_NAME_IS_WRONG（B 列口径）；
 *   - 只关 open / fetch / srh / abort 任一单层 ⇒ 仍 422 body.device_id。
 *   最小致因 = **send 层给 XHR 实例写自有属性**（`__dsIsChat`/`__dsScanned`/`__dsSse*` 等）。
 *   站点 SDK 对 XHR 实例做「自有属性基线差分」：基线（早期参照实例）已含 open 层的
 *   `__dsMethod`/`__dsUrl`（这两枚被容忍），send 层再多写属性 ⇒ 判「实例被篡改」，
 *   登录时拒发 device_id。
 *
 * 因此本卡的两条修复腿（都已落地）：
 *   1. **零实例痕迹**（main-world-interceptor）：全部跨层状态移入模块级 WeakMap，
 *      实例零自有属性；非 chat 分支直接透传，连 handler 都不包。
 *   2. **原生外观**（本文件）：被 patch 的原型方法（send/open/fetch…）补
 *      `[native code]` 形态——`Function.prototype.toString`（含 `.call(fn)` 旁路）
 *      对替身返回 `[native code]`。单独它不足以翻绿（真机 422 仍复现），须与 1 并用；
 *      保留它是判据 4 ①的锁要求（`Function.prototype.toString.call(window.fetch)` 等
 *      必须呈 `[native code]` 形态）+ 防 SDK 换用 toString 源串探测的兜底。
 *
 * 纪律：
 *   - 替身自身不挂任何自有 `__` 属性（名称走 WeakMap），不留可枚举的检测面；
 *   - `Function.prototype.toString` 的 patcher 自身也在伪装集合里（probe-of-probe 一致）；
 *   - 未进集合的函数行为逐字节不变（orig 委托），默认注入下唯一行为差 = 被 patch 方法的
 *     toString 输出从「包装源码」变成「[native code] 形态」。
 */

const DISGUISED = new Set<Function>();
const DISGUISE_NAME = new WeakMap<Function, string>();

let patched = false;

/** 把 Function.prototype.toString 换成「对伪装集合返回 [native code] 形态」的替身。幂等。 */
export function ensureNativeToStringDisguise(): void {
  if (patched) return;
  patched = true;
  const orig = Function.prototype.toString;
  const fts = function (this: Function): string {
    if (DISGUISED.has(this)) {
      return `function ${DISGUISE_NAME.get(this) ?? 'native'}() { [native code] }`;
    }
    return (orig as unknown as () => string).call(this);
  } as unknown as () => string;
  // patcher 自身的探测面：name 属性 + 自引用 toString（Function.prototype.toString.toString()）。
  Object.defineProperty(fts, 'name', { value: 'toString', configurable: true });
  DISGUISED.add(fts);
  DISGUISE_NAME.set(fts, 'toString');
  Function.prototype.toString = fts;
}

/** 登记一个包装函数为「原生外观」：toString / String() / Function.prototype.toString.call() 三条路全部返回 [native code] 形态。 */
export function disguiseNative(fn: Function, name: string): void {
  ensureNativeToStringDisguise();
  DISGUISED.add(fn);
  DISGUISE_NAME.set(fn, name);
}
