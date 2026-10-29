/**
 * R1-05：MCP stdio 进程缺失/已退出时 sendRequest 快速失败，不再空等 30s 定时器。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpController, getMcpServer, removeMcpServer } from '../../src/host/mcp-controller';

function fakeConn(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    transport: 'stdio' as const,
    process: null,
    requestId: 0,
    pendingRequests: new Map(),
    tools: [],
    initialized: true,
    ...over,
  };
}

describe('R1-05 MCP stdio 缺失进程快速失败', () => {
  it('process 为 null → 立即 reject（不等 30s）', async () => {
    const ctl = new McpController();
    const conn = fakeConn();
    const started = Date.now();
    await expect((ctl as unknown as { sendRequest(c: unknown, m: string, p: unknown): Promise<unknown> })
      .sendRequest(conn, 'tools/call', {})).rejects.toThrow('not running');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('conn.closed=true（已退出）→ 立即 reject', async () => {
    const ctl = new McpController();
    const conn = fakeConn({ closed: true, process: { stdin: { write() {} } } });
    const started = Date.now();
    await expect((ctl as unknown as { sendRequest(c: unknown, m: string, p: unknown): Promise<unknown> })
      .sendRequest(conn, 'tools/call', {})).rejects.toThrow('not running');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
describe('v1.9：removeMcpServer 支持嵌套 servers 结构', () => {
  it('删除后配置文件里不再有该服务器，其他服务器保留', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rm-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      servers: { A: { command: 'a', args: [] }, B: { command: 'b', args: [] } },
    }), 'utf8');
    const r = removeMcpServer('A', cfgPath);
    expect(r.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { servers: Record<string, unknown> };
    expect(Object.keys(after.servers)).toEqual(['B']);
  });

  it('历史平铺式（顶层键）也能删', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rm-flat-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ A: { command: 'a' }, B: { command: 'b' } }), 'utf8');
    expect(removeMcpServer('A', cfgPath).ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(['B']);
  });

  it('删除不存在的服务器 → ok=false（不再静默成功）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rm2-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: {} }), 'utf8');
    const r = removeMcpServer('nope', cfgPath);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('server not found');
  });
});
describe('v1.9：MCP 配置读回（HTTP 存了再开不能变 stdio）', () => {
  it('getMcpServer 返回真实 transport/url/headers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-get-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      servers: { TVPilot: { command: '', args: [], env: {}, transport: 'http', url: 'http://x/mcp', headers: { A: 'b' } } },
    }), 'utf8');
    const cfg = getMcpServer('TVPilot', cfgPath);
    expect(cfg?.transport).toBe('http');
    expect(cfg?.url).toBe('http://x/mcp');
    expect(cfg?.headers).toEqual({ A: 'b' });
  });

  it('不存在 → null（不伪造默认 stdio）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-get-none-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ servers: {} }), 'utf8');
    expect(getMcpServer('nope', cfgPath)).toBeNull();
  });

  it('saveServer 与 loadMcpServers 用同一路径（STUDIO_CONFIG_DIR 下 round-trip）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rt-'));
    const prevCfg = process.env.STUDIO_CONFIG_DIR;
    const prevMcp = process.env.STUDIO_MCP_CONFIG;
    try {
      delete process.env.STUDIO_MCP_CONFIG;
      process.env.STUDIO_CONFIG_DIR = dir;
      const ctl = new McpController();
      expect(ctl.saveServer('X', { command: 'x', transport: 'http', url: 'http://y/mcp' }).ok).toBe(true);
      // 同一控制器 reload 后必须读得到——原实现 load 读 ~/.config、save 写 STUDIO_CONFIG_DIR，读不回来
      ctl.reload();
      expect(ctl.listServerIds()).toContain('X');
      const cfg = getMcpServer('X');
      expect(cfg?.transport).toBe('http');
      expect(cfg?.url).toBe('http://y/mcp');
    } finally {
      if (prevCfg === undefined) delete process.env.STUDIO_CONFIG_DIR; else process.env.STUDIO_CONFIG_DIR = prevCfg;
      if (prevMcp === undefined) delete process.env.STUDIO_MCP_CONFIG; else process.env.STUDIO_MCP_CONFIG = prevMcp;
    }
  });
});

describe('MCP 热重载：配置变化必须断开旧连接', () => {
  type ConnBag = { connections: Map<string, unknown> };

  it('URL 变化 → reload 清除旧连接（否则继续用旧 token/URL）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reload-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      servers: { AutoForge: { command: '', transport: 'http', url: 'http://old/mcp' } },
    }), 'utf8');
    const ctl = new McpController(cfgPath);
    (ctl as unknown as ConnBag).connections.set('AutoForge', fakeConn({ id: 'AutoForge' }));

    fs.writeFileSync(cfgPath, JSON.stringify({
      servers: { AutoForge: { command: '', transport: 'http', url: 'http://new/mcp' } },
    }), 'utf8');
    ctl.reload(cfgPath);

    expect((ctl as unknown as ConnBag).connections.has('AutoForge')).toBe(false);
  });

  it('配置未变 → reload 保留已初始化连接（避免无谓重连）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reload-same-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      servers: { Keep: { command: '', transport: 'http', url: 'http://same/mcp' } },
    }), 'utf8');
    const ctl = new McpController(cfgPath);
    const conn = fakeConn({ id: 'Keep' });
    (ctl as unknown as ConnBag).connections.set('Keep', conn);

    ctl.reload(cfgPath);

    expect((ctl as unknown as ConnBag).connections.get('Keep')).toBe(conn);
  });

  it('saveServer 覆盖同一 id → 旧连接被清除', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-save-'));
    const cfgPath = path.join(dir, 'mcp-servers.json');
    const prev = process.env.STUDIO_CONFIG_DIR;
    process.env.STUDIO_CONFIG_DIR = dir;
    try {
      const ctl = new McpController(cfgPath);
      (ctl as unknown as ConnBag).connections.set('AutoForge', fakeConn({ id: 'AutoForge' }));

      const r = ctl.saveServer('AutoForge', { command: '', transport: 'http', url: 'http://new/mcp' });

      expect(r.ok).toBe(true);
      expect((ctl as unknown as ConnBag).connections.has('AutoForge')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.STUDIO_CONFIG_DIR;
      else process.env.STUDIO_CONFIG_DIR = prev;
    }
  });
});
