import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createDesktopHost } from '../../src/host/desktop-host';
import {
  createMutableWorkspace,
  createWorkspace,
  defaultConfigPath,
  isWorkspaceConfigured,
  persistConfigPatch,
} from '../../src/host/workspace';

describe('MutableWorkspaceContext —— 热切换代理', () => {
  it('初始 null：configured=false，contains 恒 false，root 为空串', () => {
    const ws = createMutableWorkspace(null);
    expect(ws.configured).toBe(false);
    expect(ws.current).toBeNull();
    expect(ws.root).toBe('');
    expect(ws.contains('C:/anything')).toBe(false);
    expect(ws.resolveWithin('C:/anything')).toBeNull();
  });

  it('isWorkspaceConfigured 区分未配置代理与静态上下文', () => {
    expect(isWorkspaceConfigured(null)).toBe(false);
    expect(isWorkspaceConfigured(createMutableWorkspace(null))).toBe(false);
    expect(isWorkspaceConfigured(createMutableWorkspace(createWorkspace(os.tmpdir())))).toBe(true);
    expect(isWorkspaceConfigured(createWorkspace(os.tmpdir()))).toBe(true);
  });

  it('setRoot 热生效：能力持有的引用无需重建即可获得新边界', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-b-'));
    const ws = createMutableWorkspace(createWorkspace(dirA));
    expect(ws.contains(path.join(dirA, 'x.txt'))).toBe(true);
    expect(ws.contains(path.join(dirB, 'x.txt'))).toBe(false);

    ws.setRoot(dirB);
    expect(ws.configured).toBe(true);
    expect(ws.root).toBe(path.resolve(dirB));
    expect(ws.contains(path.join(dirB, 'x.txt'))).toBe(true);
    expect(ws.contains(path.join(dirA, 'x.txt'))).toBe(false);
  });

  it('setRoot(null) 撤销工作区', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-c-'));
    const ws = createMutableWorkspace(createWorkspace(dir));
    ws.setRoot(null);
    expect(ws.configured).toBe(false);
    expect(ws.contains(path.join(dir, 'x'))).toBe(false);
  });
});

describe('persistConfigPatch —— 配置持久化', () => {
  it('合并补丁并保留未知键', () => {
    let saved = '';
    const r = persistConfigPatch(
      { workspaceRoot: 'C:/proj' },
      {
        homedir: 'C:/Users/x',
        readFile: () => JSON.stringify({ token: 'abc', workspaceRoot: 'C:/old' }),
        writeFile: (_p, data) => {
          saved = data;
        },
      },
    );
    expect(r.ok).toBe(true);
    const bag = JSON.parse(saved) as Record<string, unknown>;
    expect(bag.token).toBe('abc');
    expect(bag.workspaceRoot).toBe('C:/proj');
  });

  it('配置不存在/损坏时以空配置起步', () => {
    let saved = '';
    const r = persistConfigPatch(
      { policyMode: 'workspace' },
      { homedir: 'C:/Users/x', readFile: () => '{not json', writeFile: (_p, d) => (saved = d) },
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(saved)).toEqual({ policyMode: 'workspace' });
  });

  it('writeFile 抛错 → ok=false 且带 error', () => {
    const r = persistConfigPatch(
      { policyMode: 'auto' },
      {
        homedir: 'C:/Users/x',
        readFile: () => '{}',
        writeFile: () => {
          throw new Error('EACCES');
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('EACCES');
  });
});

describe('v1.9：配置目录解析与写盘', () => {
  it('STUDIO_CONFIG_DIR 覆盖时，defaultConfigPath 指向该目录（否则面板设置写错地方）', () => {
    const prev = process.env.STUDIO_CONFIG_DIR;
    try {
      process.env.STUDIO_CONFIG_DIR = 'D:/custom-cfg';
      expect(defaultConfigPath('C:/Users/x')).toBe(path.join('D:/custom-cfg', 'config.json'));
    } finally {
      if (prev === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prev;
    }
  });

  it('未设置 STUDIO_CONFIG_DIR 时回落到 ~/.config/deepseek-studio', () => {
    const prev = process.env.STUDIO_CONFIG_DIR;
    try {
      delete process.env.STUDIO_CONFIG_DIR;
      expect(defaultConfigPath('C:/Users/x')).toBe(path.join('C:/Users/x', '.config', 'deepseek-studio', 'config.json'));
    } finally {
      if (prev !== undefined) process.env.STUDIO_CONFIG_DIR = prev;
    }
  });

  it('persistConfigPatch 实际写到 STUDIO_CONFIG_DIR 下（round-trip）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const prev = process.env.STUDIO_CONFIG_DIR;
    try {
      process.env.STUDIO_CONFIG_DIR = dir;
      const r = persistConfigPatch({ policyMode: 'full' });
      expect(r.ok).toBe(true);
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
      expect(written.policyMode).toBe('full');
    } finally {
      if (prev === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prev;
    }
  });
});
describe('v1.9：settings.get / workspace.set / policy.set 落盘链路', () => {
  it('workspace.set 与 policy.set 会把值写进 STUDIO_CONFIG_DIR 的 config.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-rt-'));
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rt-'));
    const prev = process.env.STUDIO_CONFIG_DIR;
    process.env.STUDIO_CONFIG_DIR = dir;
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: null,
      policyMode: 'auto',
    });
    try {
      // 走宿主导出的 setter（与 workspace.set / policy.set 工具内部同一实现）。
      // 工具层是 privileged，无页连接时会被同意闸门 fail-closed 拦下，不适合做落盘断言。
      const setWs = host.setWorkspaceRoot(wsDir);
      expect(setWs.ok).toBe(true);
      host.setPolicyMode('full');

      const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
      expect(written.policyMode).toBe('full');
      expect(String(written.workspaceRoot)).toBe(path.resolve(wsDir));

      const got = await host.invokeTool('settings.get', {});
      expect(got.ok).toBe(true);
      const data = got.data as { workspaceRoot: string; policyMode: string };
      expect(data.policyMode).toBe('full');
      expect(data.workspaceRoot).toBe(path.resolve(wsDir));
    } finally {
      if (prev === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prev;
    }
  });

  it('workspace.set 指向不存在的目录 → 失败且不落盘（fail-closed）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-bad-'));
    const prev = process.env.STUDIO_CONFIG_DIR;
    process.env.STUDIO_CONFIG_DIR = dir;
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's', workspace: null });
    try {
      const r = host.setWorkspaceRoot(path.join(dir, 'does-not-exist'));
      expect(r.ok).toBe(false);
      expect(r.error).toBe('not-a-directory');
    } finally {
      if (prev === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prev;
    }
  });
});
describe('lexicallyInside —— 路径逃逸判定（v0.19 双点前缀修复）', () => {
  // 用依赖注入构造 Windows 路径场景，避免真机文件系统依赖
  const winDeps = {
    realpath: (p: string) => p, // 不做 realpath，纯词法测试
    statSync: () => undefined,  // 目标不存在 → 走纯词法判定
    resolve: (p: string) => path.win32.resolve(p),
  };

  it('双点前缀的合法条目（..foo、..cache、..env）不被误判为越界', () => {
    const ws = createWorkspace('C:\\proj', winDeps);
    expect(ws.contains('C:\\proj\\..foo')).toBe(true);
    expect(ws.contains('C:\\proj\\..cache')).toBe(true);
    expect(ws.contains('C:\\proj\\sub\\..env')).toBe(true);
    expect(ws.contains('C:\\proj\\..foo\\bar')).toBe(true);
  });

  it('真正的父目录引用（..\\、..\\secret）仍被正确拒绝', () => {
    const ws = createWorkspace('C:\\proj', winDeps);
    expect(ws.contains('C:\\proj\\..')).toBe(false);
    expect(ws.contains('C:\\proj\\..\\secret')).toBe(false);
    expect(ws.contains('C:\\proj\\sub\\..\\..\\escape')).toBe(false);
  });

  it('工作区根自身始终包含', () => {
    const ws = createWorkspace('C:\\proj', winDeps);
    expect(ws.contains('C:\\proj')).toBe(true);
  });

  it('R1-02：相对路径以工作区根为基准，而不是进程 cwd', () => {
    const ws = createWorkspace('C:\\proj', winDeps);
    expect(ws.contains('src\\main.ts')).toBe(true);
    expect(ws.resolveWithin('src\\main.ts')).toBe('C:\\proj\\src\\main.ts');
    // 越界的相对路径仍被拒绝
    expect(ws.contains('..\\secret')).toBe(false);
    expect(ws.resolveWithin('..\\secret')).toBeNull();
  });

  it('根目录作为工作区时不失真（normalize 不变空串/裸盘符）', () => {
    // Windows C:\ 作为工作区根
    const wsRoot = createWorkspace('C:\\', winDeps);
    expect(wsRoot.contains('C:\\Users')).toBe(true);
    expect(wsRoot.contains('C:\\')).toBe(true);
    // D 盘不在 C 盘工作区内
    expect(wsRoot.contains('D:\\foo')).toBe(false);
  });
});
