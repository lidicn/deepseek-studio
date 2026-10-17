/**
 * R1-05：MCP stdio 进程缺失/已退出时 sendRequest 快速失败，不再空等 30s 定时器。
 */
import { describe, it, expect } from 'vitest';
import { McpController } from '../../src/host/mcp-controller';

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
