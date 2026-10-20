/**
 * 注入装配测试：installChromeShims + installStudio 在 Node 下（stub 全局）行为正确。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installChromeShims } from '../../src/bridge';
import { installStudio } from '../../src/desktop/entry';
import { createEchoCapability } from '../../src/capabilities/echo';
import type { ContentCapabilityController, ContentDocumentLifecycle } from '../../src/inject/types';

describe('注入装配（entry + shims）', () => {
  beforeEach(() => {
    // entry.ts:149 读 location.pathname 判登录页，stub 必须同时给 origin 与 pathname，
    // 否则 'Cannot read properties of undefined (reading includes)'（历史既有红灯）。
    (globalThis as { location?: { origin: string; pathname: string } }).location = {
      origin: 'https://chat.deepseek.com',
      pathname: '/chat',
    };
    // 幂等 shim：entry.ts 在 readyState==='loading' 时会挂 DOMContentLoaded 监听。
    // 测试环境是 node（非 jsdom），document 是纯 mock，这里补一个 no-op addEventListener，
    // 不触发真实 DOM 回调，也不影响其他测试文件的 jsdom 环境。
    (globalThis as { document?: { readyState: string; addEventListener: (type: string, listener: unknown, options?: unknown) => void } }).document = {
      readyState: 'loading',
      addEventListener: () => {},
    };
  });
  afterEach(() => {
    delete (globalThis as { location?: unknown }).location;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { __deepseekStudio?: unknown }).__deepseekStudio;
  });

  it('installChromeShims 挂上 window.chrome.runtime / storage', () => {
    installChromeShims();
    const chrome = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
    expect(chrome.runtime).toBeDefined();
    expect((chrome.runtime as { id: string }).id).toBe('deepseek-studio');
    expect(chrome.storage).toBeDefined();
    expect(typeof (chrome.runtime as { sendMessage: unknown }).sendMessage).toBe('function');
    expect((chrome.runtime as { getURL: (p: string) => string }).getURL('/icon.png')).toContain(
      'chrome-extension://',
    );
  });

  it('installStudio 装配直连桥并挂 window.__deepseekStudio', () => {
    const installed = installStudio({
      capabilities: [createEchoCapability()],
      lifecycleFactory: async ({ capabilities }: { capabilities: readonly ContentCapabilityController[] }) => {
        const started = capabilities.map((c) => c.id);
        const lifecycle = {
          kernel: {
            start: async () => 1,
            stop: async () => {},
            snapshot: () => ({
              state: 'running' as const,
              epoch: 1,
              resources: { total: 0, byKind: {} },
              capabilities: {},
            }),
          },
          start: async () => 1,
          dispose: async () => {},
        };
        void started;
        return lifecycle as unknown as ContentDocumentLifecycle;
      },
    });
    expect(installed.bridge.injected.connected).toBe(true);
    const studio = (globalThis as unknown as { __deepseekStudio: unknown }).__deepseekStudio;
    expect(studio).toBeDefined();
  });
});
