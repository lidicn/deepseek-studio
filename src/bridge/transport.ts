/**
 * deepseek-studio MV3 桥接层 · 传输抽象
 *
 * Transport 抽象出「一跳消息投递」：content <-> 常驻后台 之间只依赖一个 post 方法。
 * 桌面侧实现有两种：
 *   - WindowMessageTransport：同文档内 window.postMessage（content 与注入脚本之间，见 src/inject）
 *   - RuntimeMessageTransport：chrome.runtime.sendMessage 风格的投递（宿主不可用时降级为 no-op）
 * 同一份 RuntimeBridge（runtime.ts）不关心底层是哪种 Transport。
 */

import type { RuntimeMessageEnvelope } from './envelope';

export interface RuntimeMessageSenderLike {
  readonly id?: string;
  readonly url?: string;
  readonly origin?: string;
  readonly documentId?: string;
  readonly tabId?: number;
}

export interface Transport {
  /** 投递一个信封，返回对端经 sendResponse 解析出的值（或 Promise）。 */
  post(envelope: RuntimeMessageEnvelope, sender: RuntimeMessageSenderLike): Promise<unknown>;
  /** 关闭底层通道（如移除 window 监听）。 */
  close?(): void;
}

/** 同文档 window.postMessage 传输。channel 用于区分本桥的消息。 */
export function createWindowMessageTransport(
  targetWindow: { postMessage(message: unknown, targetOrigin: string): void },
  channel: string,
  selfWindow: {
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
  } = globalThis as never,
  pendingTimeoutMs = 30_000,
): Transport {
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const listener = ((event: MessageEvent) => {
    const data = event.data as { __channel?: string; requestId?: string; response?: unknown } | null;
    if (!data || data.__channel !== channel) return;
    const id = data.requestId ?? '';
    const entry = pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.resolve(data.response);
    }
  }) as EventListener;
  selfWindow.addEventListener('message', listener);

  return {
    post(envelope, _sender) {
      return new Promise((resolve, reject) => {
        // F-M1：对端未响应时超时 reject 并清理，不永久驻留
        const timer = setTimeout(() => {
          if (pending.delete(envelope.requestId)) {
            reject(new Error(`transport post ${envelope.requestId} timed out after ${pendingTimeoutMs}ms`));
          }
        }, pendingTimeoutMs);
        pending.set(envelope.requestId, { resolve, reject, timer });
        targetWindow.postMessage({ __channel: channel, ...envelope }, '*');
      });
    },
    // F-M6：移除 message 监听器并拒绝所有在途请求
    close() {
      selfWindow.removeEventListener('message', listener);
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`transport closed (${id})`));
      }
      pending.clear();
    },
  };
}

/**
 * chrome.runtime.sendMessage 风格传输。host 未注入 chrome.runtime 时静默降级为
 * 拒绝（调用方按 UNAUTHORIZED / 无接收方处理），不抛错。
 */
export function createRuntimeMessageTransport(): Transport {
  const hasRuntime =
    typeof globalThis !== 'undefined' &&
    (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime?.sendMessage != null;
  return {
    post(envelope) {
      if (!hasRuntime) {
        return Promise.reject(new Error('chrome.runtime.sendMessage unavailable'));
      }
      const chrome = (globalThis as unknown as { chrome: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } }).chrome;
      return chrome.runtime.sendMessage(envelope);
    },
  };
}
