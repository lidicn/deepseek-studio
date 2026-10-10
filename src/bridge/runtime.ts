/**
 * deepseek-studio MV3 桥接层 · 运行时桥 dispatcher
 *
 * 负责任务：注册监听器、按 envelope 派发、实现 chrome.runtime 的 sendResponse 超时语义、
 * 维护 chrome.runtime.lastError 控制器（storage.ts 复用）。
 */

import {
  authorizeRuntimeMessage,
  createRuntimeBoundaryErrorResponse,
  decodeRuntimeMessageEnvelope,
  type RuntimeBoundaryErrorCode,
  type RuntimeMessageEnvelope,
} from './envelope';
import type { RuntimeMessageSenderLike, Transport } from './transport';

const NO_RESPONSE = Symbol('no-response');
const DEFAULT_TIMEOUT_MS = 30_000;

/** storage.ts 依赖的控制台：失败时置位 message，下次读后自动清空（与 Chrome 一致）。 */
export interface RuntimeLastErrorController {
  set(error: { message: string } | undefined): void;
  get(): { message: string } | undefined;
  clear(): void;
}

export function createRuntimeLastErrorController(): RuntimeLastErrorController {
  let current: { message: string } | undefined;
  return {
    set(error) {
      current = error;
    },
    get() {
      return current;
    },
    clear() {
      current = undefined;
    },
  };
}

export type RuntimeMessageListener = (
  envelope: RuntimeMessageEnvelope,
  sender: RuntimeMessageSenderLike,
  sendResponse: (value: unknown) => void,
) => boolean | void | Promise<unknown>;

export interface RuntimeBridgeOptions {
  transport: Transport;
  listeners?: RuntimeMessageListener[];
  timeoutMs?: number;
  lastError?: RuntimeLastErrorController;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface RuntimeBridge {
  addListener(listener: RuntimeMessageListener): void;
  removeListener(listener: RuntimeMessageListener): void;
  /** 主动投出一封信封（content -> 后台 或 后台 -> content）。 */
  post(envelope: RuntimeMessageEnvelope, sender?: RuntimeMessageSenderLike): Promise<unknown>;
  /** 接收侧入口：收到对端信封后跑监听器 + sendResponse 超时，返回响应。 */
  handle(envelope: RuntimeMessageEnvelope, sender?: RuntimeMessageSenderLike): Promise<unknown>;
  readonly lastError: RuntimeLastErrorController;
}

export function createRuntimeBridge(options: RuntimeBridgeOptions): RuntimeBridge {
  const listeners = [...(options.listeners ?? [])];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lastError = options.lastError ?? createRuntimeLastErrorController();

  async function dispatch(
    envelope: RuntimeMessageEnvelope,
    sender: RuntimeMessageSenderLike,
    timeoutMs: number,
  ): Promise<unknown> {
    let responded = false;
    let settle: (v: unknown) => void;
    const sendResponsePromise = new Promise<unknown>((res) => {
      settle = res;
    });
    const sendResponse = (value: unknown): void => {
      if (!responded) {
        responded = true;
        settle(value);
      }
    };

    for (const listener of listeners) {
      const raw = listener(envelope, sender, sendResponse);
      if (raw === true) {
        const value = await withTimeout(sendResponsePromise, timeoutMs, NO_RESPONSE);
        if (value !== NO_RESPONSE) return value;
      } else if (raw instanceof Promise) {
        const value = await withTimeout(Promise.resolve(raw), timeoutMs, NO_RESPONSE);
        if (value !== NO_RESPONSE) return value;
      }
    }
    return NO_RESPONSE;
  }

  return {
    addListener(listener) {
      if (!listeners.includes(listener)) listeners.push(listener);
    },
    removeListener(listener) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
    async post(envelope, sender = {}) {
      return options.transport.post(envelope, sender);
    },
    async handle(envelope, sender = {}) {
      if (!authorizeRuntimeMessage(envelope)) {
        const code: RuntimeBoundaryErrorCode = 'UNAUTHORIZED';
        lastError.set({ message: `command not authorized: ${envelope.command}` });
        return createRuntimeBoundaryErrorResponse(envelope.requestId, code, lastError.get()!.message);
      }
      const value = await dispatch(envelope, sender, timeoutMs);
      if (value === NO_RESPONSE) return createRuntimeBoundaryErrorResponse(envelope.requestId, 'DISPATCH_TIMEOUT', 'no receiver responded');
      return value;
    },
    lastError,
  };
}

export { decodeRuntimeMessageEnvelope, authorizeRuntimeMessage, createRuntimeBoundaryErrorResponse };
