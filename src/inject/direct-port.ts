/**
 * 同域直连桥 · Port
 *
 * 受 BridgeSession 保护的消息端口：post 自动附带 sessionId 与**发送侧标记**，
 * onMessage 只投递"本 session + 不是我自己发的"消息。
 * 不依赖 window.postMessage 的全局可见通道，页面脚本即使能 dispatch 总线也无法通过 session 校验。
 *
 * ── R6-H1（2026-11-09）：`__from` 方向标记 ──
 *
 * 修复前：两端共用一个 sessionId，而同一 origin 的总线上**所有 listener 都会收到**
 * 任意一端 post 的消息 ⇒ **自己发的自己也会收到**（一帧被处理两次、来源不可信）。
 *
 * 现在：`post` 写入 `__from: side`，接收侧 `__from === 自己的 side` ⇒ **直接丢弃**。
 * `__session` 的校验**原样保留且先于 `__from`**——它是防伪装的（页面脚本拿不到 session），
 * `__from` 只解决"方向"，不承担任何安全职责：**伪造 `__from` 只能让自己收不到自己的消息，
 * 拿不到别人的**（`__session` 已经先把它挡掉了）。
 */

import type { DirectTarget, DirectTargetMessageEvent } from './direct-target';

/** 桥的两端。loader 决定谁是哪端；页面脚本控制不到这个值。 */
export type BridgeSide = 'content' | 'injected';

export interface DirectMessagePort {
  readonly sessionId: string;
  post(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): () => void;
  close(): void;
}

export interface DirectPortOptions {
  target: DirectTarget;
  sessionId: string;
  /** 本端身份（R6-H1）。缺省 undefined ⇒ 不做方向过滤（保持旧行为，仅供不区分方向的调用方）。 */
  side?: BridgeSide;
  reportError?: (message: string, error?: unknown) => void;
}

interface Envelope {
  __session?: string;
  __from?: string;
  __payload?: Record<string, unknown>;
}

export function createDirectMessagePort(options: DirectPortOptions): DirectMessagePort {
  const { target, sessionId, side, reportError } = options;
  const handlers = new Set<(message: Record<string, unknown>) => void>();

  const listener = (event: DirectTargetMessageEvent): void => {
    const data = event.data as Envelope | null;
    if (!data || data.__session !== sessionId) return; // 非法/伪造 session 直接丢弃
    // R6-H1：自己发的不收（只对"自己发的"生效——见文件头，这不承担安全职责）。
    if (side !== undefined && data.__from === side) return;
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
      // `__from` 只在对端需要区分方向时才有意义；没有 side 的调用方保持旧封包形状。
      const envelope: Envelope =
        side !== undefined
          ? { __session: sessionId, __from: side, __payload: message }
          : { __session: sessionId, __payload: message };
      target.postMessage(envelope);
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
