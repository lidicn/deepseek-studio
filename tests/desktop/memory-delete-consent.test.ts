import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import type { HostToPageMessage } from '../../src/host/protocol';
import type { DesktopHost } from '../../src/host/desktop-host';

let host: DesktopHost | null = null;

/**
 * 2026-11-13 记忆写入硬闸前置（断言语义零改动）：memory.save 现在要求「本轮用户话语」
 * 证据并按对话 id 取证，本文件写入接到同一对话上下文并先落一条记忆指令。
 */
const MEM_GATE_CONV = 'mem-gate-conv';
const saveMem = (params: Record<string, unknown>) =>
  host!.invokeTool('memory.save', params, undefined, MEM_GATE_CONV);
let tmpDir = '';
let previousConfigDir: string | undefined;

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function connectPage(target: DesktopHost, seen: HostToPageMessage[]): Promise<WebSocket> {
  const port = Number(new URL(target.url).port);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        origin: 'https://chat.deepseek.com',
        sessionId: 'memory-p0',
      }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      try {
        seen.push(JSON.parse(raw.toString()) as HostToPageMessage);
      } catch {
        /* ignore malformed test frames */
      }
    });
    ws.on('error', reject);
  });
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-memory-p0-'));
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
  host.recordUserTurn(MEM_GATE_CONV, '记住这个偏好');
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

describe('M10-1 memory.delete consent gate', () => {
  it('memory.delete is privileged and requires human consent', async () => {
    const { DEFAULT_TOOL_DEFINITIONS } = await import('../../src/host/tool-definitions');
    const { needsConsent } = await import('../../src/host/tool-registry');
    const def = DEFAULT_TOOL_DEFINITIONS.find((d) => d.id === 'memory.delete');
    expect(def).toBeTruthy();
    expect(def!.risk).toBe('privileged');
    expect(needsConsent(def!)).toBe(true);
  });
});

describe('M10-3 memory.delete broadcast', () => {
  it('broadcasts a fresh list after delete, without the removed id', async () => {
    const seen: HostToPageMessage[] = [];
    const ws = await connectPage(host!, seen);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const saved = await saveMem({
      type: 'user',
      name: 'delete-me',
      content: 'temporary',
    });
    expect(saved.ok).toBe(true);
    const id = (saved.data as { id: string }).id;

    await waitFor(() =>
      seen.some((m) =>
        m.type === 'memories-update' && m.memories.some((memory) => memory.id === id),
      ),
    );
    const beforeDelete = seen.filter((m) => m.type === 'memories-update').length;

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as HostToPageMessage;
        if (message.type === 'consent-required') {
          // R2-01：回执 decision 必须是合法枚举，且 nonce 原样带回
          ws.send(JSON.stringify({
            type: 'consent-decision',
            callId: message.callId,
            decision: 'allow-once',
            nonce: message.nonce,
          }));
        }
      } catch {
        /* ignore malformed test frames */
      }
    });

    const deleted = await host!.invokeTool('memory.delete', { id });
    expect(deleted.ok).toBe(true);
    await waitFor(() => seen.filter((m) => m.type === 'memories-update').length > beforeDelete);

    const latest = seen.filter((m) => m.type === 'memories-update').at(-1);
    expect(latest?.memories.some((memory) => memory.id === id)).toBe(false);
    ws.close();
  });
});
