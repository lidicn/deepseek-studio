/**
 * M10-5 归档生命周期：软删（memory.delete）→ 已归档列表（memory.listArchived）
 * → 恢复（memory.unarchive）→ 彻底删除（memory.purge）。
 *
 * 锁三件事：① 归档后不再进注入面但仍在账本；② 恢复后回到注入面；
 * ③ 三个写操作都过同意闸门，且每次变更都向页端广播最新生效列表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { HostToPageMessage } from '../../src/host/protocol';
import type { DesktopHost } from '../../src/host/desktop-host';

let host: DesktopHost | null = null;
let tmpDir = '';
let previousConfigDir: string | undefined;

function connectPage(target: DesktopHost, seen: HostToPageMessage[]): Promise<WebSocket> {
  const port = Number(new URL(target.url).port);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'mem-archive' }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as HostToPageMessage;
        seen.push(message);
        // 同意闸门：本文件所有用例都按「用户点了允许」处理。
        if (message.type === 'consent-required') {
          ws.send(JSON.stringify({ type: 'consent-decision', callId: message.callId, decision: 'allow' }));
        }
      } catch {
        /* ignore malformed test frames */
      }
    });
    ws.on('error', reject);
  });
}

function updates(seen: HostToPageMessage[]): number {
  return seen.filter((m) => m.type === 'memories-update').length;
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-memory-archive-'));
  previousConfigDir = process.env.STUDIO_CONFIG_DIR;
  process.env.STUDIO_CONFIG_DIR = tmpDir;
  vi.resetModules();
  const { createDesktopHost } = await import('../../src/host/desktop-host');
  host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    policyMode: 'full',
  });
  await host.start();
});

afterEach(async () => {
  try {
    await host?.stop();
  } finally {
    if (previousConfigDir === undefined) delete process.env.STUDIO_CONFIG_DIR;
    else process.env.STUDIO_CONFIG_DIR = previousConfigDir;
    const { getMemoryStore } = await import('../../src/host/memory-store');
    getMemoryStore().close();
    await fsp.rm(tmpDir, { recursive: true, force: true });
    host = null;
  }
});

describe('M10-5 归档生命周期', () => {
  it('归档 → 已归档列表 → 恢复 → 彻底删除（每一步都广播）', async () => {
    const seen: HostToPageMessage[] = [];
    const ws = await connectPage(host!, seen);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { getMemoryStore } = await import('../../src/host/memory-store');

    const saved = await host!.invokeTool('memory.save', {
      type: 'user',
      name: 'archive-me',
      content: '生命周期用例',
    });
    expect(saved.ok).toBe(true);
    const id = (saved.data as { id: string }).id;

    // ① 归档（软删）：生效面消失，账本仍在
    const archived = await host!.invokeTool('memory.delete', { id });
    expect(archived.ok).toBe(true);
    const store = getMemoryStore();
    expect((await store.list()).some((m) => m.id === id)).toBe(false);
    expect((await store.listInvalidated()).some((m) => m.id === id)).toBe(true);
    expect(store.stats().total).toBe(1);

    // ② 已归档列表可达（面板两态的取数口）
    const listed = await host!.invokeTool('memory.listArchived', {});
    expect(listed.ok).toBe(true);
    const rows = (listed.data as { memories: Array<{ id: string; archivedAt: number | null }> }).memories;
    expect(rows.map((m) => m.id)).toContain(id);
    expect(rows.find((m) => m.id === id)?.archivedAt).toBeTypeOf('number');

    // ③ 恢复：回到生效面，已归档面消失
    const restored = await host!.invokeTool('memory.unarchive', { id });
    expect(restored.ok).toBe(true);
    expect((await store.list()).some((m) => m.id === id)).toBe(true);
    expect((await store.listInvalidated()).some((m) => m.id === id)).toBe(false);

    // ④ 再归档 + 彻底删除：两态都不再出现
    expect((await host!.invokeTool('memory.delete', { id })).ok).toBe(true);
    const purged = await host!.invokeTool('memory.purge', { id });
    expect(purged.ok).toBe(true);
    expect(store.stats().total).toBe(0);
    const after = await host!.invokeTool('memory.listArchived', {});
    expect((after.data as { memories: unknown[] }).memories).toHaveLength(0);

    // 每次写操作都要广播（删除/恢复/彻底删除各一次，加上 save）
    expect(updates(seen)).toBeGreaterThanOrEqual(4);
    ws.close();
  });

  it('错误码：归档不存在的 id / 恢复未归档的 id / 彻底删除不存在的 id', async () => {
    const seen: HostToPageMessage[] = [];
    const ws = await connectPage(host!, seen);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const missing = await host!.invokeTool('memory.delete', { id: 'mem-nope' });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('memory-not-found');

    const saved = await host!.invokeTool('memory.save', { type: 'user', name: 'live', content: 'c' });
    const id = (saved.data as { id: string }).id;
    const notArchived = await host!.invokeTool('memory.unarchive', { id });
    expect(notArchived.ok).toBe(false);
    expect(notArchived.reason).toBe('memory-not-archived');

    expect((await host!.invokeTool('memory.delete', { id })).ok).toBe(true);
    expect((await host!.invokeTool('memory.purge', { id })).ok).toBe(true);
    const twice = await host!.invokeTool('memory.purge', { id });
    expect(twice.ok).toBe(false);
    expect(twice.reason).toBe('memory-not-found');
    ws.close();
  });

  it('工具面：三个写操作都要同意，已归档列表是只读免同意', async () => {
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const { needsConsent } = await import('../../src/host/tool-registry');
    const pick = (id: string) => DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === id)!;
    expect(needsConsent(pick('memory.delete'))).toBe(true);
    expect(needsConsent(pick('memory.unarchive'))).toBe(true);
    expect(needsConsent(pick('memory.purge'))).toBe(true);
    expect(needsConsent(pick('memory.listArchived'))).toBe(false);
    expect(needsConsent(pick('memory.list'))).toBe(false);
  });

  it('memory.list 是面板取数口：只回生效行，按 pinned → user → updated_at', async () => {
    const seen: HostToPageMessage[] = [];
    const ws = await connectPage(host!, seen);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const namesOf = (r: { data?: unknown }): string[] =>
      (r.data as { memories: Array<{ name: string }> }).memories.map((m) => m.name);

    await host!.invokeTool('memory.save', { type: 'user', name: 'u-old', content: 'u' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const p = await host!.invokeTool('memory.save', { type: 'project', name: 'p-new', content: 'p' });
    await host!.invokeTool('memory.save', { type: 'project', name: 'p-pin', content: 'pin', pinned: true });

    const listed = await host!.invokeTool('memory.list', {});
    expect(listed.ok).toBe(true);
    expect(namesOf(listed)).toEqual(['p-pin', 'u-old', 'p-new']);

    // 归档一行后立刻从生效面消失（面板切换/刷新走同一个口）
    expect((await host!.invokeTool('memory.delete', { id: (p.data as { id: string }).id })).ok).toBe(true);
    const after = await host!.invokeTool('memory.list', {});
    expect(namesOf(after)).toEqual(['p-pin', 'u-old']);
    ws.close();
  });

  it('契约面：归档三兄弟仍是 UI 直调，模型不可达', async () => {
    const { isSupportedUpstreamTool, mapUpstreamToolInvocation } = await import('../../src/shared/tool-contract');
    for (const name of ['memory.delete', 'memory.unarchive', 'memory.purge', 'memory.listArchived']) {
      expect(isSupportedUpstreamTool(name)).toBe(false);
      expect(mapUpstreamToolInvocation(name, { id: 'x' })).not.toBeNull();
    }
  });
});
