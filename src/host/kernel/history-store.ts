/**
 * HistoryStore（S3）：把 MessageHistory 快照 + 轮次计数持久化。
 *
 * 定位：不做真实文件 IO。read/write 由调用方注入（测试塞内存函数，生产接 tauri fs），
 *   本模块只负责 JSON 序列化、版本校验与结构校验。
 *
 * 硬性质：
 *   - 快照带 version:1；restore/load 遇 version!==1 一律抛错，不静默降级；
 *   - load() 无数据时返回 null（首次启动）；
 *   - 与 MessageHistory 的 version:1 对齐。
 */

import type { MessageHistorySnapshot } from './message-history';

// ---------------------------------------------------------------- 类型

export const HISTORY_STORE_VERSION = 1 as const;

/** 持久化的循环态：历史快照 + 已完成轮次。 */
export interface PersistedLoopState {
  readonly version: 1;
  readonly history: MessageHistorySnapshot;
  /** 已完成到第几轮（恢复后从 round+1 继续）。 */
  readonly round: number;
}

export interface HistoryStoreOptions {
  /** 读已持久化的文本；无数据返回 null/''。可异步。 */
  read: () => string | null | Promise<string | null>;
  /** 写持久化文本。可异步。 */
  write: (data: string) => void | Promise<void>;
}

export interface HistoryStore {
  save(state: PersistedLoopState): Promise<void>;
  /** 无数据返回 null；结构非法 / 版本不符抛错。 */
  load(): Promise<PersistedLoopState | null>;
}

// ---------------------------------------------------------------- 工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------- 工厂

export function createHistoryStore(opts: HistoryStoreOptions): HistoryStore {
  async function save(state: PersistedLoopState): Promise<void> {
    if (state.version !== HISTORY_STORE_VERSION) {
      throw new TypeError(
        `history-store.save: 不认识的状态版本 ${String(state.version)}`,
      );
    }
    await opts.write(JSON.stringify(state));
  }

  async function load(): Promise<PersistedLoopState | null> {
    const raw = await opts.read();
    if (raw === null || raw === '') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TypeError('history-store.load: 持久化内容不是合法 JSON');
    }
    if (!isRecord(parsed)) {
      throw new TypeError('history-store.load: 快照必须是对象');
    }
    if (parsed.version !== HISTORY_STORE_VERSION) {
      throw new TypeError(
        `history-store.load: 不认识的状态版本 ${String(parsed.version)}`,
      );
    }
    if (!isRecord(parsed.history)) {
      throw new TypeError('history-store.load: 快照缺少 history 对象');
    }
    if (!Array.isArray(parsed.history.messages)) {
      throw new TypeError('history-store.load: 快照缺少 history.messages 数组');
    }
    if (typeof parsed.round !== 'number' || !Number.isFinite(parsed.round)) {
      throw new TypeError('history-store.load: 快照缺少合法 round 数字');
    }
    return parsed as unknown as PersistedLoopState;
  }

  return { save, load };
}
