/**
 * 同域直连桥 · 合成 Target
 *
 * 用一个「按 origin 分桶的 EventTarget 总线」在同一文档内模拟 window.postMessage，
 * 但消息必须带本桥私有 sessionId 才被对端接受 —— 页面脚本无法伪造（消除 postMessage 攻击面）。
 * 这是对上游 runtime-boundary 的桌面等价替代（P0-#1 推荐方案：桥改同域直连）。
 */

export interface DirectTargetMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
  readonly ports: readonly unknown[];
}

export type DirectTargetListener = (event: DirectTargetMessageEvent) => void;

const buses = new Map<string, EventTarget>();

function busFor(origin: string): EventTarget {
  let bus = buses.get(origin);
  if (!bus) {
    bus = new EventTarget();
    buses.set(origin, bus);
  }
  return bus;
}

export interface DirectTarget {
  readonly origin: string;
  postMessage(data: unknown, _targetOrigin?: string, _transfer?: readonly unknown[]): void;
  addEventListener(type: string, listener: DirectTargetListener): void;
  removeEventListener(type: string, listener: DirectTargetListener): void;
  /** 仅供桥内部：向总线派发一条消息。 */
  readonly _dispatch: (data: unknown, source: unknown, ports: readonly unknown[]) => void;
}

export function createDirectTarget(origin: string): DirectTarget {
  const bus = busFor(origin);
  const wrapped = new WeakMap<DirectTargetListener, EventListener>();
  const self: DirectTarget = {
    origin,
    postMessage(data) {
      self._dispatch(data, self, []);
    },
    addEventListener(type, listener) {
      const fn = ((e: Event) => listener((e as unknown as { detail: DirectTargetMessageEvent }).detail)) as EventListener;
      wrapped.set(listener, fn);
      bus.addEventListener(type, fn);
    },
    removeEventListener(type, listener) {
      const fn = wrapped.get(listener);
      if (fn) bus.removeEventListener(type, fn);
    },
    _dispatch(data, source, ports) {
      const ev = new Event('message');
      (ev as unknown as { detail: DirectTargetMessageEvent }).detail = { data, origin, source, ports };
      bus.dispatchEvent(ev);
    },
  };
  return self;
}
