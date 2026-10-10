/**
 * 同域直连桥 · Bridge
 *
 * content 与注入脚本（同域）之间的可信通道。两端各持一个 sessionId（由装载器在创建时写入，
 * 页面脚本读不到），post 总是带 session，onMessage 仅接受本 session 的消息。
 * 同时实现 bridge 的 Transport 接口（见 src/bridge/transport），可直接挂到 RuntimeBridge。
 */

import type { DirectTarget } from './direct-target';
import { createDirectMessagePort, type DirectMessagePort } from './direct-port';

export interface BridgeSessionContext {
  readonly sessionId: string;
  readonly origin: string;
}

export interface ValidatedBridgeMessage {
  readonly sessionId: string;
  readonly message: Record<string, unknown>;
}

export interface DirectBridgeOptions {
  target: DirectTarget;
  sessionId: string;
  reportError?: (message: string, error?: unknown) => void;
}

export interface DirectBridge {
  readonly origin: string;
  readonly sessionId: string;
  readonly connected: boolean;
  start(): void;
  post(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): () => void;
  acceptsSession(candidate: BridgeSessionContext): boolean;
  disconnect(): void;
}

export function createDirectBridge(options: DirectBridgeOptions): DirectBridge {
  const { target, sessionId, reportError } = options;
  let port: DirectMessagePort | undefined;

  return {
    origin: target.origin,
    sessionId,
    get connected() {
      return port !== undefined;
    },
    start() {
      if (port) return;
      port = createDirectMessagePort({ target, sessionId, reportError });
    },
    post(message) {
      if (!port) throw new Error('direct-bridge: not connected; call start() first');
      port.post(message);
    },
    onMessage(listener) {
      if (!port) this.start();
      return port!.onMessage(listener);
    },
    acceptsSession(candidate) {
      return candidate.origin === target.origin && candidate.sessionId === sessionId;
    },
    disconnect() {
      port?.close();
      port = undefined;
    },
  };
}
