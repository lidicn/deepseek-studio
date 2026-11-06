// QD-R23-D4（死代码负控）：McpController.disconnectAll() 全仓 0 调用方——
// 宿主任何退出路径（关窗 / 孤儿防护 self-exit / SIGTERM-SIGBREAK / 崩溃）都不断开 MCP，
// stdio 型 MCP server 随宿主退出孤儿化（叠加 D2 无 tree-kill → 孙进程也漏）。
// 修复：宿主退出钩子调 disconnectAll（+ tree-kill）。负控：断言存在 ≥1 真实调用方。修复前红。
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function walk(dirPath: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dirPath)) {
    if (name === 'node_modules' || name === '.codegraph' || name === 'dist' || name === 'archive') continue;
    const full = path.join(dirPath, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('QD-R23-D4 disconnectAll 死代码 负控', () => {
  it('src 下存在 disconnectAll() 的真实调用（当前 0 → 红）', () => {
    const root = path.resolve(__dirname, '..', '..', '..', '..', 'src');
    let callers = 0;
    for (const f of walk(root)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line) => {
        if (!line.includes('disconnectAll()')) return;
        if (f.endsWith('mcp-controller.ts') && line.includes('disconnectAll():')) return; // 定义行
        callers += 1;
      });
    }
    expect(callers, 'disconnectAll() 无调用方：宿主退出不收尸 MCP 子进程').toBeGreaterThanOrEqual(1);
  });
});