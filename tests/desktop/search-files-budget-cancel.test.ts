/**
 * 卡 ㊿-b ②：search_files 慢检索治理（宿主侧）。
 *
 * 现场（装版 storage.json，turn 4922ceac）：
 *   ① `root` 传文件（af_service.py）→ 宿主回裸 `invalid-argument`，模型靠试错学工具契约；
 *   ② `grep` 大目录（E:/NAS/AutoForge）无任何遍历预算 → 75,002 ms 才被页端 75s 截断；
 *   ③ 页端超时后宿主侧遍历继续跑 ⇒ 孤儿遍历（用户看到 host-timeout，机器还在读盘）。
 *
 * 三格分别对应本文件的三个 describe：
 *   - root 必须为目录（可操作错误：content 里写明 local_file_read / 父目录+glob 两条出路）
 *   - 遍历预算（深度/条目/文件数/耗时，truncatedReason 披露 + hint）
 *   - 取消链（tool-cancel → 宿主 AbortController → 能力层 cancelled，不再跑完）
 */

import { describe, expect, it, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { grepFiles, listFiles } from '../../src/capabilities/search-files';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import { WebSocket } from 'ws';

const roots: string[] = [];
const running: DesktopHost[] = [];

afterEach(async () => {
  while (running.length) {
    const h = running.pop();
    try { await h?.stop(); } catch { /* 已停 */ }
  }
});

function mkRootSync(): string {
  // fsp.mkdtemp 是异步的；这里用同步版保持用例体内简洁。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('node:fs') as typeof import('node:fs');
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sf-b50b-'));
  roots.push(root);
  return root;
}

/** 深度 15 层、每层 1 文件的窄深树（测 maxDepth 用）。 */
function makeDeepTree(depth: number): string {
  const root = mkRootSync();
  let cur = root;
  for (let i = 0; i < depth; i++) {
    cur = path.join(cur, `d${i}`);
    fsSyncMkdir(cur);
    fsSyncWrite(path.join(cur, 'f.txt'), 'hello\n');
  }
  return root;
}

let fsSyncMkdir: (p: string) => void;
let fsSyncWrite: (p: string, data: string) => void;
// 顶层初始化同步辅助（require 已在上面用过一次；这里直接拿句柄）
{
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('node:fs') as typeof import('node:fs');
  fsSyncMkdir = (p) => fsSync.mkdirSync(p, { recursive: true });
  fsSyncWrite = (p, data) => fsSync.writeFileSync(p, data);
}

describe('㊿-b② root 必须为目录（可操作错误）', () => {
  it('root 传文件 → invalid-argument + content 写明 local_file_read / 父目录两条出路', async () => {
    const root = mkRootSync();
    const file = path.join(root, 'af_service.py');
    fsSyncWrite(file, 'x = 1\n');

    const res = await grepFiles({ root: file, query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-argument');
    const text = res.content?.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    expect(text).toContain('local_file_read');
    expect(text).toContain(path.dirname(file));
    const details = res.details as { reason?: string; kind?: string; parent?: string };
    expect(details.reason).toBe('root-not-directory');
    expect(details.kind).toBe('file');
    expect(details.parent).toBe(path.dirname(file));
  });

  it('宿主接线同口径：invokeTool({root: 文件}) 也能拿到可操作文案', async () => {
    const tmp = mkRootSync();
    const file = path.join(tmp, 'a.py');
    fsSyncWrite(file, 'x = 1\n');
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(tmp),
      policyMode: 'auto',
    });
    await host.start();
    running.push(host);
    const res = await host.invokeTool('search_files', { operation: 'grep', root: file, query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('invalid-argument');
    const text = res.content?.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '';
    expect(text).toContain('local_file_read');
  });

  it('root 是正常目录 → 不受影响（防误伤）', async () => {
    const root = mkRootSync();
    fsSyncWrite(path.join(root, 'a.txt'), 'hello\n');
    const res = await grepFiles({ root, query: 'hello' });
    expect(res.ok).toBe(true);
  });
});

describe('㊿-b② 遍历预算', () => {
  it('深度超 maxDepth → depthLimited，结果披露 truncatedReason=max-depth', async () => {
    const root = makeDeepTree(10);
    const res = await listFiles({ root, limits: { maxDepth: 3 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; hint?: string; entries: Array<{ path: string }> };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('max-depth');
    expect(data.hint).toContain('root');
    // 第 4 层以下不可见
    expect(data.entries.some((e) => e.path.split('/').length > 3)).toBe(false);
  });

  it('条目超 maxEntries → 停止遍历，truncatedReason=max-entries', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 10; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const res = await listFiles({ root, limits: { maxEntries: 4 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; total: number; scanned: { entries: number } };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('max-entries');
    expect(data.total).toBeLessThanOrEqual(4);
    expect(data.scanned.entries).toBeLessThanOrEqual(5);
  });

  it('grep 读文件数超 maxFiles → truncatedReason=max-files', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 8; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'needle\n');
    const res = await grepFiles({ root, query: 'needle', limits: { maxFiles: 3 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; matches: unknown[]; scanned: { files: number } };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('max-files');
    expect(data.scanned.files).toBeLessThanOrEqual(4);
  });

  it('timeBudgetMs 压到 0 后的下一枚即停 → truncatedReason=time-budget（不跑完整棵树）', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 200; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const res = await listFiles({ root, limits: { timeBudgetMs: 1 } });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('time-budget');
  });

  it('不超预算 → truncated=false，无 truncatedReason', async () => {
    const root = mkRootSync();
    fsSyncWrite(path.join(root, 'a.txt'), 'hello\n');
    const res = await listFiles({ root });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string };
    expect(data.truncated).toBe(false);
    expect(data.truncatedReason).toBeUndefined();
  });

  it('命中条数上限（limit）→ truncatedReason=limit（既有行为保留，但披露原因）', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 10; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const res = await listFiles({ root, limit: 3 });
    expect(res.ok).toBe(true);
    const data = res.data as { truncated: boolean; truncatedReason?: string; total: number };
    expect(data.truncated).toBe(true);
    expect(data.truncatedReason).toBe('limit');
    expect(data.total).toBe(3);
  });
});

describe('㊿-b② 取消链（孤儿遍历治理）', () => {
  it('能力层：signal 已 abort → 立即返回 cancelled（不产出结果）', async () => {
    const root = mkRootSync();
    fsSyncWrite(path.join(root, 'a.txt'), 'hello\n');
    const ac = new AbortController();
    ac.abort();
    const res = await grepFiles({ root, query: 'hello', signal: ac.signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cancelled');
    expect(res.details).toMatchObject({ reason: 'cancelled' });
  });

  it('能力层：遍历中途 abort → 尽快收口为 cancelled（可证伪：时限 < 全树扫描）', async () => {
    const root = mkRootSync();
    for (let i = 0; i < 4000; i++) fsSyncWrite(path.join(root, `f${i}.txt`), 'x');
    const ac = new AbortController();
    // 20ms 后撤销（模拟页端中途超时）；全树 4000 文件顺序读远超这个时限。
    const t = setTimeout(() => ac.abort(), 20);
    const started = Date.now();
    const res = await grepFiles({ root, query: 'zzz-no-hit-anywhere', signal: ac.signal });
    clearTimeout(t);
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cancelled');
    // 可证伪边界：中途收口应在秒级完成；若实现退化成"扫完整棵树才检查"，
    // 4000 文件的读取会让 elapsed 超出这条线（本机全扫实测秒级以上）。
    expect(elapsed).toBeLessThan(5000);
  });

  it('宿主链路：页端 tool-cancel → 宿主 abort → 能力层返回 cancelled，回执 cancelled', async () => {
    const tmp = mkRootSync();
    for (let i = 0; i < 400; i++) fsSyncWrite(path.join(tmp, `f${i}.txt`), 'hello\n');
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(tmp),
      policyMode: 'auto',
    });
    await host.start();
    running.push(host);
    const port = Number(new URL(host.url).port);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p-cancel' }));
    await new Promise<void>((resolve) => {
      const onMsg = (raw: unknown): void => {
        const m = JSON.parse(String((raw as { data: string }).data ?? raw));
        if ((m as { type: string }).type === 'hello-ack') {
          ws.off('message', onMsg);
          resolve();
        }
      };
      ws.on('message', onMsg);
    });

    // 页端发 tool-call（长遍历），宿主开始执行；随后页端发 tool-cancel。
    const callId = 'cancel-me-1';
    const cancelledReply = new Promise<Record<string, unknown>>((resolve) => {
      const onMsg = (raw: unknown): void => {
        const buf = Array.isArray(raw) ? (raw[0] as unknown) : raw;
        const m = JSON.parse(String((buf as { data?: string }).data ?? buf)) as Record<string, unknown>;
        if (m.type === 'tool-call-result' && m.callId === callId) {
          ws.off('message', onMsg);
          resolve(m);
        }
      };
      ws.on('message', onMsg);
    });
    ws.send(JSON.stringify({ type: 'tool-call', callId, invocationName: 'search_files', params: { operation: 'list' } }));
    // 给宿主一点时间进入执行（walk 已在途）
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: 'tool-cancel', callId, reason: 'page-timeout' }));
    const reply = await Promise.race([
      cancelledReply,
      new Promise((r) => setTimeout(() => r({ timeout: true }), 8000)),
    ]) as Record<string, unknown>;
    expect(reply.timeout).toBeUndefined();
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('cancelled');
    ws.close();
  });
});
