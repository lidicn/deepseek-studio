import { describe, it, expect } from 'vitest';
import {
  createChromeStorageShim,
  type StorageKvBackend,
  type StorageKvWriteBatch,
} from '../../src/bridge/storage';

/**
 * R2-C1 回归：并发 set 不得丢更新。
 *
 * 缺陷机理（修复前）：
 *   setOperation 是「读快照 new Map(items) -> await backend.writeBatch() -> 全量替换 items」
 *   的读改写序列。commit 不是原子的：两次并发 set 会在 await writeBatch 的 IO 窗口内交错，
 *   后完成者用自己那份（基于旧快照的）next 全量覆盖 items，抹掉先完成者写入的 key。
 *
 * 本用例用「可挂起的后端」确定性地制造该交错：
 *   1. p1 = set({k1:1}) 进入 writeBatch 并阻塞；
 *   2. p2 = set({k2:2}) 在 p1 完成前跑完自己的 commit（修复前）；
 *   3. 放行 p1。
 * 修复前：p1 最后全量替换 -> items 只剩 {k1:1}（k2 丢失）。
 * 修复后：p2 排队等待 p1 完成，读到的快照已含 k1 -> items = {k1:1, k2:2}。
 */
describe('bridge storage 并发（R2-C1 回归）', () => {
  it('两个并发 set 各自写一个 key，结果必须同时保留', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markEnteredFirst!: () => void;
    const enteredFirst = new Promise<void>((resolve) => {
      markEnteredFirst = resolve;
    });

    let writeCall = 0;
    const backend: StorageKvBackend = {
      async readAll(): Promise<Record<string, unknown>> {
        return {};
      },
      async writeBatch(_batch: StorageKvWriteBatch): Promise<void> {
        writeCall += 1;
        if (writeCall === 1) {
          markEnteredFirst();
          await firstBlocked; // 卡住第一个写，制造交错窗口
        }
      },
    };

    const shim = createChromeStorageShim({ localBackend: backend });

    const p1 = shim.local.set({ k1: 1 });
    await enteredFirst; // 确保 p1 已进入 writeBatch 且被阻塞

    const p2 = shim.local.set({ k2: 2 });
    // 给 p2 机会在有缺陷的实现里跑完自己的 commit；
    // 修复后 p2 会排队等待，不会进入 writeBatch。
    await new Promise((resolve) => setTimeout(resolve, 20));

    releaseFirst();
    await Promise.all([p1, p2]);

    expect(await shim.local.get()).toEqual({ k1: 1, k2: 2 });
  });

  it('并发 set 与 remove 交错，remove 掉的键不得被复活', async () => {
    const shim = createChromeStorageShim();
    await shim.local.set({ keep: 1, drop: 2 });
    await Promise.all([shim.local.set({ add: 3 }), shim.local.remove('drop')]);
    expect(await shim.local.get()).toEqual({ keep: 1, add: 3 });
  });
});
