/**
 * 单轮工具调用「串行护栏」（2026-11-20 卡 ㊿-b ①）。
 *
 * ── 为什么需要它（现场）──
 * 装版真机一轮里出现过：`local_file_read{smoke_out.log}` 与 `local_file_read{_core_gates.log}`
 * 两枚**不同参数**的调用并发执行（start dt=10494／10600，result dt=10752／10758）。
 * 页端 `tool-call-dedupe` 只拦**同名同参**（`claimSignature`），签名不同就放行 ⇒
 * 两个都并发跑。读类并发只是浪费，**写类／执行类并发是数据风险**：
 * `file.edit`／`file.write` 并发同一文件＝两次读改写交错＝静默丢改动。
 *
 * ── 与「签名去重」的分工（别混）──
 * - `src/shared/tool-call-dedupe.ts`：**按流**重置，拦「同一条流被重复解析」的重复投递；
 *   它头注释 N2-03 明确写了「跨流同签名＝合法重跑」，那条口径**不许动**。
 * - 本护栏：**按 turn（用户回合）**重置 —— 完全不碰 `resetSignatures` 的时机，
 *   也不改流内去重语义。它管的是「同一轮里多个调用同时要执行」这一层。
 *
 * ── 策略（卡面既定）──
 * 1. 同一 turn 内**同时最多一个在跑**；按到达顺序串行。
 * 2. **写类／执行类**在并发到达时**不排队**：直接拒绝，回可行动回执（带 `terminate: true`），
 *    让模型在当前这枚结束后重发 —— 因为「等一会儿再写」与「读缺最新内容再写」是两件事。
 * 3. **只读类**并发到达 → 排队等待，轮到后照常执行（按出现顺序）。
 * 4. 同一 (tool+params) 在本轮**已有结果**且**此后没有发生过任何变更类调用** → 熔断，
 *    回执前缀沿用 `duplicate-tool-signature:`（跨席耦合：`extractFailureCode` 认这个前缀，
 *    **不许改措辞**）。中间若有变更类调用（读→写→再读同一文件），则**放行**：
 *    那是合法复查，不是重复。
 */

/** 并发到达时的拒绝码。用 `-` 分隔，与仓内既有机器码同形。 */
export type TurnGuardRejectCode =
  | 'concurrent-mutation-blocked'
  | 'turn-concurrent-queue-full'
  | 'duplicate-tool-signature';

export type TurnGuardDecision =
  | { readonly kind: 'run'; readonly release: () => void }
  | {
      readonly kind: 'reject';
      readonly code: TurnGuardRejectCode;
      readonly message: string;
      readonly terminate: true;
    };

export interface TurnGuardAcquireInput {
  /** 本轮键：`<conversationId>|<turnId>`（没有 turnId 时用 `<conversationId>|no-turn`）。 */
  readonly key: string;
  /** 工具名（只用于回执文案与签名）。 */
  readonly tool: string;
  /** `tool + 稳定序列化参数`（同 tool-call-dedupe 的签名语义，但本类自己算，互不共享状态）。 */
  readonly signature: string;
  /** 写类／执行类＝true。并发到达时直接拒绝，不排队。 */
  readonly mutating: boolean;
  /**
   * 同签名重复熔断开关。缺省 true。
   *
   * 为什么要有 false：没有 turn 身份（`no-turn` 退化键）时**不存在「本轮」这个概念**
   * ——`completed` 记忆永不重置，熔断会把宿主内部路径（HTTP toolExecutor／dispatch／
   * 多 bot 各自的 invokeTool，全部共享 `host-agent|no-turn`）里**第二次完全相同的合法
   * 调用**误杀成重复（page-runtime-multibot 两枚 echo 就是这么红的）。所以：
   * turnId 读得到 ⇒ 熔断开（「本轮已执行过」有明确边界）；读不到 ⇒ 熔断关、仍串行。
   */
  readonly dedupe?: boolean;
  /**
   * 卡 P2-a（验收提案 2026-11-20）：**HTTP 边界单调到达序**（可选，缺省按 acquire 完成序）。
   *
   * 现场缺口（验收 cell12）：`acquire` 在 consent／turnId 两条 await **之后**才被调，
   * 异步链完成序 ≠ HTTP 到达序 ⇒ 紧突发下后到者先拿执行权（fifo_interval_ms=−7069）。
   * 安全不变量没破（至多一枚在飞、写类直拒），破的是「按到达顺序串行」这条卡面语义。
   *
   * 修法（PM 裁死口径）：调用方在**先于任何 await** 的边界取每实例单调序号传进来；
   * 排队出队**按序号升序**放行，不再按 waiters.push 顺序。缺省 undefined＝旧行为
   * （acquire 完成序），既有调用与测试零改动。
   */
  readonly arrivalSeq?: number;
}

export interface TurnSerialGuardOptions {
  /**
   * 同一 turn 内**只读**调用排队上限。超过即拒绝（fail-closed），
   * 防止模型一口气发几十个标签把队列撑爆。
   */
  readonly maxQueued?: number;
  /** 同时保留多少个 turn 的「已完成签名」记忆（LRU 淘汰；缺省 64）。 */
  readonly maxTurns?: number;
}

export interface TurnSerialGuardStats {
  /** 当前有 in-flight 或排队项的 turn 数。 */
  readonly activeTurns: number;
  /** 当前在跑的数量（全局）。 */
  readonly inFlight: number;
}

export interface TurnSerialGuard {
  acquire(input: TurnGuardAcquireInput): Promise<TurnGuardDecision>;
  stats(): TurnSerialGuardStats;
  /** 换对话 / 宿主停止时清空（清空后所有等待中的 acquire 一律以排队超限拒绝收口，不留悬空）。 */
  reset(): void;
}

/** 排队项最多等多久（毫秒）。超时按 `turn-concurrent-queue-full` 拒绝，绝不静默挂起。 */
const QUEUE_WAIT_TIMEOUT_MS = 60_000;

interface TurnState {
  inFlight: boolean;
  /** 变更类调用的代数：每完成一次变更类调用 +1（用于判定「重复」是否合法复查）。 */
  mutationEpoch: number;
  /** 本轮已完成调用的签名 → 完成时的 mutationEpoch。 */
  completed: Map<string, number>;
  /** FIFO 等待队列。 */
  waiters: Array<{
    resolve: (decision: TurnGuardDecision) => void;
    timer: ReturnType<typeof setTimeout>;
    /** 轮到它时用于登记「已完成的签名」。 */
    signature: string;
    mutating: boolean;
    /** 卡 P2-a：HTTP 边界到达序号（undefined = 旧形态，按 push 序出队）。 */
    arrivalSeq?: number;
  }>;
}

export function createTurnSerialGuard(options: TurnSerialGuardOptions = {}): TurnSerialGuard {
  const maxQueued = options.maxQueued ?? 16;
  /** 同时保留多少个 turn 的「已完成签名」记忆。超出按最久未用淘汰（不会淘汰在跑的）。 */
  const maxTurns = options.maxTurns ?? 64;
  const turns = new Map<string, TurnState>();
  let inFlight = 0;
  let generation = 0;

  const stateOf = (key: string): TurnState => {
    let st = turns.get(key);
    if (st) {
      // 命中即刷新 LRU 顺序（Map 保序：删了再插即到队尾）。
      turns.delete(key);
      turns.set(key, st);
      return st;
    }
    st = { inFlight: false, mutationEpoch: 0, completed: new Map(), waiters: [] };
    turns.set(key, st);
    // 淘汰：从队首找第一个既不在跑、也没有排队者的 turn。
    if (turns.size > maxTurns) {
      for (const [oldKey, oldSt] of turns) {
        if (oldKey === key) break;
        if (!oldSt.inFlight && oldSt.waiters.length === 0) {
          turns.delete(oldKey);
          break;
        }
      }
    }
    return st;
  };

  /**
   * ⚠️ **不要在这里删 turn**：`completed` 是「本轮已执行签名」的唯一记忆，
   * 执行完就删会让「同签名重复熔断」永远失效（本文件测试首轮就抓到过）。
   * 只在 reset() 或 LRU 淘汰时清理。
   */
  const cleanup = (_key: string, _st: TurnState): void => {
    /* 故意留空：见上面的注释 */
  };

  /** 把执行权交给下一个等待者（若有）。
   *  卡 P2-a：排队段按**到达序号升序**出队（arrivalSeq 小者先），不再按 push 序——
   *  异步链完成序≠HTTP 到达序，紧突发下 push 序会把后到者排前面。 */
  const handoff = (key: string, st: TurnState): void => {
    if (st.waiters.length === 0) {
      st.inFlight = false;
      cleanup(key, st);
      return;
    }
    let pick = 0;
    for (let i = 1; i < st.waiters.length; i += 1) {
      const w = st.waiters[i];
      const best = st.waiters[pick];
      if (w.arrivalSeq !== undefined && (best.arrivalSeq === undefined || w.arrivalSeq < best.arrivalSeq)) {
        pick = i;
      }
    }
    const next = st.waiters.splice(pick, 1)[0];
    clearTimeout(next.timer);
    // 直接把它标成在跑（inFlight 保持 true，不出现空窗）。
    next.resolve({ kind: 'run', release: makeRelease(key, st, next.signature, next.mutating) });
  };

  const makeRelease = (
    key: string,
    st: TurnState,
    signature: string,
    mutating: boolean,
  ): (() => void) => {
    let released = false;
    return () => {
      if (released) return; // 幂等：调用方在 finally 里再调一次也无害
      released = true;
      // 先（变更类）推进代数再登记签名：
      //   · 变更类：登记在新代数上 ⇒ 同一写调用重复发一次会被判「重复」；
      //   · 只读类：登记在当前代数 ⇒ 中间发生过变更后重读同一目标是**合法复查**（代数已变）。
      if (mutating) st.mutationEpoch += 1;
      st.completed.set(signature, st.mutationEpoch);
      inFlight = Math.max(0, inFlight - 1);
      handoff(key, st);
    };
  };

  return {
    async acquire(input) {
      const st = stateOf(input.key);
      const myGeneration = generation;

      // ① 重复熔断：本轮已有结果，且此后没有发生变更类调用。
      //    `dedupe === false`（no-turn 退化键）时整段跳过——见 TurnGuardAcquireInput 的注释。
      const priorEpoch = input.dedupe === false ? undefined : st.completed.get(input.signature);
      if (priorEpoch !== undefined && priorEpoch === st.mutationEpoch) {
        return {
          kind: 'reject',
          code: 'duplicate-tool-signature',
          terminate: true,
          message:
            `duplicate-tool-signature: 本轮已经执行过完全相同的调用（${input.tool}），` +
            '结果已在上文。不要重复调用；如需最新内容请说明「要复查」并等待本轮结束。',
        };
      }

      // ② 并发到达。
      if (st.inFlight) {
        if (input.mutating) {
          return {
            kind: 'reject',
            code: 'concurrent-mutation-blocked',
            terminate: true,
            message:
              `concurrent-mutation-blocked: 本轮还有调用在执行，写类/执行类调用（${input.tool}）` +
              '**未被执行**。等上一条结果返回后再发一次；不要并发写同一目标。',
          };
        }
        if (st.waiters.length >= maxQueued) {
          return {
            kind: 'reject',
            code: 'turn-concurrent-queue-full',
            terminate: true,
            message:
              `turn-concurrent-queue-full: 本轮排队已满（${maxQueued}），${input.tool} **未被执行**。` +
              '请减少同一轮的并发标签数量。',
          };
        }
        // 只读：排队（FIFO），轮到后执行。
        const decision = await new Promise<TurnGuardDecision>((resolve) => {
          const timer = setTimeout(() => {
            // 超时：从队列里摘掉并拒绝，绝不静默挂起。
            const idx = st.waiters.findIndex((w) => w.timer === timer);
            if (idx >= 0) st.waiters.splice(idx, 1);
            resolve({
              kind: 'reject',
              code: 'turn-concurrent-queue-full',
              terminate: true,
              message:
                `turn-concurrent-queue-full: ${input.tool} 排队超时（${QUEUE_WAIT_TIMEOUT_MS}ms）` +
                '**未被执行**，请不要在同一轮并发多个标签。',
            });
          }, QUEUE_WAIT_TIMEOUT_MS);
          st.waiters.push({
            signature: input.signature,
            mutating: input.mutating,
            ...(input.arrivalSeq !== undefined ? { arrivalSeq: input.arrivalSeq } : {}),
            resolve,
            timer,
          });
        });
        // 等待期间被 reset() 清空：按排队超限拒绝，避免悬空 resolve。
        if (generation !== myGeneration) {
          return {
            kind: 'reject',
            code: 'turn-concurrent-queue-full',
            terminate: true,
            message: `turn-concurrent-queue-full: ${input.tool} 所在会话已切换，未被执行。`,
          };
        }
        return decision;
      }

      // ③ 空闲：直接占位。
      st.inFlight = true;
      inFlight += 1;
      return { kind: 'run', release: makeRelease(input.key, st, input.signature, input.mutating) };
    },

    stats() {
      let active = 0;
      for (const st of turns.values()) if (st.inFlight || st.waiters.length > 0) active += 1;
      return { activeTurns: active, inFlight };
    },

    reset() {
      generation += 1;
      for (const [key, st] of turns) {
        for (const w of st.waiters) {
          clearTimeout(w.timer);
          w.resolve({
            kind: 'reject',
            code: 'turn-concurrent-queue-full',
            terminate: true,
            message: 'turn-concurrent-queue-full: 会话已切换，排队的调用未被执行。',
          });
        }
        st.waiters = [];
        turns.delete(key);
      }
      inFlight = 0;
    },
  };
}

/**
 * 把护栏的拒绝决定转成宿主统一的工具结果（`ToolExecutionResult` 形状，带 `terminate: true`）。
 *
 * 用 `reason` 而不是 `error`：宿主内部结果体全链用 `reason`（`withTerminalSignal` 同形），
 * 页端再把 `reason` 重命名为 `error` 送给模型。
 * 正文与 `reason` **都带上机器码**：模型与审计各读一份，不会因为只留一处而丢证据。
 */
export function turnGuardRejection(input: {
  readonly code: TurnGuardRejectCode;
  readonly message: string;
}): TurnGuardRejectionResult {
  return {
    ok: false,
    reason: input.code,
    isError: true,
    terminate: true,
    content: [{ type: 'text', text: input.message }],
  };
}

/** `turnGuardRejection` 的返回形状（与 `shared/tool-result-format` 的 `ToolExecutionResult` 结构兼容）。 */
export interface TurnGuardRejectionResult {
  readonly ok: false;
  readonly reason: TurnGuardRejectCode;
  readonly isError: true;
  readonly terminate: true;
  readonly content: Array<{ type: 'text'; text: string }>;
}

/** 稳定序列化（与 `tool-call-dedupe` 同形，但本模块独立，不共享状态）。 */
export function stableSignature(tool: string, params: unknown): string {
  return `${tool}:${stableSerialize(params)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`;
}
