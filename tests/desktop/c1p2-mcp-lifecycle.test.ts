/**
 * 组 A · MCP 连接生命周期（5 条，P2）
 *
 * 验收口径：`docs/Audit/20261103-组A组C验收口径草案.md`「组 A」部分。
 *   A-1 R2-04  testConnection 超时/异常路径没有 finally kill → 子进程泄漏
 *   A-2 BUG-036 connect 失败只 delete 不 kill → MCP server 进程泄漏
 *   A-3 BUG-027 并发 connect spawn 两份
 *   A-4 BUG-038 两处 5000ms setTimeout 无 clearTimeout → 定时器悬挂
 *   A-5 BUG-039 tools/list 没查 res.ok → 500 被当成成功
 *
 * 纪律：断言一律打**真实入口**（testConnection / connect），不测私有 helper；
 * 每条配**负控**（负控不成立时，用例必红）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';

// ── 进程边界 mock：只拦 spawn（记 pid / 计数），其余照常透传 ──────────────
// 入口仍是真实的 connect / testConnection。
const state = vi.hoisted(() => ({
  spawned: [] as unknown[],
  /** A-4 用：假子进程（不依赖真实 I/O 时序） */
  fakeChild: null as null | (() => unknown),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (state.fakeChild) {
        const fake = state.fakeChild();
        state.spawned.push(fake);
        return fake as unknown as ReturnType<typeof actual.spawn>;
      }
      const child = actual.spawn(...args);
      state.spawned.push(child);
      return child;
    },
  };
});

import {
  MCP_REQUEST_TIMEOUT,
  McpController,
  TEST_STEP_TIMEOUT_MS,
} from '../../src/host/mcp-controller';

// 环境对齐（20261105，CI #151）：
//   1) 原 `new URL(import.meta.url).pathname.replace(/^\//, '')` 是 Windows-only 写法——
//      POSIX 下去掉前导斜杠会让 HERE 变成**相对路径**，fixture 路径随即不存在。改 fileURLToPath（跨平台）。
//   2) A-1/A-2/A-3 打的是**真实 node 子进程**的 kill 与退出语义（SIGTERM+sighalCode 与 exitCode 在
//      POSIX/Windows 上形态不同）。这类用例只在 Windows 语义下有验证价值，故在非 Windows 上**整块跳过**，
//      而不是放宽断言——放宽就失去区分力。CI 的 gate 作业在 windows-latest 上跑，跳过分支在 CI 不生效。
//      A-4（假子进程 + fake timers）、A-5（HTTP fixture）不依赖平台语义，保持跨平台执行。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const describeWin = isWindows ? describe : describe.skip;
const FIXTURE_RESPONDER = path.join(HERE, 'fixtures', 'mcp-fake-responder.mjs');
const FIXTURE_SILENT = path.join(HERE, 'fixtures', 'mcp-fake-silent.mjs');

const tmpDirs: string[] = [];

/** 写一份 MCP 服务器配置，返回配置文件路径。 */
function writeConfig(servers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lifecycle-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'mcp-servers.json');
  fs.writeFileSync(file, JSON.stringify({ servers }), 'utf8');
  return file;
}

/** stdio 服务器配置项（node + 假 server fixture）。 */
function stdioServer(fixture: string) {
  return { command: 'node', args: [fixture], transport: 'stdio', env: {}, headers: {} };
}

/** 子进程是否已退出（exitCode/signalCode 有值即已退出）。 */
function hasExited(child: { exitCode?: number | null; signalCode?: string | null }): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    ? true
    : child.signalCode !== null && child.signalCode !== undefined;
}

/** 等子进程在 ms 内退出；返回是否退出。 */
async function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), ms); }),
  ]);
}

/** 假子进程：stdio 管道 + 自动应答（不依赖真实 I/O 时序，给 fake timers 用）。 */
function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdin: unknown;
    stdout: unknown;
    stderr: unknown;
    killed: boolean;
    exitCode: number | null;
    signalCode: string | null;
    kill: () => boolean;
    pid: number;
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  child.stdout = stdout as unknown as ChildProcess['stdout'];
  child.stderr = stderr as unknown as ChildProcess['stderr'];
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 424242;
  child.stdin = {
    write: (data: string) => {
      let msg: { id?: number; method?: string };
      try { msg = JSON.parse(data); } catch { return true; }
      if (msg.id == null) return true;
      const result = msg.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
        : { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp' } };
      // queueMicrotask 不受 fake timers 影响 → 时序确定。
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'));
      });
      return true;
    },
    on: () => undefined,
    end: () => undefined,
  } as unknown as ChildProcess['stdin'];
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  };
  return child as unknown as ChildProcess;
}

beforeEach(() => {
  state.spawned.length = 0;
  state.fakeChild = null;
});

afterEach(() => {
  state.fakeChild = null;
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describeWin('组 A · A-1 R2-04 · testConnection 失败路径必须收尸', () => {
  it('tools/list 超时返回后，MCP server 子进程 1s 内退出', async () => {
    const ctl = new McpController(writeConfig({}));
    const r = await ctl.testConnection(
      { command: 'node', args: [FIXTURE_SILENT], transport: 'stdio' },
      { stepTimeoutMs: 100 },
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('timeout');
    const child = state.spawned.at(-1) as ChildProcess;
    expect(await exitedWithin(child, 1000)).toBe(true);
  });

  // 负控：不经 testConnection 直接 spawn 的同一个服务器，1s 后仍然活着
  // → 证明上面那条「已退出」断言不是恒真的。
  it('负控：直接 spawn 的同一个假服务器 1s 后仍存活（断言有区分力）', async () => {
    const { spawn } = await import('node:child_process');
    const direct = spawn('node', [FIXTURE_RESPONDER], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      expect(await exitedWithin(direct, 1000)).toBe(false);
      expect(hasExited(direct)).toBe(false);
    } finally {
      direct.kill();
    }
  });
});

describeWin('组 A · A-2 BUG-036 · connect 失败路径必须收尸', () => {
  it('connect 因 tools/list 超时失败后，MCP server 子进程 1s 内退出', async () => {
    const prev = MCP_REQUEST_TIMEOUT.ms;
    MCP_REQUEST_TIMEOUT.ms = 300;
    try {
      const ctl = new McpController(writeConfig({ s: stdioServer(FIXTURE_SILENT) }));
      const conn = await ctl.connect('s');
      expect(conn).toBeNull();
      const child = state.spawned.at(-1) as ChildProcess;
      expect(await exitedWithin(child, 1000)).toBe(true);
    } finally {
      MCP_REQUEST_TIMEOUT.ms = prev;
    }
  });

  // 负控：连接**成功**时子进程是活着的（所以失败路径里"进程没了"只能来自我们的收尸逻辑）
  it('负控：连接成功时子进程仍存活（证明收尸来自清理而非进程自退）', async () => {
    const ctl = new McpController(writeConfig({ ok: stdioServer(FIXTURE_RESPONDER) }));
    const conn = await ctl.connect('ok');
    expect(conn).not.toBeNull();
    const child = state.spawned.at(-1) as ChildProcess;
    expect(hasExited(child)).toBe(false);
    ctl.disconnectAll();
  });
});

describeWin('组 A · A-3 BUG-027 · 并发 connect 去重', () => {
  it('并发 connect 同一 serverId：只 spawn 一次，两次拿到同一连接实例', async () => {
    const ctl = new McpController(writeConfig({ dup: stdioServer(FIXTURE_RESPONDER) }));
    const before = state.spawned.length;
    const [a, b] = await Promise.all([ctl.connect('dup'), ctl.connect('dup')]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(state.spawned.length - before).toBe(1);
    ctl.disconnectAll();
  });

  // 负控：两个不同 serverId → 必须是 2 次 spawn（证明计数看得见"多份"）
  it('负控：不同 serverId 各连一次 → spawn 计数为 2', async () => {
    const ctl = new McpController(writeConfig({
      d1: stdioServer(FIXTURE_RESPONDER),
      d2: stdioServer(FIXTURE_RESPONDER),
    }));
    const before = state.spawned.length;
    await Promise.all([ctl.connect('d1'), ctl.connect('d2')]);
    expect(state.spawned.length - before).toBe(2);
    ctl.disconnectAll();
  });
});

describe('组 A · A-4 BUG-038 · 不留悬挂定时器', () => {
  it('成功路径结束后 getTimerCount() === 0（fake timers，不用 wall-clock）', async () => {
    vi.useFakeTimers();
    try {
      state.fakeChild = makeFakeChild;
      const ctl = new McpController(writeConfig({}));
      const p = ctl.testConnection(
        { command: 'node', args: [FIXTURE_RESPONDER], transport: 'stdio' },
        { stepTimeoutMs: TEST_STEP_TIMEOUT_MS },
      );
      let settled = false;
      const tracked = p.then((r) => { settled = true; return r; });
      for (let i = 0; i < 200 && !settled; i += 1) {
        await vi.advanceTimersByTimeAsync(50);
      }
      const r = await tracked;
      expect(r.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      state.fakeChild = null;
      vi.useRealTimers();
    }
  });

  // 负控：故意留一个定时器 → getTimerCount() 必须 > 0（证明上面那条断言不是恒真）
  it('负控：故意留下的定时器会让 getTimerCount() > 0', () => {
    vi.useFakeTimers();
    try {
      const h = setTimeout(() => { /* 故意不触发 */ }, 10_000);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      clearTimeout(h);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('组 A · A-5 BUG-039 · tools/list 必须查 res.ok', () => {
  async function withFixtureServer(
    toolsStatus: number,
    run: (url: string) => Promise<void>,
  ): Promise<void> {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let msg: { id?: number; method?: string } = {};
        try { msg = JSON.parse(body || '{}'); } catch { /* ignore */ }
        if (msg.method === 'tools/list') {
          res.statusCode = toolsStatus;
          res.end(toolsStatus === 200 ? JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) : 'boom');
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture' } },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      await run(`http://127.0.0.1:${port}/mcp`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('tools/list 返 500 → ok:false 且 error 含 HTTP 500', async () => {
    await withFixtureServer(500, async (url) => {
      const ctl = new McpController(writeConfig({}));
      const r = await ctl.testConnection({ command: '', transport: 'http', url });
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain('HTTP 500');
    });
  });

  // 负控：tools/list 返 200 → ok:true（证明上面那条"ok:false"是真的被 500 触发的）
  it('负控：tools/list 返 200 → ok:true', async () => {
    await withFixtureServer(200, async (url) => {
      const ctl = new McpController(writeConfig({}));
      const r = await ctl.testConnection({ command: '', transport: 'http', url });
      expect(r.ok).toBe(true);
    });
  });
});
