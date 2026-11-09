/**
 * 同域直连桥 · 安装
 *
 * 在给定文档（window-like target）上安装一对 content↔注入脚本 的直连桥。
 * sessionId 由装载器在创建 DirectTarget 时一并写入两端，页面脚本无法伪造。
 *
 * ── R6-H1 修复（2026-11-09）：**两端必须能分清"谁发的"** ──
 *
 * 缺陷（本次修复前）：两端拿到的是**同一个 sessionId**，而 `direct-port` 只校验
 * `data.__session === sessionId`，**没有 sender 判据**；而两端的 listener 挂在
 * **同一个 origin 总线**（`direct-target.ts` 的 `busFor(origin)`）上 ⇒
 * **自己 post 的消息自己也会收到**。后果：`content.post(x)` 会被 `content.onMessage`
 * 自己消费一遍——同一帧被处理两次，来源不可信。
 *
 * 修法：给每条消息加一个**方向标记 `__from`**（发送侧写自己这一端的 side），
 * 接收侧 `from === 自己` 直接丢弃。`__session` 的原有校验**一字不动**（它是防伪装的）。
 *
 * ⚠️ **不许的写法**：给两端传**不同的 sessionId**。`direct-port` 的判据是"必须相等才收"，
 * 拆成两份 session 的结果不是"自己不收到"，而是**谁也都收不到、桥当场断**。
 * 方向区分必须是**新增的独立字段**，不能复用防伪装的那一格。
 */

import { createDirectTarget, type DirectTarget } from './direct-target';
import { createDirectBridge, type DirectBridge } from './direct-bridge';

export interface BridgeInstallOptions {
  origin: string;
  sessionId: string;
  reportError?: (message: string, error?: unknown) => void;
  /** 测试/复用场景：复用同一总线（默认按 origin 新建）。 */
  target?: DirectTarget;
}

export interface InstalledBridge {
  readonly target: DirectTarget;
  readonly content: DirectBridge;
  readonly injected: DirectBridge;
  disconnect(): void;
}

export function installDirectBridge(options: BridgeInstallOptions): InstalledBridge {
  const target = options.target ?? createDirectTarget(options.origin);
  // 两端共用同一个 sessionId（防伪装），但各自带**不同的 side 标记**（防自发自收）。
  const content = createDirectBridge({
    target,
    sessionId: options.sessionId,
    side: 'content',
    reportError: options.reportError,
  });
  const injected = createDirectBridge({
    target,
    sessionId: options.sessionId,
    side: 'injected',
    reportError: options.reportError,
  });
  content.start();
  injected.start();
  return {
    target,
    content,
    injected,
    disconnect() {
      content.disconnect();
      injected.disconnect();
    },
  };
}
