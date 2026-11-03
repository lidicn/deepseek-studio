/**
 * BUG-037：MCP SSE 传输用 `await res.text()` → 必超时
 *
 * 缺陷形态：`sendHttpRequest` 在 `content-type: text/event-stream` 分支里 `await res.text()`。
 * SSE 是**长连接**：服务端发完一条 `data:` 后继续挂着（不 close），`res.text()` 只有到 EOF
 * 才 resolve → 永远拿不到响应，最后被 `AbortSignal.timeout(30000)` 打断 → 每个 SSE 工具调用
 * 都要干等 30 秒再失败。
 *
 * 判据（本文件）：
 *   1. 真实入口 `connect()`：服务端发一条响应后**不关闭流**，客户端必须立刻完成初始化；
 *   2. `[DONE]` 哨兵到达即收尾（不等 EOF）；
 *   3. **负控**：流既不关也不发响应 → 必须在超时内失败，不能永久挂住；
 *   4. 拿到响应后主动 cancel reader（不留悬挂连接）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McpController, readSseJsonRpcResponse } from '../../src/host/mcp-controller';

/** 一条 SSE 事件（`data:` 行），照 SSE 规范以空行分隔。 */
function sseEvent(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 构造「发若干条事件后**永不关闭**」的 SSE 响应 —— 长连接的真实形态。
 *
 * 关键：不调用 `controller.close()`。旧实现 `res.text()` 在这种流上永远不 resolve。
 */
function openSseResponse(events: unknown[], onCancel?: () => void): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(sseEvent(e)));
      // 故意不 close。
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const tmpDirs: string[] = [];

function writeConfig(servers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-sse-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ servers }), 'utf8');
  return file;
}

/** 让 connect() 的三种结局都能被断言：成功 / 失败 / 超时（红）。 */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | 'timeout' | 'failed'> {
  return Promise.race([
    p.then((v) => v).catch(() => 'failed' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms)),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

describe('BUG-037 · MCP SSE 长连接', () => {
  it('真实入口：服务端发一条响应后不关闭流，connect() 也必须完成初始化', async () => {
    const cfgPath = writeConfig({
      sse: { command: '', args: [], env: {}, transport: 'http', url: 'http://fake/mcp' },
    });

    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: unknown }) => {
      const msg = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      const result = msg.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
        : { protocolVersion: '2024-11-05', serverInfo: { name: 'fake-sse' } };
      // 每个 POST 都返回「发一条就挂着」的 SSE 流。
      return openSseResponse([{ jsonrpc: '2.0', id: msg.id, result }]);
    });

    const ctl = new McpController(cfgPath);
    const outcome = await settleWithin(ctl.connect('sse'), 2000);
    ctl.disconnectAll();

    // 旧实现：res.text() 永不 resolve → outcome === 'timeout'（红）。
    expect(outcome).not.toBe('timeout');
    expect(outcome).not.toBe('failed');
    expect(outcome).not.toBeNull();
    expect((outcome as { initialized: boolean }).initialized).toBe(true);
  }, 15000);
});

describe('BUG-037 · readSseJsonRpcResponse 收尾语义', () => {
  it('解出响应立即返回，并 cancel reader（不吊着连接）', async () => {
    let cancelled = false;
    const res = openSseResponse([{ jsonrpc: '2.0', id: 7, result: { tools: [] } }], () => { cancelled = true; });
    const out = await readSseJsonRpcResponse(res, { timeoutMs: 2000 });
    expect(out).toEqual({ tools: [] });
    // 不 cancel 的话服务端与本地都算连接泄漏。
    expect(cancelled).toBe(true);
  });

  it('[DONE] 到达即收尾：此前没有响应 → 明确报错，不等 EOF', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('event: ping\ndata: {"jsonrpc":"2.0","method":"ping"}\n\ndata: [DONE]\n\n')); },
    });
    const res = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await expect(readSseJsonRpcResponse(res, { timeoutMs: 2000 })).rejects.toThrow(/without a JSON-RPC response/);
  });

  // 负控：流既不结束也不发任何响应 → 必须**超时失败**，不能永久挂住。
  // 这条是给「把 timeout 去掉就永远不会返回」的准备：故意给 300ms，断言在 1.5s 内拒绝。
  it('负控：流既不关也不发响应 → 超时失败（不永久挂住）', async () => {
    const body = new ReadableStream<Uint8Array>({ start() { /* 一个字节都不发 */ } });
    const res = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const t0 = Date.now();
    await expect(readSseJsonRpcResponse(res, { timeoutMs: 300 })).rejects.toThrow(/timed out after 300ms/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('没有 body 的响应 → 明确报错（不静默返回 undefined）', async () => {
    const res = new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await expect(readSseJsonRpcResponse(res, { timeoutMs: 500 })).rejects.toThrow(/has no body/);
  });
});
