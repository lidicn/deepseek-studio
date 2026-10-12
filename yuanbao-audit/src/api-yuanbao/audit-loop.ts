/**
 * 审计轮次驱动（audit-loop）
 *
 * 状态机：idle → running → done（rounds >= target）；paused / stopped 可由 continue 恢复。
 * 命令队列：FIFO + applied 标记；轮次执行期间到达的命令在轮次收尾的 safe point 生效。
 * 轮次串行：同一时刻最多一轮在飞（in-flight 保护）。
 */

export const LOOP_STATES = ['idle', 'running', 'paused', 'stopped', 'done'] as const;
export type LoopState = (typeof LOOP_STATES)[number];

export const COMMANDS = ['continue', 'pause', 'stop', 'reset'] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface LoopStatus {
  state: LoopState;
  rounds: number;
  target: number;
  lastRound: number | null;
}

export interface CommandRecord {
  command: CommandName;
  at: number;
  applied: boolean;
}

export interface RoundContext {
  round: number;
  target: number;
  startedAt: number;
}

export type RoundOutcome = { ok: true; summary?: string } | { ok: false; error: string };
export type RunRound = (ctx: RoundContext) => Promise<RoundOutcome> | RoundOutcome;

export interface EnqueueResult {
  ok: boolean;
  command?: string;
  queueDepth: number;
  reason?: string;
}

export type TimerHandle = unknown;

export interface AuditLoopOptions {
  /** 首次运行的目标轮次；恢复时以 checkpoint 里的 target 为准（断点续跑）。 */
  target: number;
  /** 轮次间隔（毫秒）。 */
  intervalMs: number;
  runRound: RunRound;
  restored?: Partial<LoopStatus>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** 连续失败多少轮后自停（默认 3）。 */
  maxConsecutiveFailures?: number;
  /** 每轮收尾回调（main 用来落盘 checkpoint）；异常吞掉（fail-open）。 */
  onSettled?: (status: LoopStatus) => void | Promise<void>;
  log?: (msg: string) => void;
}

export interface AuditLoop {
  status(): LoopStatus;
  enqueue(command: CommandName): EnqueueResult;
  pending(): readonly CommandRecord[];
  history(limit?: number): readonly CommandRecord[];
  tick(): Promise<LoopStatus>;
  run(): EnqueueResult;
  dispose(): void;
  lastError(): string | null;
  queueDepth(): number;
}

export function isCommandName(v: unknown): v is CommandName {
  return typeof v === 'string' && (COMMANDS as readonly string[]).includes(v);
}

function toInt(v: unknown, min: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : min;
  return Math.max(min, n);
}

const DEFAULT_MAX_FAILURES = 3;

export function createAuditLoop(options: AuditLoopOptions): AuditLoop {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimer = options.clearTimer ?? ((h: TimerHandle) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  });
  const log = options.log ?? (() => undefined);
  const maxFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES);

  const restored = options.restored ?? {};
  const status: LoopStatus = {
    state: (LOOP_STATES as readonly string[]).includes(String(restored.state)) ? (restored.state as LoopState) : 'idle',
    rounds: toInt(restored.rounds ?? 0, 0),
    target: toInt(restored.target ?? options.target, 1),
    lastRound: typeof restored.lastRound === 'number' && Number.isFinite(restored.lastRound) ? restored.lastRound : null,
  };

  const queue: CommandRecord[] = [];
  let timer: TimerHandle | null = null;
  let inFlight = false;
  let failures = 0;
  let lastErr: string | null = null;
  let disposed = false;

  function clearLoopTimer(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function ensureTimer(): void {
    if (disposed || timer !== null || status.state !== 'running') return;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, Math.max(0, options.intervalMs));
  }

  function applyCommand(command: CommandName): void {
    switch (command) {
      case 'continue':
        if (status.state === 'done') return; // 已达目标：保持 done，不重启调度
        status.state = 'running';
        ensureTimer();
        return;
      case 'pause':
        if (status.state === 'done') return;
        status.state = 'paused';
        clearLoopTimer();
        return;
      case 'stop':
        status.state = 'stopped';
        clearLoopTimer();
        return;
      case 'reset':
        status.state = 'idle';
        status.rounds = 0;
        status.lastRound = null;
        failures = 0;
        lastErr = null;
        clearLoopTimer();
        return;
    }
  }

  function applyPending(): void {
    for (const rec of queue) {
      if (rec.applied) continue;
      rec.applied = true;
      applyCommand(rec.command);
    }
  }

  async function settle(): Promise<void> {
    if (!options.onSettled) return;
    try {
      await options.onSettled({ ...status });
    } catch (err) {
      log(`[audit-loop] checkpoint 落盘失败（fail-open）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function tick(): Promise<LoopStatus> {
    if (disposed) return { ...status };
    if (inFlight) return { ...status }; // 串行：同一时刻只跑一轮
    applyPending();
    if (status.state !== 'running') return { ...status };
    if (status.rounds >= status.target) {
      status.state = 'done';
      clearLoopTimer();
      await settle();
      return { ...status };
    }

    inFlight = true;
    const round = status.rounds + 1;
    const startedAt = now();
    let outcome: RoundOutcome;
    try {
      const r = await options.runRound({ round, target: status.target, startedAt });
      outcome =
        r && typeof r === 'object' && typeof (r as { ok?: unknown }).ok === 'boolean'
          ? r
          : { ok: false, error: 'runRound returned invalid outcome' };
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.ok) {
      status.rounds = round;
      status.lastRound = now();
      failures = 0;
      lastErr = null;
      if (status.rounds >= status.target) status.state = 'done';
    } else {
      failures += 1;
      lastErr = outcome.error;
      log(`[audit-loop] 第 ${round} 轮失败（${failures}/${maxFailures}）：${outcome.error}`);
      if (failures >= maxFailures) status.state = 'stopped'; // fail-safe：别带着坏上游空转
    }

    inFlight = false;
    applyPending(); // 轮次期间排队的命令在此生效
    if (status.state === 'running') ensureTimer();
    else clearLoopTimer();
    await settle();
    return { ...status };
  }

  const api: AuditLoop = {
    status: () => ({ ...status }),
    enqueue(command) {
      if (disposed) return { ok: false, queueDepth: queue.length, reason: 'loop disposed' };
      if (!isCommandName(command)) {
        return { ok: false, queueDepth: queue.length, reason: `unknown command: ${String(command)}` };
      }
      queue.push({ command, at: now(), applied: false });
      if (!inFlight) applyPending();
      return { ok: true, command, queueDepth: queue.length };
    },
    pending: () => queue.filter((r) => !r.applied).map((r) => ({ ...r })),
    history: (limit = 50) => {
      const n = Math.max(1, Math.floor(limit));
      return queue.slice(Math.max(0, queue.length - n)).map((r) => ({ ...r }));
    },
    tick,
    run: () => api.enqueue('continue'),
    dispose() {
      disposed = true;
      clearLoopTimer();
    },
    lastError: () => lastErr,
    queueDepth: () => queue.length,
  };
  return api;
}
