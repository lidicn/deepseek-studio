/**
 * deepseek-studio 注入加载器 · 契约类型（镜像 deepseek-pp/src/entrypoints/content/lifecycle.ts）
 *
 * 与上游保持结构一致；本仓只「使用」上游的 replaceContentDocumentLifecycle，
 * 不在本地重做资源管理。为可独立测试，契约在此定义，运行期经动态 import 接入上游实现。
 */

export type ContentLifecycleStopReason =
  | 'pagehide'
  | 'reinjection'
  | 'extension-invalidated'
  | 'manual'
  | 'startup-failed';

export type ContentResourceKind =
  | 'listener'
  | 'observer'
  | 'timeout'
  | 'interval'
  | 'animation-frame'
  | 'dom-root'
  | 'message-port'
  | 'cleanup';

export interface ContentResourceSnapshot {
  readonly total: number;
  readonly byKind: Readonly<Record<ContentResourceKind, number>>;
}

export interface ContentResourceScope {
  readonly signal: AbortSignal;
  readonly active: boolean;
  addCleanup(kind: ContentResourceKind, cleanup: () => void | Promise<void>): () => Promise<void>;
  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): () => Promise<void>;
  observe(observer: { disconnect(): void }, target: Node, options: MutationObserverInit): () => Promise<void>;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(frame: number): void;
  ownRoot<T extends Node>(root: T): T;
  ownPort<T extends MessagePort>(port: T): T;
  snapshot(): ContentResourceSnapshot;
}

export interface ContentCapabilityController {
  readonly id: string;
  start(scope: ContentResourceScope, epoch: number): void | Promise<void>;
  stop(reason: ContentLifecycleStopReason): void | Promise<void>;
}

export interface ContentLifecycleKernel {
  start(): Promise<number>;
  stop(reason: ContentLifecycleStopReason): Promise<void>;
  snapshot(): {
    state: 'stopped' | 'starting' | 'running' | 'stopping';
    epoch: number;
    resources: ContentResourceSnapshot;
    capabilities: Readonly<Record<string, ContentResourceSnapshot>>;
  };
}

export interface ContentDocumentLifecycle {
  readonly kernel: ContentLifecycleKernel;
  start(): Promise<number>;
  dispose(reason: ContentLifecycleStopReason): Promise<void>;
}

/** 上游 replaceContentDocumentLifecycle 的签名（结构镜像）。 */
export interface ReplaceContentDocumentLifecycleOptions {
  capabilities: readonly ContentCapabilityController[];
  onError?: (error: unknown, capabilityId: string) => void;
}

export type ReplaceContentDocumentLifecycle = (
  options: ReplaceContentDocumentLifecycleOptions,
) => Promise<ContentDocumentLifecycle>;

export type InjectionStatus = 'pending' | 'running' | 'skipped' | 'failed';

export interface InjectionBootstrapOptions {
  /** 目标源白名单，默认 ['https://chat.deepseek.com']（大小写不敏感比对 location.origin）。 */
  originWhitelist?: string[];
  /** 路由变化是否触发重装载，默认 false。 */
  reinjectOnRouteChange?: boolean;
  /** 开启 reinjectOnRouteChange 时的最大重装载次数，默认 8。 */
  maxReinjections?: number;
  /** 要编排的能力模块（严格实现 ContentCapabilityController）。 */
  capabilities: readonly ContentCapabilityController[];
  /** 注入断言失败是否阻断（默认 false = fail-open 仅告警）。 */
  strictInstallOrder?: boolean;
  /** 测试/宿主注入的 lifecycle 工厂，默认动态加载上游实现。 */
  lifecycleFactory?: ReplaceContentDocumentLifecycle;
  /** 测试注入的 onError 回调（startup-failed 路径）。 */
  onStartupError?: (error: unknown) => void;
}

export interface InjectionResult {
  readonly installed: boolean;
  readonly status: InjectionStatus;
  readonly generation: number;
  readonly reason?: string;
}
