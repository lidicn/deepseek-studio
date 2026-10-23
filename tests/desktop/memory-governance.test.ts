/**
 * M10 记忆治理P1批验收：
 *   - M10-5 重名复活：作废行 + 同名 save 不另起一行（账本守恒）
 *   - M10-6 source 由宿主赋值，调用方传入的 source 被忽略
 *   - M10-7a 排序第二级：pinned → user → updated_at
 *   - M10-7b 注入预算两面共用 MEMORY_INJECT_LIMIT（40）
 *
 * 对应 QD 基线审计 R8m-05 / R8m-06 / R8m-07（docs/审计报告/QD/20261024-QD-R8-记忆系统.md §2 第 5/6/7 行）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { MemoryStore } from '../../src/host/memory-store';
import { MEMORY_INJECT_LIMIT, formatUntrustedMemoriesBlock } from '../../src/inject/untrusted-memory';

const tmpRoot = path.join(os.tmpdir(), `studio-mem-gov-${Date.now()}`);
let seq = 0;

function newStore(): MemoryStore {
  seq += 1;
  return new MemoryStore(path.join(tmpRoot, `mem-${seq}.db`));
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('M10-5 重名复活：作废后同名 save 复活原行', () => {
  it('作废 + 同名重存 → 总行数不变、有效 1、作废 0、id 复用', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'dup', content: 'v1' });
    expect(first.ok).toBe(true);
    await s.invalidate(first.id!);
    expect(s.stats().total).toBe(1);
    expect((await s.list()).length).toBe(0);

    const second = s.save({ type: 'user', name: 'dup', content: 'v2' });
    expect(second.ok).toBe(true);
    expect(second.id).toBe(first.id);
    const stats = s.stats();
    expect(stats.total).toBe(1);
    expect(stats.valid).toBe(1);
    expect(stats.invalidated).toBe(0);

    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('v2');
    s.close();
  });

  it('不同名字仍各自成行（复活不误伤）', async () => {
    const s = newStore();
    const a = s.save({ type: 'user', name: 'a', content: '1' });
    await s.invalidate(a.id!);
    s.save({ type: 'user', name: 'b', content: '2' });
    expect(s.stats().total).toBe(2);
    expect(s.stats().valid).toBe(1);
    expect(s.stats().invalidated).toBe(1);
    s.close();
  });

  it('复活后 FTS 索引跟着走（旧内容不再命中、新内容可命中）', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'dup-fts', content: '苹果派' });
    await s.invalidate(first.id!);
    s.save({ type: 'user', name: 'dup-fts', content: '橘子汁' });
    expect((await s.search('橘子汁')).length).toBe(1);
    expect((await s.search('苹果派')).length).toBe(0);
    s.close();
  });

  it('降级路径（node:sqlite 不可用）同样复活', async () => {
    const s = new MemoryStore(path.join(tmpRoot, 'bad\0path', 'memories.db'));
    expect(s.stats().backend).toBe('memory');
    const first = s.save({ type: 'project', name: 'dup-mem', content: 'v1' });
    await s.invalidate(first.id!);
    s.save({ type: 'project', name: 'dup-mem', content: 'v2' });
    expect(s.stats().total).toBe(1);
    expect((await s.list())[0].content).toBe('v2');
    s.close();
  });
});

describe('M10-7a 排序第二级：pinned → user → updated_at', () => {
  it('更新的 project 记忆不会挤掉更旧的个人记忆', async () => {
    const s = newStore();
    s.save({ type: 'user', name: 'user-old', content: 'u' });
    await new Promise((r) => setTimeout(r, 5));
    s.save({ type: 'project', name: 'proj-new', content: 'p' });
    expect((await s.list()).map((m) => m.name)).toEqual(['user-old', 'proj-new']);
    s.close();
  });

  it('置顶仍高于类型档（pinned 是第一级）', async () => {
    const s = newStore();
    s.save({ type: 'user', name: 'user-top', content: 'u' });
    s.save({ type: 'project', name: 'proj-pin', content: 'p', pinned: true });
    expect((await s.list()).map((m) => m.name)).toEqual(['proj-pin', 'user-top']);
    s.close();
  });
});

describe('M10-7b 注入预算：两侧共用 40', () => {
  it('宿主侧 formatForPrompt 默认最多 40 行', async () => {
    const s = newStore();
    for (let i = 0; i < 45; i += 1) {
      s.save({ type: 'project', name: `k${String(i).padStart(2, '0')}`, content: `c${i}` });
    }
    const lines = s.formatForPrompt(await s.list()).split('\n').filter((l) => l.startsWith('- #'));
    expect(lines.length).toBe(40);
    s.close();
  });

  it('页端 formatUntrustedMemoriesBlock 默认同预算', () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({
      id: `mem-${i}`,
      type: 'project',
      name: `k${i}`,
      content: `c${i}`,
    }));
    const block = formatUntrustedMemoriesBlock(rows);
    expect(MEMORY_INJECT_LIMIT).toBe(40);
    expect(block.split('\n').filter((l) => l.startsWith('- #')).length).toBe(40);
  });
});

describe('M10-6 source 由宿主赋值', () => {
  it('旧 memories.json 导入记为 import', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mem-import-'));
    fs.writeFileSync(
      path.join(dir, 'memories.json'),
      JSON.stringify([{ id: 'mem-old', type: 'user', name: '老记忆', content: 'c' }]),
      'utf8',
    );
    const s = new MemoryStore(path.join(dir, 'memories.db'));
    const list = await s.list();
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe('import');
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('memory.save 经宿主执行时忽略调用方传入的 source', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-mem-src-host-'));
    const previousConfigDir = process.env.STUDIO_CONFIG_DIR;
    process.env.STUDIO_CONFIG_DIR = tmpDir;
    vi.resetModules();
    const { createDesktopHost } = await import('../../src/host/desktop-host');
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      policyMode: 'full',
    });
    try {
      await host.start();
      // 页端连接在场：等待 hello 登记（与 memory-delete-consent 同一夹具形状）。
      const port = Number(new URL(host.url).port);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'mem-src' }));
          resolve();
        });
        ws.on('error', reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const saved = await host.invokeTool('memory.save', {
        type: 'user',
        name: 'src-probe',
        content: '模型自封来源',
        source: 'user',
        confidence: 1,
        personaTags: ['audit'],
      });
      expect(saved.ok).toBe(true);
      const id = (saved.data as { id: string }).id;

      const { getMemoryStore } = await import('../../src/host/memory-store');
      const row = await getMemoryStore().get(id);
      expect(row?.source).toBe('agent');
      // M10-6b：模型自封的 confidence / personaTags 一律不落地
      expect(row?.confidence).toBeUndefined();
      expect(row?.personaTags).toEqual([]);
      ws.close();
    } finally {
      await host.stop();
      if (previousConfigDir === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = previousConfigDir;
      const { getMemoryStore } = await import('../../src/host/memory-store');
      getMemoryStore().close();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('映射层是真正的收口点：memory_save 只转发 type/name/content/tags', async () => {
    const { mapUpstreamToolInvocation } = await import('../../src/shared/tool-contract');
    const mapped = mapUpstreamToolInvocation('memory_save', {
      type: 'user',
      name: 'n',
      content: 'c',
      source: 'user',
      confidence: 1,
      personaTags: ['audit'],
      pinned: true,
    });
    expect(mapped).not.toBeNull();
    expect(mapped!.params).toEqual({ type: 'user', name: 'n', content: 'c', tags: [] });
  });
});
