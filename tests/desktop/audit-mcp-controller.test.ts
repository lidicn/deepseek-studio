/**
 * R1-05：MCP stdio 进程缺失/已退出时 sendRequest 快速失败，不再空等 30s 定时器。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpController, removeMcpServer } from '../../src/host/mcp-controller';

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
