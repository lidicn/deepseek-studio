/**
 * 元宝审计 · 浏览器驱动循环（方案 A）
 *
 * 在【可见的 Playwright 窗口】里跑：
 *   - 未登录 → 状态 waiting-login，窗口停着等用户扫码
 *   - 已登录 → 每 5s 读页面文本 → detectSignals → 该发"继续"就发
 *   - NEED_DECISION → paused，停手等人
 *   - 达到目标轮次 / ALL_DONE → done
 *
 * 状态对象暴露给 HTTP server 读，command 端点可 pause/stop/continue/reset。
 */
import { detectSignals, mergeSignals, type AuditSignals } from '../inject-yuanbao/signal-detector';
import type { BrowserSessionHandle } from './session';

export const CHECK_INTERVAL_MS = 5_000;
export const IDLE_CONTINUE_MS = 120_000;      // 空闲 120s 发"继续"
export const GENERATING_NO_CHANGE_MS = 300_000; // 生成中 300s 无变化发"继续"
export const MAX_CONTINUE = 5;

export type LoopPhase = 'waiting-login' | 'running' | 'paused' | 'done' | 'stopped';

export interface BrowserLoopState {
  phase: LoopPhase;
  rounds: number;          // 本次会话新完成的轮次
  target: number;
  seenRounds: number[];    // 累计真实轮次编号
  allDone: boolean;
  needDecision: boolean;
  continueCount: number;
  lastSeenLen: number;
  lastActivityAt: number;
  updatedAt: number;
}

export interface BrowserLoopHandle {
  state: BrowserLoopState;
  command(cmd: 'continue' | 'pause' | 'stop' | 'reset'): void;
  run(): Promise<void>;
  dispose(): void;
}

export interface CreateBrowserLoopDeps {
  session: BrowserSessionHandle;
  target: number;
  /** 日志回调 */
  log?: (msg: string, level?: string) => void;
  /** 每轮状态变化时落 checkpoint */
  onState?: (s: BrowserLoopState) => Promise<void> | void;
  /** 轮询间隔（默认 5s；测试可注入短间隔） */
  intervalMs?: number;
}

function initialState(target: number): BrowserLoopState {
  return {
    phase: 'waiting-login',
    rounds: 0,
    target,
    seenRounds: [],
    allDone: false,
    needDecision: false,
    continueCount: 0,
    lastSeenLen: 0,
    lastActivityAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function createBrowserLoop(deps: CreateBrowserLoopDeps): BrowserLoopHandle {
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? CHECK_INTERVAL_MS;
  const state = initialState(deps.target);
  let signals: AuditSignals = {
    rounds: new Set<number>(),
    allDone: false,
    needDecision: false,
    needContinue: false,
    lastUpdate: 0,
  };
  let stopped = false;
  let paused = false;
  let decisionAck = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    const now = Date.now();

    try {
      // 1) 登录态检查
      const loggedIn = await deps.session.isLoggedIn();
      if (!loggedIn) {
        if (state.phase !== 'waiting-login') {
          log('未检测到输入框，等待用户在窗口内扫码登录', 'WARN');
        }
        state.phase = 'waiting-login';
        state.updatedAt = now;
        await deps.onState?.(snapshot());
        schedule();
        return;
      }

      // 2) 读页面文本
      const text = await deps.session.readText();
      state.updatedAt = now;

      // 3) 信号检测
      const detected = detectSignals(text);
      const newRounds = mergeSignals(signals, detected);
      if (newRounds.length > 0) {
        state.seenRounds = [...signals.rounds].sort((a, b) => a - b);
        state.rounds = newRounds.length;
        state.continueCount = 0;
        state.lastActivityAt = now;
        paused = false;
        decisionAck = false;
        log(`检测到新轮次 ${newRounds.join(',')}（累计 ${state.seenRounds.length}）`, 'EVENT');
      }
      state.allDone = signals.allDone;
      state.needDecision = signals.needDecision;

      // 4) 达到目标轮次
      const maxSeen = state.seenRounds.length ? Math.max(...state.seenRounds) : 0;
      if (state.target > 0 && maxSeen >= state.target) {
        state.phase = 'done';
        log(`已达目标轮次 ${state.target}，收尾`, 'EVENT');
        await deps.onState?.(snapshot());
        return;
      }

      // 5) ALL_DONE
      if (signals.allDone && newRounds.length > 0) {
        state.phase = 'done';
        log('检测到 ALL_DONE', 'EVENT');
        await deps.onState?.(snapshot());
        return;
      }

      // 6) 需要决策 → 停手等人
      if (signals.needDecision && !decisionAck) {
        paused = true;
        state.phase = 'paused';
        log('检测到 NEED_DECISION，暂停等待人工（窗口保持可见）', 'WARN');
        await deps.onState?.(snapshot());
        schedule();
        return;
      }

      // 7) 文本长度变化 → 刷新活动时间
      if (text.length !== state.lastSeenLen) {
        state.lastSeenLen = text.length;
        state.lastActivityAt = now;
      }

      // 8) 暂停中不自动发
      if (paused) {
        state.phase = 'paused';
        await deps.onState?.(snapshot());
        schedule();
        return;
      }

      state.phase = 'running';
      const generating = await deps.session.isGenerating();
      const idleFor = now - state.lastActivityAt;

      if (!generating && idleFor >= IDLE_CONTINUE_MS) {
        if (state.continueCount < MAX_CONTINUE) {
          state.continueCount += 1;
          log(`空闲 ${Math.round(idleFor / 1000)}s，自动发"继续"（${state.continueCount}/${MAX_CONTINUE}）`);
          const r = await deps.session.sendText('继续');
          if (r.ok) state.lastActivityAt = now;
        } else {
          log(`连续卡住 ${MAX_CONTINUE} 次，停手等人工（不再盲发）`, 'FATAL');
          paused = true;
          state.phase = 'paused';
        }
      } else if (generating && idleFor >= GENERATING_NO_CHANGE_MS) {
        if (state.continueCount < MAX_CONTINUE) {
          state.continueCount += 1;
          log(`生成中 ${Math.round(idleFor / 1000)}s 无变化，发"继续"`, 'WARN');
          await deps.session.sendText('继续');
          state.lastActivityAt = now;
        }
      }

      await deps.onState?.(snapshot());
    } catch (e) {
      log(`循环异常：${e instanceof Error ? e.message : String(e)}`, 'ERROR');
    }
    schedule();
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
  }

  function snapshot(): BrowserLoopState {
    return { ...state, seenRounds: [...state.seenRounds] };
  }

  return {
    state,
    command(cmd) {
      if (cmd === 'pause') {
        paused = true;
        state.phase = 'paused';
        log('收到 pause');
      } else if (cmd === 'continue') {
        decisionAck = true;
        paused = false;
        state.continueCount = 0;
        state.phase = 'running';
        log('收到 continue');
      } else if (cmd === 'stop') {
        stopped = true;
        state.phase = 'stopped';
        log('收到 stop', 'WARN');
      } else if (cmd === 'reset') {
        signals = { rounds: new Set(), allDone: false, needDecision: false, needContinue: false, lastUpdate: 0 };
        Object.assign(state, initialState(state.target));
        state.phase = 'running';
        paused = false;
        decisionAck = false;
        log('收到 reset');
      }
    },
    async run() {
      state.phase = 'waiting-login';
      schedule();
    },
    dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
