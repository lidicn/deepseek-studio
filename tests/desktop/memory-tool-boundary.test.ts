/**
 * D-5 回归：记忆写入必须验「工具边界」，不能只验 store。
 *
 * 2026-10-26 真机验收（HEAD af4989a）发现：经真实工具链同名保存后，
 * `pinned` 由 1 变 0、`tags_json` 由 ["a","b"] 变 []。16 条既有用例直连
 * `store.save()`，恰好绕过目录 / 适配 / handler 三层，因此全绿。
 *
 * 本文件走完整链：memory_save payload -> tool-contract 适配 -> 宿主归一 -> store.save。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { MemoryStore } from '../../src/host/memory-store';
import { normalizeMemorySaveParams } from '../../src/host/memory-tool-params';
import { mapUpstreamToolInvocation } from '../../src/shared/tool-contract';
import { capabilityPromptText, catalogText } from '../../src/inject/main-world-interceptor';

const tmpRoot = path.join(os.tmpdir(), `studio-d5-boundary-${Date.now()}`);
let seq = 0;

function newStore(): MemoryStore {
  seq += 1;
  return new MemoryStore(path.join(tmpRoot, `d5-${seq}.db`));
}

/** 复刻真实链路：模型发出 <memory_save>{...}</memory_save> 之后的全部处理。 */
function viaToolChain(store: MemoryStore, payload: Record<string, unknown>) {
  const mapped = mapUpstreamToolInvocation('memory_save', payload);
  expect(mapped).not.toBeNull();
  expect(mapped?.id).toBe('memory.save');
  return store.save(normalizeMemorySaveParams(mapped?.params as Record<string, unknown>));
}

beforeEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  await fsp.mkdir(tmpRoot, { recursive: true });
  seq = 0;
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe('D-5 记忆工具边界：有则转、无则不传', () => {
  it('创建时显式 pinned:true 必须落库为 true（旧实现恒为 false）', async () => {
    const store = newStore();
    const r = viaToolChain(store, {
      type: 'user',
      name: 'd5-create',
      content: '内容甲',
      tags: ['a', 'b'],
      pinned: true,
    });
    expect(r.ok).toBe(true);
    const row = await store.get(r.id as string);
    expect(row?.pinned).toBe(true);
    expect(row?.tags).toEqual(['a', 'b']);
    store.close();
  });

  it('同名只改 content：tags 与 pinned 必须保留（真机回归点）', async () => {
    const store = newStore();
    const first = viaToolChain(store, {
      type: 'user',
      name: 'd5-keep',
      content: '内容甲',
      tags: ['a', 'b'],
      pinned: true,
    });
    const second = viaToolChain(store, { type: 'user', name: 'd5-keep', content: '内容乙' });

    expect(second.id).toBe(first.id);
    const row = await store.get(first.id as string);
    expect(row?.content).toBe('内容乙');
    expect(row?.pinned).toBe(true);
    expect(row?.tags).toEqual(['a', 'b']);
    store.close();
  });

  it('负控：显式 tags:[] 仍然要能清空', async () => {
    const store = newStore();
    const first = viaToolChain(store, {
      type: 'user',
      name: 'd5-clear-tags',
      content: '内容甲',
      tags: ['a', 'b'],
    });
    viaToolChain(store, { type: 'user', name: 'd5-clear-tags', content: '内容甲', tags: [] });
    const row = await store.get(first.id as string);
    expect(row?.tags).toEqual([]);
    store.close();
  });

  it('负控：显式 pinned:false 仍然要能取消置顶', async () => {
    const store = newStore();
    const first = viaToolChain(store, {
      type: 'user',
      name: 'd5-clear-pin',
      content: '内容甲',
      pinned: true,
    });
    viaToolChain(store, { type: 'user', name: 'd5-clear-pin', content: '内容甲', pinned: false });
    const row = await store.get(first.id as string);
    expect(row?.pinned).toBe(false);
    store.close();
  });

  it('缺省创建：不传 tags/pinned 时仍按默认值落库（[] / false）', async () => {
    const store = newStore();
    const r = viaToolChain(store, { type: 'user', name: 'd5-default', content: '内容甲' });
    const row = await store.get(r.id as string);
    expect(row?.pinned).toBe(false);
    expect(row?.tags).toEqual([]);
    expect(row?.source).toBe('agent');
    store.close();
  });
});

describe('D-5 目录文案：模型必须被告知 pinned', () => {
  function memorySaveLine(text: string): string {
    // 只取「## 可用工具」里的目录条目行，避开 prompt 里的 <memory_save>{...} 示例。
    return text.split('\n').find((line) => line.trimStart().startsWith('- memory_save')) ?? '';
  }

  it('首轮能力提示词列出 pinned', () => {
    expect(memorySaveLine(capabilityPromptText())).toContain('pinned');
  });

  it('续跑目录同样列出 pinned', () => {
    expect(memorySaveLine(catalogText())).toContain('pinned');
  });
});
