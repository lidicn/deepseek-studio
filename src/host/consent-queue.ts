/**
 * K2（2026-11-09，审批重设计 v1 阶段一）：**待审批队列 + 回执驱动**。
 *
 * ── 为什么需要这个模块（通道的物理事实）──
 * 审批窗口是 **Rust 侧**的独立 Tauri webview（K1，`src-tauri/src/consent_window.rs`），
 * 而审批请求由 **node 宿主**发起。两者之间**没有 node→Rust 的上行 RPC**：
 * Rust 侧每 200ms 轮询 `GET /v1/consent/pending`，窗口内页面把用户选择 POST 回
 * `POST /v1/consent/reply`。所以 node 侧能做的只有一件事——
 * **登记一条待决，然后阻塞等回执**。写成"调用开窗"会落在一条不存在的通道上：
 * 测试里的 `options.nativeConsent` 桩能骗过去，真机却永远弹不出来。
 *
 * ── `shown` 的三来源（这是本模块最容易做错的地方）──
 * `desktop-host` 的越界支要求：**窗口不可用 ⇒ fail-closed deny，且必须能被区分出来**
 * （`shown=false` 走 `L2218-2220`，`shown=true` 走正常决议）。三种情况语义不同：
 *
 * | 情况 | 判据 | 结果 |
 * |---|---|---|
 * | 窗口没起 / 轮询线程没跑 | 登记后 `pollerGraceMs` 内**没有任何人轮询** | `{ shown:false, decision:'deny' }` |
 * | 窗口起了、用户没答 | 有人轮询过，但到 `timeoutMs` 仍无回执 | `{ shown:true,  decision:'deny' }` |
 * | 用户答了 | `POST /v1/consent/reply` 校验通过 | `{ shown:true,  decision }` |
 *
 * 前两种都**必须是 deny**。任何"超时算允许"的写法都直接判红（`L2164` 那条不变量会变成假话）。
 *
 * ── 另外三条不变量（都有测试钉住）──
 *  1. **nonce 一次性 + 常数时间比对**。回执缺 nonce／不等／已消费 ⇒ 忽略，
 *     请求保持挂起直到超时（伪造方即便知道 callId 也拿不出已消费的 nonce）。
 *  2. **结算幂等**。同一条请求只会被结算一次；迟到的回执（超时之后）**不改结论**。
 *  3. **`pending()` 不含 nonce 之外的秘密**——它只回窗口需要渲染的那份视图 + nonce。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConsentDecision } from '../shared/consent-contract';

/** 一次待审批请求里，会送到窗口页面的那部分。 */
export interface PendingConsentView {
  readonly callId: string;
  readonly tool: string;
  /** 参数摘要（已截断）。 */
  readonly summary: string;
  /** 风险原因（人类可读）；非越界高风险为空串。 */
  readonly riskReason: string;
  /** 当前档位（full / auto / ask / workspace）。 */
  readonly mode: string;
  /** 规范目标描述（路径 / argv / memory id）。 */
  readonly target: string;
  /** **是否越界**——窗口上必须显形，这是本设计最想让用户看见的一格。 */
  readonly outside: boolean;
  /** 允许的按钮集合（宿主侧确认只给 allow-once / deny，长时效回页内模态）。 */
  readonly allowedDecisions: readonly ConsentDecision[];
  /** 登记时刻（epoch ms），窗口可用于展示"等了多久"。 */
  readonly requestedAt: number;
}

export interface PendingConsentEntry {
  readonly view: PendingConsentView;
  /** 回执必须带回的一次性随机串（16 字节 hex）。 */
  readonly nonce: string;
}

/** 宿主侧确认的结果。`shown` 的语义见文件头那张表。 */
export interface HostConsentOutcome {
  readonly shown: boolean;
  readonly decision: ConsentDecision;
}

export interface ConsentQueueOptions {
  /** 等待用户答复的总预算（毫秒）。到点一律 `deny`。 */
  readonly timeoutMs: number;
  /**
   * 判断"轮询线程在跑"的宽限（毫秒）。K1 的轮询间隔是 200ms，
   * 取 3 个周期即可区分"没人轮询"与"刚启动还没轮到"。
   */
  readonly pollerGraceMs?: number;
  /** 时钟注入（测试用）。 */
  readonly now?: () => number;
}

/** 回执处理结果（HTTP 端点据此决定状态码）。 */
export type ReplyOutcome =
  | { readonly ok: true; readonly decision: ConsentDecision }
  | { readonly ok: false; readonly code: 'unknown-call' | 'bad-nonce' | 'bad-decision' };

export interface ConsentQueue {
  /**
   * 登记一条待审批并返回**挂起**的 Promise —— 这正是"停在 `ctx.ask` 那一行"的实现形态。
   */
  request(view: Omit<PendingConsentView, 'requestedAt'>): Promise<HostConsentOutcome>;
  /** 当前待审批（供 Rust 轮询）。**每次调用都会刷新"轮询在跑"的时间戳**。 */
  pending(): readonly PendingConsentEntry[];
  /** 窗口回执。nonce 校验不过**不结算**（保持挂起，最终由超时兜底）。 */
  reply(input: { callId: unknown; decision: unknown; nonce: unknown }): ReplyOutcome;
  /** 当前挂起条数（测试与诊断用）。 */
  size(): number;
  /** 结算全部挂起为 deny（宿主停止 / 页端断开）。 */
  drain(): void;
}

const ALLOWED_DECISIONS: readonly ConsentDecision[] = [
  'allow-once',
  'deny',
  'allow-session',
  'allow-conversation',
];

export function isConsentDecision(v: unknown): v is ConsentDecision {
  return typeof v === 'string' && (ALLOWED_DECISIONS as readonly string[]).includes(v);
}

/** 16 字节随机 nonce（hex，无填充）。与 page-runtime 的 `randomConsentNonce` 同规格。 */
function randomNonce(): string {
  return randomBytes(16).toString('hex');
}

/** 常数时间字符串比较（长度不同直接 false）。 */
function nonceEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface Slot {
  entry: PendingConsentEntry;
  consumed: boolean;
  settled: boolean;
  /** 是否已观察到轮询在跑（决定超时时的 `shown`）。 */
  polled: boolean;
  settle: (outcome: HostConsentOutcome) => void;
  hardTimeout: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

export function createConsentQueue(options: ConsentQueueOptions): ConsentQueue {
  const now = options.now ?? (() => Date.now());
  const pollerGraceMs = options.pollerGraceMs ?? 600;
  const slots = new Map<string, Slot>();

  /** 结算并清理。**幂等**——已结算过的直接忽略（迟到回执改不动结论）。 */
  function settle(callId: string, outcome: HostConsentOutcome): void {
    const slot = slots.get(callId);
    if (!slot || slot.settled) return;
    slot.settled = true;
    slots.delete(callId);
    clearTimeout(slot.hardTimeout);
    if (slot.graceTimer) clearTimeout(slot.graceTimer);
    slot.settle(outcome);
  }

  function unref(t: unknown): void {
    // 审批等待不该拦住进程正常退出。
    if (t && typeof t === 'object' && 'unref' in t) (t as { unref?: () => void }).unref?.();
  }

  return {
    request(view) {
      const callId = view.callId;
      const nonce = randomNonce();
      const entry: PendingConsentEntry = { view: { ...view, requestedAt: now() }, nonce };
      return new Promise<HostConsentOutcome>((resolve) => {
        const hardTimeout = setTimeout(() => {
          // 不变量：超时 ⇒ deny。`shown` 取决于"有没有人轮询过"：
          // 轮询过 = 窗口起了但用户没答（shown:true）；没轮询过 = 窗口/轮询线程不在（shown:false）。
          const slot = slots.get(callId);
          settle(
            callId,
            slot?.polled ? { shown: true, decision: 'deny' } : { shown: false, decision: 'deny' },
          );
        }, options.timeoutMs);
        unref(hardTimeout);

        const slot: Slot = {
          entry,
          consumed: false,
          settled: false,
          polled: false,
          settle: resolve,
          hardTimeout,
        };
        slots.set(callId, slot);

        // 宽限窗：到期仍无人轮询 ⇒ 窗口/轮询线程没跑 ⇒ 立刻按 shown:false 收口，
        // 不必让调用方白等满 timeoutMs（那正是卡 J 注释里说的"白等一个超时"）。
        const graceTimer = setTimeout(() => {
          const s = slots.get(callId);
          if (s && !s.polled) settle(callId, { shown: false, decision: 'deny' });
        }, pollerGraceMs);
        unref(graceTimer);
        slot.graceTimer = graceTimer;
      });
    },

    pending() {
      // 每次被轮询 = 一次"窗口侧活着"的证据。
      for (const slot of slots.values()) slot.polled = true;
      return [...slots.values()].map((s) => s.entry);
    },

    reply(input) {
      if (typeof input.callId !== 'string') return { ok: false, code: 'unknown-call' };
      const slot = slots.get(input.callId);
      if (!slot || slot.settled) return { ok: false, code: 'unknown-call' };
      if (!isConsentDecision(input.decision)) return { ok: false, code: 'bad-decision' };
      // 不变量：nonce 一次性 + 常数时间相等。校验不过**不结算**。
      if (typeof input.nonce !== 'string' || slot.consumed || !nonceEqual(input.nonce, slot.entry.nonce)) {
        return { ok: false, code: 'bad-nonce' };
      }
      slot.consumed = true;
      settle(input.callId, { shown: true, decision: input.decision });
      return { ok: true, decision: input.decision };
    },

    size() {
      return slots.size;
    },

    drain() {
      for (const callId of [...slots.keys()]) {
        settle(callId, { shown: false, decision: 'deny' });
      }
    },
  };
}
