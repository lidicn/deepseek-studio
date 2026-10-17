/**
 * SessionManager（S14）：多会话并发管理。
 *
 * 每个 sessionId 独立持有 MessageHistory + TaskLoop，互不串历史。
 * 并发上限可配（默认 4）；destroy 时 abort 未完成的轮次。
 */

import type { ModelEngine } from '../engine/model-engine';
import { createMessageHistory, type MessageHistory } from './message-history';
import { createTaskLoop, type TaskLoop } from './task-loop';

export interface SessionHandle {
  readonly sessionId: string;
  readonly loop: TaskLoop;
  readonly history: MessageHistory;
}

export interface SessionManagerOptions {
  readonly engine: ModelEngine;
  readonly maxSessions?: number;
}

export interface SessionManager {
  getOrCreate(sessionId: string): SessionHandle;
  destroy(sessionId: string): void;
  list(): string[];
}

export function createSessionManager(opts: SessionManagerOptions): SessionManager {
  const { engine } = opts;
  const maxSessions = opts.maxSessions ?? 4;
  const sessions = new Map<string, { handle: SessionHandle; ac: AbortController }>();

  function getOrCreate(sessionId: string): SessionHandle {
    const existing = sessions.get(sessionId);
    if (existing) return existing.handle;

    if (sessions.size >= maxSessions) {
      throw new Error(`SessionManager: 已达并发上限 ${maxSessions}`);
    }

    const history = createMessageHistory();
    const ac = new AbortController();
    const loop = createTaskLoop({ engine, history, signal: ac.signal });
    const handle: SessionHandle = { sessionId, loop, history };
    sessions.set(sessionId, { handle, ac });
    return handle;
  }

  function destroy(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.ac.abort();
    sessions.delete(sessionId);
  }

  function list(): string[] {
    return Array.from(sessions.keys());
  }

  return { getOrCreate, destroy, list };
}
