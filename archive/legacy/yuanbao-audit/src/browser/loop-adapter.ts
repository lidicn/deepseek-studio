/**
 * 把浏览器驱动的循环适配成 server 认识的 LoopView。
 *
 * 浏览器循环的 phase（waiting-login/running/paused/done/stopped）
 * 映射成旧 LoopState（idle/running/paused/stopped/done），
 * 这样 /status、/command 无需改动即可复用。
 */
import type { LoopStatus, CommandName, CommandRecord, EnqueueResult } from '../api-yuanbao/audit-loop';
import type { BrowserLoopHandle } from './browser-loop';

const PHASE_TO_STATE: Record<string, LoopStatus['state']> = {
  'waiting-login': 'idle',
  running: 'running',
  paused: 'paused',
  done: 'done',
  stopped: 'stopped',
};

export function browserLoopToLoopView(handle: BrowserLoopHandle): {
  status(): LoopStatus;
  enqueue(command: CommandName): EnqueueResult;
  pending(): readonly CommandRecord[];
  history(_limit?: number): readonly CommandRecord[];
} {
  return {
    status() {
      const s = handle.state;
      const maxRound = s.seenRounds.length ? Math.max(...s.seenRounds) : null;
      return {
        state: PHASE_TO_STATE[s.phase] ?? 'idle',
        rounds: s.seenRounds.length,
        target: s.target,
        lastRound: maxRound,
      };
    },
    enqueue(command: CommandName): EnqueueResult {
      handle.command(command);
      return { ok: true, command, queueDepth: 0 };
    },
    pending(): readonly CommandRecord[] {
      return [];
    },
    history(): readonly CommandRecord[] {
      return [];
    },
  };
}
