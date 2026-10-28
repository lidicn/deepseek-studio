/**
 * QD-R8o 复现件 · 宿主侧入站 tool-call 的两道门（运行副本请放 tests/desktop/）
 *
 * 静态链（9d093dc 面，⛔ 本件改码）：
 * - 页端锁：src/inject/main-world-interceptor.ts:1452-1455（claim(callId) 去重，同回合重复直接 return）
 * - 宿主入站：src/host/page-runtime.ts:413-465 → :439 onToolCall({callId…}) → :440 void exec(...)
 * - 宿主公口：src/host/desktop-host.ts:232/:1440 invokeTool(tool, params, botId?) —— 签名里⛔ 幂等键
 * - 同文件既有闸门标准：:308 result 分支、:404 consent-decision 分支都写
 *   `if (!rec.ready || rec.untrusted) return;`
 *
 * 本件断言的是「应有行为」（⛔ 断言缺陷行为）：
 * REPRO-A 同一 callId 投两次 → 宿主只真跑一次；
 * REPRO-B 未完成 hello 握手的连接投 tool-call → 宿主不执行（与 :308/:404 同标准）。
 * 红了才是复现成立。
 *
 * 尺自身正控：
 * CONTROL-A 两个不同 callId 各投一次 → 真跑两次（证明链路通 + 计数尺不糊）；
 * CONTROL-B 未握手连接投 unknown-tool → 收到 unknown-tool 回执（证明 :413 分支到得了，
 *   REPRO-B 若绿⛔ 是「消息没到」造成的假绿）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import type { HostToPageMessage } from '../../src/host/protocol';

const running: DesktopHost[] = [];

async function startHost(options: { workspaceRoot?: string; policyMode?: 'workspace' | 'ask' | 'auto' | 'full' }): Promise<DesktopHost> {
  const workspace = options.workspaceRoot ? createWorkspace(options.workspaceRoot) : null;
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    workspace,
    policyMode: options.policyMode ?? 'full',
  });
  await host.start();
  running.push(host);
  return host;
}

afterEach(async () => {
  while (running.length) {
    const h = running.pop();
    try {
      await h?.stop();
    } catch {
      /* 已停止 */
    }
  }
});

function open(h: DesktopHost, seen: HostToPageMessage[], handshaked: boolean): Promise<WebSocket> {
  const port = Number(new URL(h.url).port);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      if (handshaked) ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
      resolve(ws);
    });
    ws.on('message', (raw) => {
      try {
        seen.push(JSON.parse(raw.toString()) as HostToPageMessage);
      } catch {
        /* ignore */
      }
    });
    ws.on('error', reject);
  });
}

/** 等 seen 里满足条件的消息攒够 n 条，或超时（返回当时条数，供读数打印）。 */
async function waitForResults(seen: HostToPageMessage[], callId: string | null, n: number): Promise<number> {
  const deadline = Date.now() + 8_000;
  const count = () =>
    seen.filter((m) => {
      if (m.type !== 'tool-call-result') return false;
      const rec = m as unknown as { callId?: string };
      return callId === null || rec.callId === callId;
    }).length;
  while (Date.now() < deadline && count() < n) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return count();
}

function executedWrites(h: DesktopHost): number {
  return h.audit.listByTool('file.write').filter((r) => r.outcome === 'executed').length;
}

function send(ws: WebSocket, callId: string, filePath: string, content: string): void {
  ws.send(JSON.stringify({ type: 'tool-call', callId, invocationName: 'local_file_write', params: { path: filePath, content } }));
}

describe('QD-R8o · 宿主入站 tool-call 的 callId 幂等与握手门', () => {
  it('CONTROL-A：可信页投两个不同 callId → 宿主真跑两次（链路通 + 计数尺不糊）', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-r8o-'));
    try {
      const host = await startHost({ workspaceRoot: tmp });
      const seen: HostToPageMessage[] = [];
      const ws = await open(host, seen, true);
      const file = path.join(tmp, 'ctrl-a.txt');
      send(ws, 'ctrl-a-1', file, 'one');
      send(ws, 'ctrl-a-2', file, 'two');
      const got = await waitForResults(seen, null, 2);
      expect(got).toBe(2);
      expect(executedWrites(host)).toBe(2);
      ws.close();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it('REPRO-A：可信页把同一个 callId 投两次 → 应有行为＝宿主只真跑一次', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-r8o-'));
    try {
      const host = await startHost({ workspaceRoot: tmp });
      const seen: HostToPageMessage[] = [];
      const ws = await open(host, seen, true);
      const file = path.join(tmp, 'dup.txt');
      send(ws, 'dup-callid-1', file, 'same');
      await waitForResults(seen, 'dup-callid-1', 1);
      send(ws, 'dup-callid-1', file, 'same');
      const got = await waitForResults(seen, 'dup-callid-1', 2);
      const executions = executedWrites(host);
      console.log(`[REPRO-A] 同 callId 收到 tool-call-result=${got} 条，宿主 file.write executed 记录=${executions} 条`);
      expect(executions).toBe(1);
      expect(got).toBe(1);
      ws.close();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it('CONTROL-B：未握手连接投 unknown-tool → 收到 unknown-tool 回执（证明 :413 分支到得了）', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-r8o-'));
    try {
      const host = await startHost({ workspaceRoot: tmp });
      const seen: HostToPageMessage[] = [];
      const ws = await open(host, seen, false);
      ws.send(JSON.stringify({ type: 'tool-call', callId: 'reach-1', invocationName: 'not-a-tool', params: {} }));
      const got = await waitForResults(seen, 'reach-1', 1);
      const rec = seen.find((m) => m.type === 'tool-call-result') as unknown as { error?: string };
      console.log(`[CONTROL-B] 未握手连接收到 tool-call-result=${got} 条，error=${rec?.error}`);
      expect(got).toBe(1);
      ws.close();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it('REPRO-B：未完成 hello 的连接投 tool-call → 应有行为＝宿主不执行（与 :308/:404 同标准）', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-r8o-'));
    try {
      const host = await startHost({ workspaceRoot: tmp });
      const seen: HostToPageMessage[] = [];
      const ws = await open(host, seen, false);
      const file = path.join(tmp, 'nohello.txt');
      send(ws, 'nohello-1', file, 'written-without-handshake');
      await waitForResults(seen, 'nohello-1', 1);
      const executions = executedWrites(host);
      const onDisk = await fsp.readFile(file, 'utf8').catch(() => null);
      console.log(`[REPRO-B] 未握手投 tool-call：宿主 file.write executed=${executions} 条，落盘内容=${JSON.stringify(onDisk)}`);
      expect(executions).toBe(0);
      expect(onDisk).toBeNull();
      ws.close();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});
