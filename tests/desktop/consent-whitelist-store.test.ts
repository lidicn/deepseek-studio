import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { createWhitelistStore } from '../../src/host/consent-whitelist-store';

function makeHomedir() {
  const files = new Map<string, string>();
  const mkdirs = new Set<string>();
  const home = process.platform === 'win32' ? 'C:\\Users\\u' : '/home/u';
  return {
    files,
    mkdirs,
    deps: {
      homedir: home,
      readFile: (p: string) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p)!;
      },
      writeFile: (p: string, data: string) => files.set(p, data),
      mkdirp: (p: string) => mkdirs.add(p),
    },
    path: path.join(home, '.config', 'deepseek-studio', 'consent-whitelist.json'),
  };
}

describe('consent-whitelist-store v2', () => {
  let ctx: ReturnType<typeof makeHomedir>;
  beforeEach(() => { ctx = makeHomedir(); });

  it('空目录首次 load 返回空且不写文件', () => {
    const s = createWhitelistStore(ctx.deps);
    const r = s.load();
    expect(r.entries).toEqual([]);
    expect(ctx.files.has(ctx.path)).toBe(false);
  });

  it('add 成功：写入 v2 含 source/grantScope/targetKind/targetPattern', () => {
    const s = createWhitelistStore(ctx.deps);
    const r = s.add({ toolId: 'file.read', action: 'read', pathPattern: 'src/**/*.ts', workspaceHash: 'wh_1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.source).toBe('user');
      expect(r.entry.grantScope).toBe('project');
      expect(r.entry.targetKind).toBe('path');
      expect(r.entry.targetPattern).toBe('src/**/*.ts');
      expect(r.entry.actionClass).toBe('read');
      expect(r.entry.pathPattern).toBe('src/**/*.ts'); // 别名保留
    }
    const saved = JSON.parse(ctx.files.get(ctx.path)!);
    expect(saved.version).toBe(2);
    expect(saved.entries[0].targetPattern).toBe('src/**/*.ts');
  });

  it('带 ttlMs 的条目 grantScope=temporary，而不是 project', () => {
    const s = createWhitelistStore(ctx.deps);
    const r = s.add({ toolId: 'file.write', action: 'write', pathPattern: 'tmp/x.txt', workspaceHash: 'wh_1', ttlMs: 60_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.grantScope).toBe('temporary');
      expect(r.entry.ttlMs).toBe(60_000);
    }
  });

  it('拒绝绝对路径 / 盘符 / .. / 空 / >512 字符', () => {
    const s = createWhitelistStore(ctx.deps);
    expect(s.add({ toolId: 'file.read', action: 'read', pathPattern: '/etc/passwd', workspaceHash: 'wh_1' }).ok).toBe(false);
    expect(s.add({ toolId: 'file.read', action: 'read', pathPattern: 'C:/Windows/x', workspaceHash: 'wh_1' }).ok).toBe(false);
    expect(s.add({ toolId: 'file.read', action: 'read', pathPattern: '../secret', workspaceHash: 'wh_1' }).ok).toBe(false);
    expect(s.add({ toolId: 'file.read', action: 'read', pathPattern: '', workspaceHash: 'wh_1' }).ok).toBe(false);
    expect(s.add({ toolId: 'file.read', action: 'read', pathPattern: 'a'.repeat(513), workspaceHash: 'wh_1' }).ok).toBe(false);
  });

  it('v1 文件迁移：pathPattern→targetKind=path，带 ttlMs→temporary', () => {
    ctx.files.set(ctx.path, JSON.stringify({
      version: 1,
      entries: [
        { id: 'a1', toolId: 'file.read', action: 'read', pathPattern: 'src/**', workspaceHash: 'wh_1', createdAt: 1000 },
        { id: 'a2', toolId: 'file.write', action: 'write', pathPattern: 'tmp/**', workspaceHash: 'wh_1', createdAt: 1000, ttlMs: 5000 },
      ],
    }));
    const s = createWhitelistStore(ctx.deps);
    const r = s.load();
    expect(r.migrated).toBe(true);
    expect(r.entries).toHaveLength(2);
    const [e1, e2] = r.entries;
    expect(e1.source).toBe('user');
    expect(e1.targetKind).toBe('path');
    expect(e1.targetPattern).toBe('src/**');
    expect(e1.grantScope).toBe('project');
    expect(e2.grantScope).toBe('temporary');
    expect(e2.ttlMs).toBe(5000);
  });

  it('迁移时丢弃脏条目（绝对路径/..），不报错', () => {
    ctx.files.set(ctx.path, JSON.stringify({
      version: 1,
      entries: [
        { id: 'good', toolId: 'file.read', action: 'read', pathPattern: 'ok/**', workspaceHash: 'wh_1', createdAt: 1 },
        { id: 'bad1', toolId: 'file.read', action: 'read', pathPattern: '/etc/x', workspaceHash: 'wh_1', createdAt: 1 },
        { id: 'bad2', toolId: 'file.read', action: 'read', pathPattern: '../x', workspaceHash: 'wh_1', createdAt: 1 },
        { id: 'bad3', toolId: 'file.read', action: 'read', pathPattern: 'C:/x', workspaceHash: 'wh_1', createdAt: 1 },
      ],
    }));
    const s = createWhitelistStore(ctx.deps);
    const r = s.load();
    expect(r.entries.map(e => e.id)).toEqual(['good']);
  });

  it('达到 200 上限拒绝新增', () => {
    const s = createWhitelistStore(ctx.deps);
    for (let i = 0; i < 200; i++) {
      const r = s.add({ toolId: 'file.read', action: 'read', pathPattern: `p${i}/**`, workspaceHash: 'wh_1' });
      expect(r.ok).toBe(true);
    }
    const overflow = s.add({ toolId: 'file.read', action: 'read', pathPattern: 'x/**', workspaceHash: 'wh_1' });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toBe('limit-exceeded');
  });

  it('remove / list(workspaceHash) / invalidateWorkspace 正常', () => {
    const s = createWhitelistStore(ctx.deps);
    s.add({ toolId: 'file.read', action: 'read', pathPattern: 'a/**', workspaceHash: 'wh_1' });
    s.add({ toolId: 'file.read', action: 'read', pathPattern: 'b/**', workspaceHash: 'wh_2' });
    expect(s.list('wh_1')).toHaveLength(1);
    expect(s.list()).toHaveLength(2);
    expect(s.invalidateWorkspace('wh_1')).toBe(1);
    expect(s.list()).toHaveLength(1);
  });

  // ===== T3：STUDIO_CONFIG_DIR 优先于 homedir 回落 =====
  it('STUDIO_CONFIG_DIR 环境变量存在时 → 文件落在该目录（不落 homedir）', () => {
    const saved = process.env.STUDIO_CONFIG_DIR;
    const tmp = path.join('C:', 'fake-studio-config');
    process.env.STUDIO_CONFIG_DIR = tmp;
    try {
      const files = new Map<string, string>();
      const mkdirs = new Set<string>();
      const store = createWhitelistStore({
        homedir: '/unused', // 应被 STUDIO_CONFIG_DIR 覆盖
        readFile: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)!; },
        writeFile: (p, d) => files.set(p, d),
        mkdirp: (p) => mkdirs.add(p),
      });
      store.add({ toolId: 'file.read', action: 'read', pathPattern: 'src/**', workspaceHash: 'wh_x' });
      // 路径验证：应落 STUDIO_CONFIG_DIR 下
      const expectedPath = path.join(tmp, 'consent-whitelist.json');
      expect(store.path).toBe(expectedPath);
      expect(files.has(expectedPath)).toBe(true);
      expect(mkdirs.has(tmp)).toBe(true);
      expect(store.list()).toHaveLength(1);
      // revoke 后 list 变短
      store.list().forEach((e) => store.remove(e.id));
      expect(store.list()).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = saved;
    }
  });

  it('deps.configDir 最高优先级（覆盖 STUDIO_CONFIG_DIR 与 homedir）', () => {
    const saved = process.env.STUDIO_CONFIG_DIR;
    process.env.STUDIO_CONFIG_DIR = path.join('C:', 'env-dir');
    try {
      const files = new Map<string, string>();
      const store = createWhitelistStore({
        homedir: '/unused',
        configDir: path.join('C:', 'dep-dir'),
        readFile: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)!; },
        writeFile: (p, d) => files.set(p, d),
        mkdirp: () => { /* noop */ },
      });
      expect(store.path).toBe(path.join('C:', 'dep-dir', 'consent-whitelist.json'));
    } finally {
      if (saved === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = saved;
    }
  });
});
