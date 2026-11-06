/**
 * tests/desktop/mcp-config-hardening.test.ts
 *
 * 批 1（P0 硬化）· mcp 配置的**两条系统性判据**（PM 裁定二十一/二十二）：
 *   1. **IO/解析失败必须与「空状态」可区分**（损坏 ≠ 从未配置）
 *   2. **所有配置写入必须原子**（temp + rename，不留半截文件）
 *
 * 背景那条链：非原子写 → 磁盘满/中断 → 半截 JSON → `loadMcpServers` 的 catch 读成 `{}`
 * → 面板显示「一台都没有」→ 用户保存一台 → `saveServer` 的 catch 同样吞掉 parse 失败、
 * 从空表起写 → **用户其余 MCP 配置全部静默丢失**。
 *
 * 全部用例走 `mkdtemp` 合成夹具，**不碰用户真实配置目录**（那里有用户自己的 TVPilot）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpController, loadMcpServers, loadMcpServersState } from '../../src/host/mcp-controller';

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-hard-'));
  cfg = path.join(dir, 'mcp-servers.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeRaw(content: string): void {
  fs.writeFileSync(cfg, content, 'utf8');
}

describe('负控①：损坏文件经 saveServer 必须拒写 + 产生 .corrupt-<ts> 备份', () => {
  it('半截 JSON → saveServer 返回 config-corrupt，原文件一字不动，出现备份', () => {
    const broken = '{"servers": {"a": {"command": "node"'; // 半截（模拟写一半被打断）
    writeRaw(broken);
    const ctl = new McpController(cfg);

    const r = ctl.saveServer('newbie', { command: 'node', args: ['x.js'] } as never);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('config-corrupt');

    // 关键：**原文件必须一字不动**（拒写，而不是从空表重建）
    expect(fs.readFileSync(cfg, 'utf8')).toBe(broken);

    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    // 备份内容 = 损坏原文（供人工恢复）
    expect(fs.readFileSync(path.join(dir, backups[0]), 'utf8')).toBe(broken);
  });

  it('损坏时**不**产生「只有新条目」的空表（反向：拒绝比覆盖安全）', () => {
    writeRaw('{not json at all');
    const ctl = new McpController(cfg);
    ctl.saveServer('onlyOne', { command: 'node' } as never);
    // 文件仍是损坏原文，没有被改写成 {servers:{onlyOne:…}}
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{not json at all');
  });
});

describe('负控②：半截 JSON 经 loadMcpServers 必须报错而非返回空表', () => {
  it('loadMcpServersState → ok:false / config-corrupt', () => {
    writeRaw('{"servers": {');
    const st = loadMcpServersState(cfg);
    expect(st.ok).toBe(false);
    if (!st.ok) expect(st.error).toBe('config-corrupt');
  });

  it('文件不存在 → ok:true + 空表（ENOENT 是合法空状态，不是失败）', () => {
    const st = loadMcpServersState(path.join(dir, 'nope.json'));
    expect(st.ok).toBe(true);
    if (st.ok) expect(st.servers).toEqual({});
  });

  it('兼容签名 loadMcpServers 仍返回对象（既有调用方不被破坏）', () => {
    writeRaw('{"servers": {"a": {"command": "node"}}}');
    expect(Object.keys(loadMcpServers(cfg))).toEqual(['a']);
  });

  it('reload 遇到损坏 → 保留旧配置与连接（不再把所有连接断开）', () => {
    writeRaw('{"servers": {"a": {"command": "node"}}}');
    const ctl = new McpController(cfg);
    expect(ctl.listServerIds()).toEqual(['a']);

    writeRaw('{"servers": broken');
    ctl.reload();
    // 损坏时保留旧配置：面板仍能看到 a，而不是「一台都没有」
    expect(ctl.listServerIds()).toEqual(['a']);
  });
});

describe('负控③：写失败时磁盘原文件必须完好', () => {
  it('目标文件被占用/不可写 → 抛错，但原内容不变、无半截', () => {
    const good = { servers: { keep: { command: 'node', args: ['keep.js'] } } };
    writeRaw(JSON.stringify(good, null, 2));
    const before = fs.readFileSync(cfg, 'utf8');
    const ctl = new McpController(cfg);

    // 让 rename 失败（模拟目标被独占 / 磁盘满）
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    try {
      const r = ctl.saveServer('b', { command: 'node' } as never);
      expect(r.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(cfg, 'utf8')).toBe(before);
  });
});

describe('负控④：原子写不留半截文件、不残留 tmp', () => {
  it('saveServer 成功后无 .tmp 残留，且内容是完整 JSON', () => {
    const ctl = new McpController(cfg);
    expect(ctl.saveServer('a', { command: 'node', args: ['a.js'] } as never).ok).toBe(true);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8')) as { servers: Record<string, unknown> };
    expect(Object.keys(parsed.servers)).toEqual(['a']);
  });

  it('Windows 上 rename 覆盖已存在文件可行（第二次保存不报错）', () => {
    const ctl = new McpController(cfg);
    expect(ctl.saveServer('a', { command: 'node' } as never).ok).toBe(true);
    expect(ctl.saveServer('b', { command: 'node' } as never).ok).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8')) as { servers: Record<string, unknown> };
    expect(Object.keys(parsed.servers).sort()).toEqual(['a', 'b']);
  });
});

describe('正控：正常读写行为不变', () => {
  it('保存 → 读回 → 删除，语义与改前一致', () => {
    const ctl = new McpController(cfg);
    expect(ctl.saveServer('a', { command: 'node', args: ['a.js'] } as never).ok).toBe(true);
    expect(Object.keys(loadMcpServers(cfg))).toEqual(['a']);
    expect(ctl.listServerIds()).toEqual(['a']);
  });

  it('历史平铺式配置（顶层键）仍被兼容读入', () => {
    writeRaw(JSON.stringify({ legacy: { command: 'node', url: undefined } }, null, 2));
    expect(Object.keys(loadMcpServers(cfg))).toEqual(['legacy']);
  });
});
