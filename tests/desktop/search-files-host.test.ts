/**
 * search_files 工具接线测试（ORD-001）
 *
 * 验证：search_files 已注册进 hostTools，list/grep 两种 operation 都能调通。
 */

import { describe, expect, it, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';

const running: DesktopHost[] = [];

afterEach(async () => {
  while (running.length) {
    const h = running.pop();
    try { await h?.stop(); } catch { /* 已停 */ }
  }
});

async function startHost(workspaceRoot: string): Promise<DesktopHost> {
  const workspace = createWorkspace(workspaceRoot);
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    workspace,
    policyMode: 'auto',
  });
  await host.start();
  running.push(host);
  return host;
}

describe('search_files 接线', () => {
  it('默认 list：能列出工作区根下的文件', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-host-'));
    await fsp.writeFile(path.join(tmp, 'a.txt'), 'hello');
    await fsp.mkdir(path.join(tmp, 'sub'));
    await fsp.writeFile(path.join(tmp, 'sub', 'b.txt'), 'world');

    const host = await startHost(tmp);
    const result = await host.invokeTool('search_files', { operation: 'list' });
    console.log('LIST result:', JSON.stringify(result, null, 2));

    expect(result.ok).toBe(true);
    const data = result.data as { entries: Array<{ path: string; type: string }> };
    expect(data.entries.some((e) => e.path === 'a.txt')).toBe(true);
    expect(data.entries.some((e) => e.path === 'sub/b.txt')).toBe(true);
  });

  it('grep：能在工作区内搜内容', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-host-'));
    await fsp.writeFile(path.join(tmp, 'a.txt'), 'hello world');
    await fsp.writeFile(path.join(tmp, 'b.txt'), 'goodbye');

    const host = await startHost(tmp);
    const result = await host.invokeTool('search_files', { operation: 'grep', query: 'hello' });

    expect(result.ok).toBe(true);
    const data = result.data as { matches: Array<{ file: string; text: string }> };
    expect(data.matches.length).toBeGreaterThanOrEqual(1);
    expect(data.matches[0].file).toBe('a.txt');
    expect(data.matches[0].text).toContain('hello');
  });
});
