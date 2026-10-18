import { describe, it, expect } from 'vitest';
import { createShadowStore, MAX_SNAPSHOT_BYTES } from '../../src/host/shadow-store';

function makeStore() {
  const files = new Map<string, Buffer>();
  const jsonFiles = new Map<string, unknown>();
  const store = createShadowStore({
    homedir: '/home/user',
    readFile: (p: string) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p)!;
    },
    writeFile: (p: string, data: Buffer) => { files.set(p, data); },
    readJson: <T,>(p: string): T => {
      if (!jsonFiles.has(p)) throw new Error('ENOENT');
      return jsonFiles.get(p) as T;
    },
    writeJson: (p: string, data: unknown) => { jsonFiles.set(p, data); },
    exists: (p: string) => files.has(p) || jsonFiles.has(p),
    mkdirp: () => {},
    unlink: (p: string) => { files.delete(p); jsonFiles.delete(p); },
  });
  return { store, files, jsonFiles };
}

describe('shadow-store · capture', () => {
  it('新文件 capture 成功，size=0', () => {
    const { store } = makeStore();
    const r = store.capture({ absPath: '/ws/new.txt', relPath: 'new.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.size).toBe(0);
      expect(r.record.source).toBe('file.edit');
    }
  });

  it('已存在文件 capture 成功，checksum 正确', () => {
    const { store, files } = makeStore();
    files.set('/ws/a.txt', Buffer.from('hello'));
    const r = store.capture({ absPath: '/ws/a.txt', relPath: 'a.txt', workspaceHash: 'ws-1', source: 'file.write' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.size).toBe(5);
      expect(r.record.checksum).toBeTruthy();
    }
  });

  it('缺字段 → invalid-argument', () => {
    const { store } = makeStore();
    const r = store.capture({ absPath: '', relPath: 'a.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid-argument');
  });

  it('绝对 relPath → invalid-argument', () => {
    const { store } = makeStore();
    const r = store.capture({ absPath: '/ws/a.txt', relPath: '/etc/a.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    expect(r.ok).toBe(false);
  });

  it('.. 段 → invalid-argument', () => {
    const { store } = makeStore();
    const r = store.capture({ absPath: '/ws/a.txt', relPath: '../etc/a.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    expect(r.ok).toBe(false);
  });

  it('超过 16 MiB → file-too-large', () => {
    const { store, files } = makeStore();
    files.set('/ws/big.bin', Buffer.alloc(MAX_SNAPSHOT_BYTES + 1));
    const r = store.capture({ absPath: '/ws/big.bin', relPath: 'big.bin', workspaceHash: 'ws-1', source: 'file.edit' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('file-too-large');
  });
});

describe('shadow-store · rollback', () => {
  it('capture → 改文件 → rollback 还原', () => {
    const { store, files } = makeStore();
    files.set('/ws/a.txt', Buffer.from('original'));
    const c = store.capture({ absPath: '/ws/a.txt', relPath: 'a.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    if (!c.ok) throw new Error('capture failed');
    files.set('/ws/a.txt', Buffer.from('modified'));
    const rb = store.rollback(c.record.id);
    expect(rb.ok).toBe(true);
    expect(files.get('/ws/a.txt')?.toString()).toBe('original');
  });

  it('rollback 不存在 id → not-found', () => {
    const { store } = makeStore();
    const r = store.rollback('sh_nonexistent');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not-found');
  });
});

describe('shadow-store · list / remove / invalidate', () => {
  it('list 按 workspaceHash 过滤', () => {
    const { store } = makeStore();
    store.capture({ absPath: '/ws1/a.txt', relPath: 'a.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    store.capture({ absPath: '/ws2/b.txt', relPath: 'b.txt', workspaceHash: 'ws-2', source: 'file.edit' });
    expect(store.list().length).toBe(2);
    expect(store.list('ws-1').length).toBe(1);
  });

  it('remove 删除快照', () => {
    const { store } = makeStore();
    const c = store.capture({ absPath: '/ws/a.txt', relPath: 'a.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    if (!c.ok) throw new Error('capture failed');
    expect(store.remove(c.record.id).ok).toBe(true);
    expect(store.list().length).toBe(0);
  });

  it('invalidateWorkspace 清对应工作区', () => {
    const { store } = makeStore();
    store.capture({ absPath: '/ws1/a.txt', relPath: 'a.txt', workspaceHash: 'ws-1', source: 'file.edit' });
    store.capture({ absPath: '/ws2/b.txt', relPath: 'b.txt', workspaceHash: 'ws-2', source: 'file.edit' });
    const removed = store.invalidateWorkspace('ws-1');
    expect(removed).toBe(1);
    expect(store.list('ws-1').length).toBe(0);
    expect(store.list('ws-2').length).toBe(1);
  });
});
