/**
 * 同域直连桥 · Port
 *
 * 受 BridgeSession 保护的消息端口：post 自动附带 sessionId，onMessage 仅投递本 session 的消息。
 * 不依赖 window.postMessage 的全局可见通道，页面脚本即使能 dispatch 总线也无法通过 session 校验。
 */

import type { DirectTarget, DirectTargetMessageEvent } from './direct-target';

export interface DirectMessagePort {
  readonly sessionId: string;
  post(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): () => void;
  close(): void;
}

export interface DirectPortOptions {
  target: DirectTarget;
  sessionId: string;
  reportError?: (message: string, error?: unknown) => void;
}

export function createDirectMessagePort(options: DirectPortOptions): DirectMessagePort {
  const { target, sessionId, reportError } = options;
  const handlers = new Set<(message: Record<string, unknown>) => void>();

  const listener = (event: DirectTargetMessageEvent): void => {
    const data = event.data as { __session?: string; __payload?: Record<string, unknown> } | null;
    if (!data || data.__session !== sessionId) return; // 非法/伪造 session 直接丢弃
    if (data.__payload) {
      for (const h of [...handlers]) {
        try {
          h(data.__payload);
        } catch (err) {
          reportError?.('direct-port onMessage handler threw', err);
        }
      }
    }
  };

  target.addEventListener('message', listener);

  return {
    sessionId,
    post(message) {
      target.postMessage({ __session: sessionId, __payload: message });
    },
    onMessage(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close() {
      target.removeEventListener('message', listener);
      handlers.clear();
    },
  };
}
