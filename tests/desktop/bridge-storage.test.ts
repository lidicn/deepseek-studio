import { describe, it, expect } from 'vitest';
import { createChromeStorageShim, createMemoryStorageKvBackend, StorageBridgeError } from '../../src/bridge/storage';

describe('chrome storage shim', () => {
  it('get/set/remove/clear 基本语义', async () => {
    const shim = createChromeStorageShim();
    await shim.local.set({ a: 1, b: 'x' });
    expect(await shim.local.get('a')).toEqual({ a: 1 });
    expect(await shim.local.get()).toEqual({ a: 1, b: 'x' });
    expect(await shim.local.get({ a: 0, c: 9 })).toEqual({ a: 1, c: 9 });
    await shim.local.remove('a');
    expect(await shim.local.get('a')).toEqual({});
    await shim.local.clear();
    expect(await shim.local.get()).toEqual({});
  });

  it('session 轨进程内、不复用 local 后端', async () => {
    const shim = createChromeStorageShim();
    await shim.session.set({ token: 't' });
    expect(await shim.session.get('token')).toEqual({ token: 't' });
    expect(await shim.local.get('token')).toEqual({});
  });

  it('onChanged 在 set/remove 时按 areaName 触发', async () => {
    const shim = createChromeStorageShim();
    const seen: string[] = [];
    shim.onChanged.addListener((_changes, area) => seen.push(area));
    await shim.local.set({ k: 1 });
    await shim.session.set({ s: 2 });
    expect(seen).toContain('local');
    expect(seen).toContain('session');
  });

  it('不可序列化值抛 DATA_CLONE 且一个 key 都不写（fail-closed）', async () => {
    const shim = createChromeStorageShim();
    await shim.local.set({ ok: 1 });
    await expect(shim.local.set({ bad: () => 1 } as never)).rejects.toThrow(StorageBridgeError);
    // 未写入：ok 仍在，bad 不存在
    expect(await shim.local.get()).toEqual({ ok: 1 });
  });

  it('超过 QUOTA_BYTES 抛 QUOTA_BYTES', async () => {
    const shim = createChromeStorageShim({ quotaBytes: 10 });
    await expect(shim.local.set({ big: 'x'.repeat(20) })).rejects.toThrow(StorageBridgeError);
  });

  it('MemoryStorageKvBackend 持久化到后端', async () => {
    const backend = createMemoryStorageKvBackend({ seed: 1 });
    const shim = createChromeStorageShim({ localBackend: backend });
    await shim.local.set({ added: 2 });
    expect(backend.snapshot()).toEqual({ seed: 1, added: 2 });
  });
});
