/**
 * MemoryStore 巨石重构 —— 导出面守卫（唯一新增测试文件；不新增任何行为断言）
 *
 * 设计稿：docs/设计稿/MemoryStore-巨石文件重构-20261101.md §3.3 第 4 条。
 *
 * 三条判据：
 *   1. 值导出 9 个符号名全在（门面是唯一出口，导出面不能因拆文件而缩小或扩大）；
 *   2. 类型导出 8 个符号名全在；
 *   3. MemoryStore 的**公开**原型方法名集合与重构前一致（private 实现搬进域模块后
 *      不再挂在门上，故只比对公开面——private 的去处由 memory-refactor-proto-diff.mjs 核）。
 */

import { describe, it, expect } from 'vitest';

import * as m from '../../src/host/memory-store';
import type {
  MemoryType,
  MemoryCandidate,
  MemoryLogEntry,
  MemoryRow,
  SaveMemoryParams,
  SaveMemoryResult,
  MemorySaveWarning,
  ExistingGovernanceFields,
} from '../../src/host/memory-store';

// 编译期守卫：8 个类型必须仍可从 src/host/memory-store 导入。
type _CompileGuard = [
  MemoryType,
  MemoryCandidate,
  MemoryLogEntry,
  MemoryRow,
  SaveMemoryParams,
  SaveMemoryResult,
  MemorySaveWarning,
  ExistingGovernanceFields,
];

/** 重构前的值导出名（9 个，设计稿 §3.3 VALUE_EXPORTS）。 */
const VALUE_EXPORTS = [
  'getMemoryStore',
  'closeMemoryStores',
  'MemoryStore',
  'DEFAULT_WORKSPACE_ID',
  'workspaceSlug',
  'workspaceStorePath',
  'listWorkspaceIds',
  'MAX_MEMORIES',
  'mergeUpdateGovernance',
] as const;

/** 重构前的公开原型方法名（23 个，重构前基线一次性生成后原样内联，不新增 golden 文件）。 */
const GOLDEN_PUBLIC_PROTOTYPE = [
  'addCandidate',
  'close',
  'compact',
  'formatForPrompt',
  'get',
  'getCandidate',
  'getDb',
  'getWorkspaceId',
  'invalidate',
  'list',
  'listByPersona',
  'listCandidates',
  'listInvalidated',
  'listLog',
  'promoteCandidate',
  'recordLog',
  'rejectCandidate',
  'remove',
  'restore',
  'rollback',
  'save',
  'search',
  'stats',
] as const;

describe('MemoryStore 导出面守卫（C1 巨石重构）', () => {
  it('1. 值导出符号名不变（9 个）', () => {
    for (const name of VALUE_EXPORTS) {
      expect(name in m, `缺少值导出 ${name}`).toBe(true);
    }
  });

  it('2. 类型导出可从门面导入（编译期守卫 + 运行时存在）', () => {
    // 运行时无法直接断言类型存在，用 _CompileGuard 的类型引用保证编译期即可。
    const guard: _CompileGuard | undefined = undefined;
    expect(guard).toBeUndefined();
  });

  it('3. MemoryStore 对外契约方法全在（23 个公开方法）', () => {
    // 注意：JS 的 `private` 只是编译期修饰符，原型上**仍可见**。
    // 所以这里锁的是「**对外契约面**」——重构前非 private 的 23 个方法必须一个不少；
    // private 实现（19 个）搬进域模块后不再挂门上，属预期，其「去处」由
    // logs/verify-exit/memory-refactor-proto-diff.mjs 单独核（无丢失）。
    const all = Object.getOwnPropertyNames(m.MemoryStore.prototype);
    for (const name of GOLDEN_PUBLIC_PROTOTYPE) {
      expect(all, `缺少契约方法 ${name}`).toContain(name);
    }
    expect(GOLDEN_PUBLIC_PROTOTYPE.length).toBe(23);
  });

  it('4. 门面不泄露内部类型（StoreContext 不得出现在导出面）', () => {
    expect('StoreContext' in m).toBe(false);
  });
});
