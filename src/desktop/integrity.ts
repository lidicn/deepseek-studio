/**
 * 页面完整性探测（v0.5 5.4，R2 缓解）
 *
 * 风险原点：注入脚本与页面脚本**同域同 world**，页面 JS 完全可以覆写
 * `window.__deepseekStudio`，把后续的授权/派发/同意流程接到自己的实现上。
 *
 * 探测方式：装配完成时拍一张「引用快照」，之后周期比对：
 *   - 对象被删除 / 被整体替换；
 *   - 关键成员被替换成别的函数或对象；
 *   - 属性描述符被改成可写可配置（说明有人准备动手）。
 * 任一命中即上报宿主，由宿主把该页标记为不可信并停止派发工具（fail-closed 降级）。
 *
 * 注意定位：这是**检测**而非**阻止**。同域脚本总能找到办法绕过纯 JS 防护，
 * 真正的边界是「宿主不再信任这个页面」，所以本模块必须与宿主的降级联动才有效。
 */

export type IntegrityViolation =
  | 'removed'
  | 'replaced'
  | 'member-replaced'
  | 'descriptor-downgraded'
  | 'member-missing';

export interface IntegrityAlert {
  readonly reason: IntegrityViolation;
  readonly detail?: string;
}

export interface IntegrityProbeOptions {
  /** 读取被保护对象（默认 window.__deepseekStudio）。 */
  read?: () => unknown;
  /** 关键成员名（默认 bridge / host / authority / sessionId）。 */
  members?: readonly string[];
  /** 探测周期（毫秒），默认 5000。 */
  intervalMs?: number;
  /** 违规回调（只触发一次，避免刷屏）。 */
  onViolation: (alert: IntegrityAlert) => void;
  /** 计时器注入点（测试用）。 */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface IntegrityProbe {
  /** 立即执行一次检查（测试与手动触发）。 */
  check(): IntegrityAlert | null;
  stop(): void;
}

export const DEFAULT_MEMBERS: readonly string[] = ['bridge', 'host', 'authority', 'sessionId'];
export const DEFAULT_INTERVAL_MS = 5_000;

const STUDIO_KEY = '__deepseekStudio';

function defaultRead(): unknown {
  const w = (globalThis as { window?: unknown }).window ?? globalThis;
  return (w as Record<string, unknown>)[STUDIO_KEY];
}

/**
 * 尽量把对象钉死为不可写不可配置。宿主页面若已自行定义则保持现状（不抢），
 * 失败静默——降级靠探测而非靠这一步。
 */
export function freezeStudioObject(): boolean {
  try {
    const w = (globalThis as { window?: unknown }).window ?? globalThis;
    const target = w as Record<string, unknown>;
    const existing = target[STUDIO_KEY];
    if (!existing) return false;
    const desc = Object.getOwnPropertyDescriptor(target, STUDIO_KEY);
    if (desc && desc.configurable === false) return true;
    Object.defineProperty(target, STUDIO_KEY, {
      value: existing,
      writable: false,
      configurable: false,
      enumerable: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function startIntegrityProbe(options: IntegrityProbeOptions): IntegrityProbe {
  const read = options.read ?? defaultRead;
  const members = options.members ?? DEFAULT_MEMBERS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  const initial = read();
  const snapshot = new Map<string, unknown>();
  if (initial && typeof initial === 'object') {
    for (const m of members) {
      snapshot.set(m, (initial as Record<string, unknown>)[m]);
    }
  }

  // 记录启动时属性是否本就被钉死。descriptor 探测只在「初始就冻结」时才有意义：
  // 默认不冻结（entry.ts freezeStudio=false），此时普通 writable/configurable 描述符是
  // 合法初始态，不能判成被篡改——否则每次页面加载后第一个探测周期必然误报
  // descriptor-downgraded → 宿主把页面永久降级 → chat-read/insert/send 全部派不出去。
  let initialFrozen = false;
  try {
    const w0 = (globalThis as { window?: unknown }).window ?? globalThis;
    const d0 = Object.getOwnPropertyDescriptor(w0 as object, STUDIO_KEY);
    initialFrozen = !!d0 && d0.configurable === false && d0.writable === false;
  } catch {
    /* 读不到不视为违规 */
  }

  let fired = false;
  let stopped = false;

  function detect(): IntegrityAlert | null {
    const current = read();
    if (current === undefined || current === null) return { reason: 'removed' };
    if (current !== initial) return { reason: 'replaced' };

    const bag = current as Record<string, unknown>;
    for (const m of members) {
      if (!(m in bag)) return { reason: 'member-missing', detail: m };
      if (bag[m] !== snapshot.get(m)) return { reason: 'member-replaced', detail: m };
    }

    // 描述符被放宽 = 有人为后续覆写做准备，属于明确的攻击前奏。
    // 仅在启动时属性本就被钉死的前提下才检查（见 initialFrozen 说明）。
    if (initialFrozen) {
      try {
        const w = (globalThis as { window?: unknown }).window ?? globalThis;
        const desc = Object.getOwnPropertyDescriptor(w as object, STUDIO_KEY);
        if (desc && (desc.configurable !== false || desc.writable !== false)) {
          return { reason: 'descriptor-downgraded' };
        }
      } catch {
        /* 读不到描述符不视为违规 */
      }
    }
    return null;
  }

  const timer = setIntervalFn(() => {
    if (stopped || fired) return;
    const alert = detect();
    if (alert) {
      fired = true;
      options.onViolation(alert);
    }
  }, intervalMs);

  return {
    check() {
      const alert = detect();
      if (alert && !fired) {
        fired = true;
        options.onViolation(alert);
      }
      return alert;
    },
    stop() {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
