/**
 * 同域直连桥 · 安装
 *
 * 在给定文档（window-like target）上安装一对 content↔注入脚本 的直连桥。
 * sessionId 由装载器在创建 DirectTarget 时一并写入两端，页面脚本无法伪造。
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
  const content = createDirectBridge({ target, sessionId: options.sessionId, reportError: options.reportError });
  const injected = createDirectBridge({ target, sessionId: options.sessionId, reportError: options.reportError });
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
