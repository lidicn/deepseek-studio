export * from './envelope';
export * from './transport';
export * from './runtime';
export * from './storage';

import { createRuntimeBridge, type RuntimeBridge } from './runtime';
import { createChromeStorageShim, type ChromeStorageShim, type StorageKvBackend } from './storage';
import { decodeRuntimeMessageEnvelope, type RuntimeMessageEnvelope } from './envelope';
import type { Transport } from './transport';

const STUDIO_EXTENSION_ID = 'deepseek-studio';

/** 未注入宿主传输时，sendMessage 直接拒绝（调用方按无接收方 fail-closed 处理）。 */
function noopTransport(): Transport {
  return { post: () => Promise.reject(new Error('chrome.runtime unavailable: no host transport installed')) };
}

export interface InstallChromeShimsOptions {
  transport?: Transport;
  extensionId?: string;
  /** v0.7：local storage 落盘 backend（缺省内存）。 */
  localBackend?: StorageKvBackend;
}

/**
 * 把 window.chrome.runtime.* / chrome.storage.* 指到桥接层。
 *
 * 这是「仿真行为不仿真限制」的落点：core/** 在桌面 WebView 里仍看到与 MV3 一致的
 * chrome.runtime / chrome.storage 契约，但底层实现换成常驻宿主（Rust KV、一次性 grant）。
 */
export function installChromeShims(options: InstallChromeShimsOptions = {}): void {
  const transport = options.transport ?? noopTransport();
  const bridge: RuntimeBridge = createRuntimeBridge({ transport });
  const storage: ChromeStorageShim = createChromeStorageShim({ localBackend: options.localBackend });
  const id = options.extensionId ?? STUDIO_EXTENSION_ID;

  const runtime = {
    id,
    getURL: (path: string) => `chrome-extension://${id}/${path.replace(/^\//, '')}`,
    getManifest: () => ({ manifest_version: 3, name: 'DeepSeek++ Studio', version: '0.2.0' }),
    get lastError() {
      return bridge.lastError.get();
    },
    sendMessage: (message: unknown, callback?: (response: unknown) => void): Promise<unknown> => {
      const envelope: RuntimeMessageEnvelope =
        decodeRuntimeMessageEnvelope(message) ??
        ({ command: 'bridge_invoke', requestId: crypto.randomUUID(), payload: message } as RuntimeMessageEnvelope);
      const promise = bridge.post(envelope);
      if (callback) promise.then(callback, () => callback(undefined));
      return promise;
    },
    onMessage: {
      addListener: (fn: (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => void) => {
        bridge.addListener((env, sender, sendResponse) => fn(env.payload, sender, sendResponse));
      },
      removeListener: () => {
        // v0.2：监听器随桥生命周期存在；取消注册在 v0.5 完整性探测时再细化。
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = { runtime, storage };
}
