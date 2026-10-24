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

describe('M10-7.1 同名 save() 未传治理字段保留原值（SQL 持久化路径）', () => {
  it('置顶行只更新 content、不传 pinned → 仍置顶', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'keep-pin', content: 'v1', pinned: true });
    s.save({ type: 'user', name: 'keep-pin', content: 'v2' }); // 不传 pinned
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.pinned).toBe(true);
    expect(row!.content).toBe('v2');
    s.close();
  });

  it('带 tags 的行只更新 content、不传 tags → tags 原样保留', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'keep-tags', content: 'v1', tags: ['a', 'b'] });
    s.save({ type: 'user', name: 'keep-tags', content: 'v2' }); // 不传 tags
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.tags).toEqual(['a', 'b']);
    s.close();
  });

  it('带 personaTags 的行只更新 content、不传 → personaTags 原样保留', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'keep-pt', content: 'v1', personaTags: ['工作', '家人'] });
    s.save({ type: 'user', name: 'keep-pt', content: 'v2' }); // 不传 personaTags
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.personaTags).toEqual(['工作', '家人']);
    s.close();
  });

  it('带 source/confidence 的行只更新 content、不传 → 原值保留', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'keep-sc', content: 'v1', source: 'curator', confidence: 0.9 });
    s.save({ type: 'user', name: 'keep-sc', content: 'v2' }); // 不传 source/confidence
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.source).toBe('curator');
    expect(row!.confidence).toBe(0.9);
    s.close();
  });

  it('显式 pinned=false 明确取消置顶（未传 ≠ 显式 false）', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'unpin', content: 'v1', pinned: true });
    s.save({ type: 'user', name: 'unpin', content: 'v2', pinned: false }); // 显式取消
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.pinned).toBe(false);
    s.close();
  });

  it('显式 tags=[] 明确清空（未传 ≠ 显式空数组）', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'clear-tags', content: 'v1', tags: ['keep'] });
    s.save({ type: 'user', name: 'clear-tags', content: 'v2', tags: [] }); // 显式清空
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.tags).toEqual([]);
    s.close();
  });

  it('归档行同名复活：未传 pinned/tags 时复活后仍保留原字段', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'revive-keep', content: 'v1', pinned: true, tags: ['x'] });
    await s.invalidate(first.id!);
    expect((await s.list()).find((m) => m.id === first.id)).toBeUndefined();
    s.save({ type: 'user', name: 'revive-keep', content: 'v2' }); // 不传 pinned/tags，复活
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.content).toBe('v2');
    expect(row!.pinned).toBe(true); // 复活保留置顶
    expect(row!.tags).toEqual(['x']); // 复活保留 tags
    s.close();
  });

  it('同内容只传 pinned:false → 必须取消置顶（不能被无变化早退吞掉）', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'only-pin', content: 'same', pinned: true });
    s.save({ type: 'user', name: 'only-pin', content: 'same', pinned: false }); // 内容相同
    const row = await s.get(first.id!);
    expect(row!.pinned).toBe(false);
    s.close();
  });

  it('同内容只传 tags:[] → 必须清空 tags', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'only-tags', content: 'same', tags: ['keep'] });
    s.save({ type: 'user', name: 'only-tags', content: 'same', tags: [] }); // 内容相同
    const row = await s.get(first.id!);
    expect(row!.tags).toEqual([]);
    s.close();
  });

  it('同内容只换 personaTags → 必须更新', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'only-pt', content: 'same', personaTags: ['old'] });
    s.save({ type: 'user', name: 'only-pt', content: 'same', personaTags: ['new'] });
    const row = await s.get(first.id!);
    expect(row!.personaTags).toEqual(['new']);
    s.close();
  });

  it('同内容只换 source/confidence → 必须更新', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'only-sc', content: 'same', source: 'agent', confidence: 0.5 });
    s.save({ type: 'user', name: 'only-sc', content: 'same', source: 'curator', confidence: 1 });
    const row = await s.get(first.id!);
    expect(row!.source).toBe('curator');
    expect(row!.confidence).toBe(1);
    s.close();
  });

  it('内容与所有治理字段均未变 → 真正 no-op（id 同、updatedAt 不搅动）', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'noop', content: 'c', pinned: true, tags: ['a'], personaTags: ['p'], source: 'x', confidence: 0.5 });
    const before = (await s.get(first.id!))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const again = s.save({ type: 'user', name: 'noop', content: 'c', pinned: true, tags: ['a'], personaTags: ['p'], source: 'x', confidence: 0.5 });
    expect(again.id).toBe(first.id);
    expect((await s.get(first.id!))!.updatedAt).toBe(before); // 未被搅动
    s.close();
  });
});

describe('M10-7.1 fallback 内存路径同语义（pinned + tags）', () => {
  function newFallback(): MemoryStore {
    return new MemoryStore(path.join(tmpRoot, 'bad\0path', 'memories.db'));
  }

  it('fallback：置顶行更新 content 不传 pinned → 仍置顶；带 tags 不传 → tags 保留', async () => {
    const s = newFallback();
    expect(s.stats().backend).toBe('memory');
    const first = s.save({ type: 'project', name: 'fb-keep', content: 'v1', pinned: true, tags: ['m'] });
    s.save({ type: 'project', name: 'fb-keep', content: 'v2' }); // 不传 pinned/tags
    const row = await s.get(first.id!);
    expect(row).toBeDefined();
    expect(row!.pinned).toBe(true);
    expect(row!.tags).toEqual(['m']);
    // 显式 false/[] 仍覆盖
    s.save({ type: 'project', name: 'fb-keep', content: 'v3', pinned: false, tags: [] });
    const row2 = await s.get(first.id!);
    expect(row2!.pinned).toBe(false);
    expect(row2!.tags).toEqual([]);
    s.close();
  });

  it('fallback：内容不变只改 pinned/tags → 必须落库', async () => {
    const s = newFallback();
    const first = s.save({ type: 'project', name: 'fb-only', content: 'same', pinned: true, tags: ['keep'] });
    s.save({ type: 'project', name: 'fb-only', content: 'same', pinned: false, tags: [] });
    const row = await s.get(first.id!);
    expect(row!.pinned).toBe(false);
    expect(row!.tags).toEqual([]);
    s.close();
  });

  it('fallback：内容与全部治理字段均未变 → true no-op，updatedAt 不被搅动', async () => {
    const s = newFallback();
    const first = s.save({ type: 'project', name: 'fb-noop', content: 'c', pinned: true, tags: ['a'], personaTags: ['p'], source: 'x', confidence: 0.5 });
    const before = (await s.get(first.id!))!.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    const again = s.save({ type: 'project', name: 'fb-noop', content: 'c', pinned: true, tags: ['a'], personaTags: ['p'], source: 'x', confidence: 0.5 });
    expect(again.id).toBe(first.id);
    expect((await s.get(first.id!))!.updatedAt).toBe(before); // 未被搅动，与 SQL 路径一致
    s.close();
  });

  it('fallback：空白归一化后的同内容（a␣␣␣b vs a␣b）按 contentHash 判同 → true no-op', async () => {
    const s = newFallback();
    const first = s.save({ type: 'project', name: 'fb-ws', content: 'a   b' }); // 多空格
    const before = (await s.get(first.id!))!.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    s.save({ type: 'project', name: 'fb-ws', content: 'a b' }); // 单空格，规范化后 hash 相同
    const row = await s.get(first.id!);
    expect(row!.updatedAt).toBe(before); // hash 归一判同 → 不覆盖、不搅动时间
    s.close();
  });
});

describe('M10-7.2 跨名称同内容去重', () => {
  it('同 type、同 content、不同 name → 第二次复用既有 id，total 不增', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: '第一次的名字', content: '统一记忆内容' });
    const second = s.save({ type: 'user', name: '另一个名字', content: '统一记忆内容' });
    expect(second.id).toBe(first.id);
    expect(s.stats().total).toBe(1);
    const row = await s.get(first.id!);
    expect(row!.name).toBe('第一次的名字'); // 跨名去重保留首个名称
    s.close();
  });

  it('同 content、不同 type → 不去重，仍新增两行', () => {
    const s = newStore();
    const a = s.save({ type: 'user', name: 'n1', content: '共享内容' });
    const b = s.save({ type: 'project', name: 'n2', content: '共享内容' });
    expect(b.id).not.toBe(a.id);
    expect(s.stats().total).toBe(2);
    s.close();
  });

  it('大小写/连续空白规范化后相同 → 跨名命中去重', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'orig', content: 'Hello   WORLD' });
    const second = s.save({ type: 'user', name: 'another', content: 'hello world' });
    expect(second.id).toBe(first.id);
    expect(s.stats().total).toBe(1);
    s.close();
  });

  it('命中归档行 → 复活原行，不新建', async () => {
    const s = newStore();
    const first = s.save({ type: 'user', name: 'archived-name', content: '归档内容' });
    await s.invalidate(first.id!);
    expect((await s.list()).find((m) => m.id === first.id)).toBeUndefined();
    // 另一个 name，同内容 → 应复活归档行而非新建有效行
    const second = s.save({ type: 'user', name: 'revive-name', content: '归档内容' });
    expect(second.id).toBe(first.id);
    expect(s.stats().total).toBe(1);
    expect(s.stats().valid).toBe(1);
    s.close();
  });

  it('旧库无 dedupe_hash 列 → 打开后自动补列并回填，值非空', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mem-old-'));
    const dbPath = path.join(oldDir, 'old.db');
    // 手工建旧版 schema（无 dedupe_hash）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT, confidence REAL, persona_tags_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT, invalid_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO memories (id,type,name,content,tags_json,pinned,content_hash,persona_tags_json,created_at,updated_at)
      VALUES ('old-1','user','old','老内容','[]',0,'x','[]',1,1);
    `);
    raw.close();

    const s = new MemoryStore(dbPath);
    const cols = s.getDb()!.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'dedupe_hash')).toBe(true);
    const row = s.getDb()!.prepare('SELECT dedupe_hash FROM memories WHERE id = ?').get('old-1') as { dedupe_hash: string | null };
    expect(typeof row.dedupe_hash).toBe('string');
    expect(row.dedupe_hash!.length).toBeGreaterThan(0);
    s.close();
    fs.rmSync(oldDir, { recursive: true, force: true });
  });

  it('fallback 路径：跨名同内容去重 + 不同 type 不去重', () => {
    const s = new MemoryStore(path.join(tmpRoot, 'bad\0path', 'memories.db'));
    expect(s.stats().backend).toBe('memory');
    const a = s.save({ type: 'project', name: 'p1', content: 'fb 共享' });
    const b = s.save({ type: 'project', name: 'p2', content: 'fb 共享' });
    expect(b.id).toBe(a.id); // 跨名去重
    const c = s.save({ type: 'user', name: 'u1', content: 'fb 共享' });
    expect(c.id).not.toBe(a.id); // 不同 type 不去重
    s.close();
  });

  it('旧 memories.json 导入行 dedupe_hash 非空，且可被跨名同内容命中', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mem-legacy-dedupe-'));
    fs.writeFileSync(
      path.join(dir, 'memories.json'),
      JSON.stringify([{ id: 'mem-old', type: 'user', name: '旧名', content: '同一内容' }]),
      'utf8',
    );
    const s = new MemoryStore(path.join(dir, 'memories.db'));
    // 导入行 dedupe_hash 已写
    const row = s.getDb()!.prepare('SELECT dedupe_hash FROM memories WHERE id = ?').get('mem-old') as { dedupe_hash: string | null };
    expect(typeof row.dedupe_hash).toBe('string');
    expect(row.dedupe_hash!.length).toBeGreaterThan(0);
    // 不同 name、同 content → 复用旧 id，不新增
    const saved = s.save({ type: 'user', name: '新名字', content: '同一内容' });
    expect(saved.id).toBe('mem-old');
    expect(s.stats().total).toBe(1);
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('旧 JSON 导入数据经大小写/空白归一后也能跨名命中', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mem-legacy-ws-'));
    fs.writeFileSync(
      path.join(dir, 'memories.json'),
      JSON.stringify([{ id: 'mem-old2', type: 'user', name: '旧', content: 'Hello   WORLD' }]),
      'utf8',
    );
    const s = new MemoryStore(path.join(dir, 'memories.db'));
    const saved = s.save({ type: 'user', name: '别的名', content: 'hello world' });
    expect(saved.id).toBe('mem-old2');
    expect(s.stats().total).toBe(1);
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('旧 DB 空表无 dedupe 列 + memories.json：先加列再导入，且可跨名去重', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mem-emptyold-'));
    const dbPath = path.join(dir, 'memories.db');
    // 手工建旧版空表（无 dedupe_hash 列）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT, confidence REAL, persona_tags_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT, invalid_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    raw.close();
    // 同目录放旧 JSON
    fs.writeFileSync(
      path.join(dir, 'memories.json'),
      JSON.stringify([{ id: 'mem-old3', type: 'user', name: '旧名', content: '空表升级内容' }]),
      'utf8',
    );

    const s = new MemoryStore(dbPath);
    expect(s.stats().total).toBe(1); // 成功导入，未漏数据
    const row = s.getDb()!.prepare('SELECT dedupe_hash FROM memories WHERE id = ?').get('mem-old3') as { dedupe_hash: string | null };
    expect(typeof row.dedupe_hash).toBe('string');
    expect(row.dedupe_hash!.length).toBeGreaterThan(0);
    const saved = s.save({ type: 'user', name: '新名', content: '空表升级内容' });
    expect(saved.id).toBe('mem-old3');
    expect(s.stats().total).toBe(1);
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
