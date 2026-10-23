import {
  STUDIO_EXECUTION_INDEX_KEY,
  STUDIO_EXECUTION_MAX_EVENTS,
  STUDIO_EXECUTION_MAX_SESSIONS,
  STUDIO_EXECUTION_VERSION,
  appendExecutionEvent,
  createEmptyStudioExecutionSession,
  isStudioExecutionIndex,
  isStudioExecutionSession,
  sessionTitle,
  studioExecutionStorageKey,
  type StudioExecutionEvent,
  type StudioExecutionIndex,
  type StudioExecutionSession,
} from '../shared/studio-execution';

export { studioExecutionStorageKey };

export interface StudioExecutionKv {
  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown): Promise<void>;
  kvRemove(key: string): Promise<void>;
}

export interface StudioExecutionStore {
  loadSession(key: string): Promise<StudioExecutionSession | null>;
  saveSession(session: StudioExecutionSession): Promise<void>;
  saveEvent(key: string, event: StudioExecutionEvent): Promise<StudioExecutionSession>;
  renameSession(fromKey: string, toKey: string): Promise<void>;
  clearAll(): Promise<void>;
  onConnected(callback: () => void): () => void;
  readonly connected: boolean;
}

export interface StudioExecutionStoreOptions {
  kv: StudioExecutionKv;
  onConnected: (callback: () => void) => () => void;
  isConnected: () => boolean;
  reportError?: (message: string, error?: unknown) => void;
}

/**
 * 清理「孤儿错误」事件：没有对应 user-message 的系统错误一律丢弃。
 *
 * 两种来源都会产生孤儿错误，都会污染已成功会话的重放：
 * 1. 旧版本把 `code:0` 成功包误判成 `body-error-0`；
 * 2. 续跑/新会话的失败请求在 captureChatRequest 没抓到 userText 时只落 error，
 *    turnId 归属上一个回合，重放时错误卡出现在 final-answer 之后。
 * 只丢弃没有 user-message 对应的错误；有 user-message 的真实轮次错误保留。
 */
export function dropLegacyOrphanBodyErrors(events: StudioExecutionEvent[]): StudioExecutionEvent[] {
  const turnsWithUserMessage = new Set(
    events
      .filter((event) => event.type === 'user-message')
      .map((event) => event.turnId),
  );
  return events.filter((event) => !(
    event.type === 'system-error'
    && !turnsWithUserMessage.has(event.turnId)
  ));
}

export function createStudioExecutionStore(options: StudioExecutionStoreOptions): StudioExecutionStore {
  const cache = new Map<string, StudioExecutionSession>();
  let writeChain: Promise<void> = Promise.resolve();

  function report(message: string, error?: unknown): void {
    options.reportError?.(message, error);
  }

  async function loadIndex(): Promise<StudioExecutionIndex> {
    const raw = await options.kv.kvGet(STUDIO_EXECUTION_INDEX_KEY);
    if (!isStudioExecutionIndex(raw)) {
      return { version: STUDIO_EXECUTION_VERSION, sessions: [] };
    }
    return {
      version: STUDIO_EXECUTION_VERSION,
      sessions: raw.sessions
        .filter((entry) => entry && typeof entry.key === 'string')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, STUDIO_EXECUTION_MAX_SESSIONS),
    };
  }

  async function readSession(key: string): Promise<StudioExecutionSession | null> {
    const cached = cache.get(key);
    if (cached) return cached;
    const raw = await options.kv.kvGet(studioExecutionStorageKey(key));
    if (!isStudioExecutionSession(raw)) return null;
    const sanitizedEvents = dropLegacyOrphanBodyErrors(raw.events);
    const session: StudioExecutionSession = {
      ...raw,
      events: sanitizedEvents.slice(-STUDIO_EXECUTION_MAX_EVENTS),
    };
    if (sanitizedEvents.length !== raw.events.length) {
      await options.kv.kvSet(studioExecutionStorageKey(key), session);
    }
    cache.set(key, session);
    return session;
  }

  async function loadSession(key: string): Promise<StudioExecutionSession | null> {
    await writeChain;
    return readSession(key);
  }

  async function writeSession(session: StudioExecutionSession): Promise<void> {
    await options.kv.kvSet(studioExecutionStorageKey(session.key), session);
    const index = await loadIndex();
    const nextEntry = {
      key: session.key,
      routeKey: session.routeKey,
      updatedAt: session.updatedAt,
      title: sessionTitle(session),
    };
    const sessions = index.sessions.filter((entry) => entry.key !== session.key);
    sessions.unshift(nextEntry);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const evicted = sessions.splice(STUDIO_EXECUTION_MAX_SESSIONS);
    await options.kv.kvSet(STUDIO_EXECUTION_INDEX_KEY, {
      version: STUDIO_EXECUTION_VERSION,
      sessions,
    } satisfies StudioExecutionIndex);
    for (const entry of evicted) {
      await options.kv.kvRemove(studioExecutionStorageKey(entry.key));
    }
  }

  function enqueue<T>(operation: () => Promise<T>, message = 'studio execution persistence failed'): Promise<T> {
    const result = writeChain.then(operation);
    writeChain = result.then(
      () => undefined,
      (error) => {
        report(message, error);
      },
    );
    return result;
  }

  return {
    async loadSession(key) {
      try {
        return await loadSession(key);
      } catch (error) {
        report('studio execution load failed', error);
        return null;
      }
    },
    async saveEvent(key, event) {
      return enqueue(async () => {
        const session = (await readSession(key)) ?? createEmptyStudioExecutionSession(key);
        appendExecutionEvent(session, event);
        cache.set(key, session);
        await writeSession(session);
        return session;
      });
    },
    async saveSession(session) {
      try {
        const bounded: StudioExecutionSession = {
          ...session,
          events: session.events.slice(-STUDIO_EXECUTION_MAX_EVENTS),
        };
        cache.set(bounded.key, bounded);
        await enqueue(() => writeSession(bounded), 'studio execution session flush failed');
      } catch (error) {
        report('studio execution session flush failed', error);
        throw error;
      }
    },
    async renameSession(fromKey, toKey) {
      if (fromKey === toKey) return;
      try {
        await enqueue(async () => {
          const from = cache.get(fromKey) ?? await readSession(fromKey);
          if (!from) return;
          const renamed: StudioExecutionSession = {
            ...from,
            key: toKey,
            updatedAt: Date.now(),
          };
          cache.set(toKey, renamed);
          cache.delete(fromKey);
          await writeSession(renamed);
          await options.kv.kvRemove(studioExecutionStorageKey(fromKey));
        }, 'studio execution rename failed');
      } catch (error) {
        report('studio execution rename failed', error);
      }
    },
    async clearAll() {
      try {
        await enqueue(async () => {
          const index = await loadIndex();
          for (const entry of index.sessions) {
            await options.kv.kvRemove(studioExecutionStorageKey(entry.key));
          }
          for (const key of cache.keys()) {
            await options.kv.kvRemove(studioExecutionStorageKey(key));
          }
          cache.clear();
          await options.kv.kvRemove(STUDIO_EXECUTION_INDEX_KEY);
        }, 'studio execution clear failed');
      } catch (error) {
        report('studio execution clear failed', error);
        throw error;
      }
    },
    onConnected(callback) {
      return options.onConnected(callback);
    },
    get connected() {
      return options.isConnected();
    },
  };
}
