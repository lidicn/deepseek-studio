// QD-R23-D1（审计 R1.6 缺陷候选）：MCP testConnection 路径缺 stdin 'error' 监听 → EPIPE 未处理面
//
// 背景：connectStdio 路径有 proc.stdin?.on('error')（mcp-controller.ts:786）；
// testConnection 的 spawn 段（:1084-1108）只有 proc.on('error')（P0-3）与 stdout data，
// **没有 stdin 监听**（两条路径不对称）。本用例为负控 + 硬化证据：
// mock「initialize 即响应、300ms 自杀」。当前实测绿 = EPIPE 窗口在 500ms 启动检查之后
// 不足以在测试运行内触发 uncaught（写全部落入内核缓冲）；价值：① 固化「无监听」事实
// （若后续测试窗口拉长/平台行为变化即转红）② 团队加一行 proc.stdin?.on('error') 后
// 本用例作为回归正控常驻。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpController } from '../../../../src/host/mcp-controller';

const MOCK = [
  "process.stdin.on('data', (c) => {",
    "try {",
      "const m = JSON.parse(String(c).trim());",
      "if (m && m.method === 'initialize') {",
        "const o = { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-r23', version: '0' } } };",
        "process.stdout.write(JSON.stringify(o) + String.fromCharCode(10));",
        "setTimeout(() => process.exit(0), 300);",
      "}",
    "} catch { /* 非 initialize / 空块：忽略 */ }",
  "});",
].join('\n');

describe('QD-R23-D1 testConnection EPIPE 面', () => {
  it('server 在测试窗口内退出时，宿主不产生 uncaughtException', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-mcp-'));
    const fixture = path.join(dir, 'mock-mcp.js');
    fs.writeFileSync(fixture, MOCK, 'utf8');

    const uncaught: unknown[] = [];
    const handler = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', handler);
    try {
      const c = new McpController();
      const r = await c.testConnection(
        { transport: 'stdio', command: process.execPath, args: [fixture] },
        { stepTimeoutMs: 2000 },
      );
      await new Promise((res) => setTimeout(res, 500));
      expect(r.ok, 'tools/list 应超时失败（mock 已死）').toBe(false);
      expect(uncaught, '宿主侧出现 uncaughtException（stdin EPIPE 无监听）').toEqual([]);
    } finally {
      process.removeListener('uncaughtException', handler);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});