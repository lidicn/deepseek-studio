import { isPlainRuntimeRecord } from './envelope';
import type { RuntimeLastErrorController } from './runtime';

export type StorageAreaName = 'local' | 'session';

/** 与 MV3 一致：10 MiB。 */
export const QUOTA_BYTES = 10_485_760;

export type StorageJsonValue =
  | null
  | boolean
  | number
  | string
  | StorageJsonValue[]
  | { [key: string]: StorageJsonValue };

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export type StorageChanges = Record<string, StorageChange>;

export type StorageChangedListener = (changes: StorageChanges, areaName: StorageAreaName) => void;

export interface StorageKvWriteBatch {
  set: Record<string, unknown>;
  remove: string[];
}

/** Rust KV（原子写 JSON）后续实现的接口；本批用内存实现 + 测试 fake 对齐形状。 */
export interface StorageKvBackend {
  readAll(): Promise<Record<string, unknown>>;
  writeBatch(batch: StorageKvWriteBatch): Promise<void>;
}

export type StorageErrorCode = 'DATA_CLONE' | 'QUOTA_BYTES' | 'KV_PERSIST_FAILED' | 'INVALID_KEYS';

export class StorageBridgeError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageBridgeError';
    this.code = code;
  }
}

export type StorageKeys = string | string[] | Record<string, unknown> | null | undefined;

export interface StorageArea {
  readonly name: StorageAreaName;
  readonly QUOTA_BYTES: number;
  get(
    keys?: StorageKeys,
    callback?: (items: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> | undefined;
  set(items: Record<string, unknown>, callback?: () => void): Promise<void> | undefined;
  remove(keys: string | string[], callback?: () => void): Promise<void> | undefined;
  clear(callback?: () => void): Promise<void> | undefined;
  getBytesInUse(
    keys?: string | string[] | null,
    callback?: (bytesInUse: number) => void,
  ): Promise<number> | undefined;
}

export interface ChromeStorageShim {
  local: StorageArea;
  session: StorageArea;
  onChanged: {
    addListener(listener: StorageChangedListener): void;
    removeListener(listener: StorageChangedListener): void;
    hasListener(listener: StorageChangedListener): boolean;
  };
}

export interface ChromeStorageShimOptions {
  localBackend?: StorageKvBackend;
  quotaBytes?: number;
  lastError?: RuntimeLastErrorController;
}

export interface MemoryStorageKvBackend extends StorageKvBackend {
  snapshot(): Record<string, unknown>;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** JSON 子集深拷贝；不可序列化数据抛 StorageBridgeError('DATA_CLONE')。 */
export function cloneStorageValue(value: unknown, path = 'value'): StorageJsonValue {
  return cloneValue(value, path, new Set());
}

function cloneValue(value: unknown, path: string, ancestors: Set<object>): StorageJsonValue {
  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === 'boolean' || valueType === 'string') return value as StorageJsonValue;
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new StorageBridgeError('DATA_CLONE', `Storage value at ${path} is not a finite number.`);
    }
    return value as number;
  }
  if (valueType === 'undefined') {
    throw new StorageBridgeError('DATA_CLONE', `Storage value at ${path} is undefined.`);
  }
  if (valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') {
    throw new StorageBridgeError(
      'DATA_CLONE',
      `Storage value at ${path} is not JSON-serializable (${valueType}).`,
    );
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new StorageBridgeError('DATA_CLONE', `Storage value at ${path} is circular.`);
  }
  ancestors.add(objectValue);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => cloneValue(item, `${path}[${index}]`, ancestors));
    }
    if (!isPlainRuntimeRecord(value)) {
      throw new StorageBridgeError(
        'DATA_CLONE',
        `Storage value at ${path} must be a plain object or an array.`,
      );
    }
    const out: { [key: string]: StorageJsonValue } = {};
    for (const key of Object.keys(value)) {
      out[key] = cloneValue(value[key], `${path}.${key}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(objectValue);
  }
}

export function createMemoryStorageKvBackend(
  initial: Record<string, unknown> = {},
): MemoryStorageKvBackend {
  const data: Record<string, unknown> = { ...initial };
  return {
    async readAll(): Promise<Record<string, unknown>> {
      return { ...data };
    },
    async writeBatch(batch: StorageKvWriteBatch): Promise<void> {
      for (const key of batch.remove) delete data[key];
      for (const [key, value] of Object.entries(batch.set)) data[key] = value;
    },
    snapshot(): Record<string, unknown> {
      return { ...data };
    },
  };
}

function bytesInUseOf(data: Record<string, StorageJsonValue>): number {
  if (Object.keys(data).length === 0) return 0;
  return utf8ByteLength(JSON.stringify(data));
}

function sameJsonValue(a: StorageJsonValue | undefined, b: StorageJsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeKeyList(keys: string | string[]): string[] {
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) {
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new StorageBridgeError('INVALID_KEYS', 'Storage keys must be strings.');
      }
    }
    return [...keys];
  }
  throw new StorageBridgeError('INVALID_KEYS', 'Storage keys must be a string or an array of strings.');
}

function runOperation<T>(
  callback: ((value: T) => void) | undefined,
  operation: () => Promise<T>,
  lastError: RuntimeLastErrorController | undefined,
): Promise<T> | undefined {
  if (callback === undefined) return operation();
  void operation().then(
    (value: T) => {
      callback(value);
    },
    (error: unknown) => {
      lastError?.set({ message: error instanceof Error ? error.message : String(error) });
      // MV3 回调语义：失败时回调收到 undefined，同时 chrome.runtime.lastError 被置位
      callback(undefined as unknown as T);
    },
  );
  return undefined;
}

interface StorageAreaDeps {
  name: StorageAreaName;
  backend: StorageKvBackend | null;
  quotaBytes: number;
  emit: (changes: StorageChanges, areaName: StorageAreaName) => void;
  lastError?: RuntimeLastErrorController;
}

function createStorageArea(deps: StorageAreaDeps): StorageArea {
  const items = new Map<string, StorageJsonValue>();
  let loadPromise: Promise<void> | null = null;

  function ensureLoaded(): Promise<void> {
    if (deps.backend === null) return Promise.resolve();
    if (loadPromise === null) {
      loadPromise = deps.backend.readAll().then((loaded: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(loaded ?? {})) {
          if (value !== undefined) items.set(key, value as StorageJsonValue);
        }
      }).catch((err) => {
        loadPromise = null;
        throw err;
      });
    }
    return loadPromise;
  }

  async function commit(
    next: Map<string, StorageJsonValue>,
    changes: StorageChanges,
    batch: StorageKvWriteBatch,
  ): Promise<void> {
    const bytes = bytesInUseOf(Object.fromEntries(next));
    if (bytes > deps.quotaBytes) {
      throw new StorageBridgeError(
        'QUOTA_BYTES',
        `Storage area ${deps.name} would exceed QUOTA_BYTES (${deps.quotaBytes}).`,
      );
    }

    if (deps.backend !== null && (Object.keys(batch.set).length > 0 || batch.remove.length > 0)) {
      try {
        await deps.backend.writeBatch(batch);
      } catch (error) {
        throw new StorageBridgeError(
          'KV_PERSIST_FAILED',
          `Storage area ${deps.name} failed to persist: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    items.clear();
    for (const [key, value] of next) items.set(key, value);
    if (Object.keys(changes).length > 0) deps.emit(changes, deps.name);
  }

  async function getOperation(keys?: StorageKeys): Promise<Record<string, unknown>> {
    await ensureLoaded();
    const result: Record<string, unknown> = {};

    if (keys === undefined || keys === null) {
      for (const [key, value] of items) result[key] = value;
      return result;
    }
    if (typeof keys === 'string') {
      if (items.has(keys)) result[keys] = items.get(keys);
      return result;
    }
    if (Array.isArray(keys)) {
      for (const key of normalizeKeyList(keys)) {
        if (items.has(key)) result[key] = items.get(key);
      }
      return result;
    }
    if (isPlainRuntimeRecord(keys)) {
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = items.has(key) ? items.get(key) : fallback;
      }
      return result;
    }
    throw new StorageBridgeError(
      'INVALID_KEYS',
      'storage.get keys must be a string, an array of strings, or a defaults object.',
    );
  }

  async function setOperation(entries: Record<string, unknown>): Promise<void> {
    await ensureLoaded();
    if (!isPlainRuntimeRecord(entries)) {
      throw new StorageBridgeError('INVALID_KEYS', 'storage.set expects a plain object.');
    }

    // 1) 全批序列化校验（fail-closed：任一值不可序列化 → 一个 key 都不写）
    const cloned: Record<string, StorageJsonValue> = {};
    for (const [key, value] of Object.entries(entries)) {
      cloned[key] = cloneStorageValue(value, `set.${key}`);
    }

    // 2) 计算下个快照与变更集
    const next = new Map(items);
    const changes: StorageChanges = {};
    for (const [key, value] of Object.entries(cloned)) {
      const previous = items.has(key) ? items.get(key) : undefined;
      next.set(key, value);
      if (!sameJsonValue(previous, value)) {
        changes[key] = { oldValue: previous, newValue: value };
      }
    }

    await commit(next, changes, { set: cloned, remove: [] });
  }

  async function removeOperation(keys: string | string[]): Promise<void> {
    await ensureLoaded();
    const list = normalizeKeyList(keys);
    const next = new Map(items);
    const changes: StorageChanges = {};
    const removed: string[] = [];

    for (const key of list) {
      if (!items.has(key)) continue;
      const previous = items.get(key);
      next.delete(key);
      removed.push(key);
      changes[key] = { oldValue: previous, newValue: undefined };
    }

    await commit(next, changes, { set: {}, remove: removed });
  }

  async function clearOperation(): Promise<void> {
    await ensureLoaded();
    const changes: StorageChanges = {};
    const removed: string[] = [];
    for (const [key, value] of items) {
      changes[key] = { oldValue: value, newValue: undefined };
      removed.push(key);
    }
    await commit(new Map(), changes, { set: {}, remove: removed });
  }

  async function getBytesInUseOperation(keys?: string | string[] | null): Promise<number> {
    await ensureLoaded();
    if (keys === undefined || keys === null) return bytesInUseOf(Object.fromEntries(items));

    const data: Record<string, StorageJsonValue> = {};
    for (const key of normalizeKeyList(keys)) {
      if (items.has(key)) data[key] = items.get(key) as StorageJsonValue;
    }
    return bytesInUseOf(data);
  }

  // R2-C1 修复：把「读快照 -> 写后端 -> 更新内存」整段串行化。
  // 否则两次并发 set 会在 await writeBatch 的 IO 窗口内交错，
  // 后完成者用基于旧快照的 next 全量替换 items，抹掉先完成者写入的 key（丢更新）。
  let mutationTail: Promise<unknown> = Promise.resolve();
  function enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
    const run = mutationTail.then(() => op());
    // 前一个操作的失败不得阻断后续操作，但必须原样传递给本次调用方。
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    name: deps.name,
    QUOTA_BYTES: deps.quotaBytes,
    get: (keys, callback) => runOperation(callback, () => getOperation(keys), deps.lastError),
    set: (entries, callback) => runOperation(callback, () => enqueueMutation(() => setOperation(entries)), deps.lastError),
    remove: (keys, callback) => runOperation(callback, () => enqueueMutation(() => removeOperation(keys)), deps.lastError),
    clear: (callback) => runOperation(callback, () => enqueueMutation(() => clearOperation()), deps.lastError),
    getBytesInUse: (keys, callback) =>
      runOperation(callback, () => getBytesInUseOperation(keys), deps.lastError),
  };
}

export function createChromeStorageShim(options: ChromeStorageShimOptions = {}): ChromeStorageShim {
  const quotaBytes = options.quotaBytes ?? QUOTA_BYTES;
  const listeners: StorageChangedListener[] = [];

  const emitter = {
    addListener(listener: StorageChangedListener): void {
      if (typeof listener !== 'function') {
        throw new TypeError('storage.onChanged listener must be a function.');
      }
      if (!listeners.includes(listener)) listeners.push(listener);
    },
    removeListener(listener: StorageChangedListener): void {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener(listener: StorageChangedListener): boolean {
      return listeners.includes(listener);
    },
    emit(changes: StorageChanges, areaName: StorageAreaName): void {
      for (const listener of [...listeners]) {
        try {
          listener(changes, areaName);
        } catch {
          // fail-open：与 Chrome 一致，单个监听器抛错不影响其余监听器
        }
      }
    },
  };

  const local = createStorageArea({
    name: 'local',
    backend: options.localBackend ?? createMemoryStorageKvBackend(),
    quotaBytes,
    emit: emitter.emit,
    lastError: options.lastError,
  });

  // session 轨：进程内 Map，永不落盘、重启清空（工具授权态载体）
  const session = createStorageArea({
    name: 'session',
    backend: null,
    quotaBytes,
    emit: emitter.emit,
    lastError: options.lastError,
  });

  return {
    local,
    session,
    onChanged: {
      addListener: emitter.addListener,
      removeListener: emitter.removeListener,
      hasListener: emitter.hasListener,
    },
  };
}
