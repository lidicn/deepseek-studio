/**
 * v0.6 工具调用事件桥集成测试
 *
 * 覆盖「模型发起 tool-call → 页端拦截投递 → 宿主真实执行 → 结果回注」闭环的关键环节：
 *   1. 契约映射（上游 invocationName ↔ Studio 工具 id + 参数适配）。
 *   2. 宿主 hub 收到 tool-call 后映射到 Studio 工具并调用 executor（授权链在 executor 内）。
 *   3. 页端 host-client 发送 tool-call 并经 tool-call-result 取回结果（按 callId 关联）。
 *   4. 薄 MAIN-world 拦截器的结果回填：onToolCall 收集结果，下一次 onRequestBody 注入 prompt。
 *
 * 不依赖真实浏览器；ws 通道用 node `ws` 起本地服务，拦截器逻辑用 readHookState 直接驱动。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createPageRuntimeHub } from '../../src/host/page-runtime';
import { createHostClient } from '../../src/desktop/host-client';
import { reinjectIntoPrompt } from '../../src/inject/main-world-interceptor';
import { StreamingToolCallParser } from '../../src/inject/streaming-tool-parser';
import { mapUpstreamToolInvocation, isSupportedUpstreamTool, SUPPORTED_INVOCATION_NAMES } from '../../src/shared/tool-contract';
import type { ToolExecutionResult } from '../../src/host/desktop-host';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));
}

function waitForWsOpen(sock: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.on('open', () => resolve());
    sock.on('error', reject);
  });
}

function nextMessage(sock: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    sock.once('message', (raw) => {
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    sock.once('error', reject);
  });
}

describe('tool-contract mapping', () => {
  it('maps known upstream invocations to Studio tools with param adaptation', () => {
    expect(isSupportedUpstreamTool('shell_exec')).toBe(true);
    expect(isSupportedUpstreamTool('unknown_tool')).toBe(false);

    const shell = mapUpstreamToolInvocation('shell_exec', { command: 'ls -la', timeout_ms: 5000, cwd: '/tmp' });
    expect(shell).toEqual({ id: 'shell.exec', params: { command: 'ls -la', timeoutMs: 5000, cwd: '/tmp' } });

    const read = mapUpstreamToolInvocation('local_file_read', { path: '/a/b.txt' });
    expect(read).toEqual({ id: 'file.read', params: { path: '/a/b.txt' } });

    const write = mapUpstreamToolInvocation('local_file_write', { path: '/a/b.txt', content: 'hi' });
    expect(write).toEqual({ id: 'file.write', params: { path: '/a/b.txt', content: 'hi' } });

    const stat = mapUpstreamToolInvocation('local_file_stat', { path: '/a' });
    expect(stat).toEqual({ id: 'file.stat', params: { path: '/a' } });
  });

  it('returns null for unsupported invocations (fail-closed)', () => {
    expect(mapUpstreamToolInvocation('artifact_create', {})).toBeNull();
  });

  // v1.8：原型链穿透回归。UPSTREAM_TO_STUDIO 用 Object.create(null) 建表后，
  // 'constructor' / '__proto__' / 'toString' 等原型属性名不应命中 truthy 成员。
  // 修复前是普通字面量，这些名会取到 Object.prototype 的成员，绕过 null 兜底，
  // 随后 mapping.adapt 为 undefined 抛 TypeError。
  it('rejects Object.prototype property names (prototype-chain piercing fix)', () => {
    expect(mapUpstreamToolInvocation('constructor', {})).toBeNull();
    expect(mapUpstreamToolInvocation('__proto__', {})).toBeNull();
    expect(mapUpstreamToolInvocation('toString', {})).toBeNull();
    expect(mapUpstreamToolInvocation('valueOf', {})).toBeNull();
    expect(mapUpstreamToolInvocation('hasOwnProperty', {})).toBeNull();
    expect(isSupportedUpstreamTool('constructor')).toBe(false);
    expect(isSupportedUpstreamTool('__proto__')).toBe(false);
  });

  it('exposes a non-empty supported invocation list', () => {
    expect(SUPPORTED_INVOCATION_NAMES.length).toBeGreaterThan(0);
    expect(SUPPORTED_INVOCATION_NAMES).toContain('shell_exec');
  });
});

describe('page-runtime tool-call → executor', () => {
  let server: http.Server;
  afterEach(() => {
    server?.close();
  });

  it('maps invocationName and invokes the resident executor, returning tool-call-result', async () => {
    server = http.createServer();
    const executor = vi.fn(async (tool: string, params: unknown): Promise<ToolExecutionResult> => ({
      ok: true,
      data: { tool, params },
    }));
    const hub = createPageRuntimeHub({ server, path: '/studio', token: 't', executor });
    const port = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    await waitForWsOpen(client);
    client.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
    await nextMessage(client); // hello-ack

    client.send(JSON.stringify({ type: 'tool-call', callId: 'c1', invocationName: 'shell_exec', params: { command: 'ls' } }));
    const result = await nextMessage(client);

    expect(result.type).toBe('tool-call-result');
    expect(result.callId).toBe('c1');
    expect(result.ok).toBe(true);
    // v0.24：executor 第三参为 botId（此假页未自报 → undefined，等价 'main'）
    expect(executor).toHaveBeenCalledWith('shell.exec', { command: 'ls' }, undefined);
    client.close();
    hub.dispose();
  });

  it('rejects unsupported invocation with unknown-tool (fail-closed)', async () => {
    server = http.createServer();
    const executor = vi.fn(async (): Promise<ToolExecutionResult> => ({ ok: true }));
    const hub = createPageRuntimeHub({ server, path: '/studio', token: 't', executor });
    const port = await listen(server);

    const client = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    await waitForWsOpen(client);
    client.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p2' }));
    await nextMessage(client);

    client.send(JSON.stringify({ type: 'tool-call', callId: 'c2', invocationName: 'artifact_create', params: {} }));
    const result = await nextMessage(client);

    expect(result.type).toBe('tool-call-result');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown-tool');
    expect(executor).not.toHaveBeenCalled();
    client.close();
    hub.dispose();
  });
});

describe('host-client sendToolCall round-trip', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  afterEach(() => {
    wss?.close();
    server?.close();
  });

  it('sends tool-call and resolves with the correlated tool-call-result', async () => {
    server = http.createServer();
    wss = new WebSocketServer({ server, path: '/studio' });
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (m.type === 'tool-call') {
          sock.send(
            JSON.stringify({ type: 'tool-call-result', callId: m.callId, ok: true, data: { ran: m.invocationName } }),
          );
        }
      });
    });
    const port = await listen(server);
    // 让 host-client 默认工厂使用 node `ws` 作为 WebSocket 实现
    const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

    const host = createHostClient({
      url: `ws://127.0.0.1:${port}/studio?token=t`,
      capabilities: [],
    });
    host.connect();
    // 等待 ws 连接建立：事件驱动 + 有界 2s 超时（原固定 50ms 睡眠在全量并行负载下竞态失败）
    await new Promise<void>((resolve, reject) => {
      const off = host.onConnected(() => {
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error('ws 连接超时：host-client 未能在 2s 内建立 WebSocket 连接'));
      }, 2000);
    });

    const res = await host.sendToolCall({ callId: 'c9', invocationName: 'shell_exec', params: { command: 'ls' } });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ran: 'shell_exec' });
    host.disconnect();
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  });

  it('fails closed when no host is connected', async () => {
    const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    const host = createHostClient({
      url: 'ws://127.0.0.1:1/studio',
      capabilities: [],
    });
    // 不连接
    const res = await host.sendToolCall({ callId: 'c0', invocationName: 'shell_exec', params: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no-host');
    (globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
  });
});

describe('streaming-tool-parser', () => {
  it('extracts tool calls and strips XML tags from visible text', () => {
    const parser = new StreamingToolCallParser(['shell_exec', 'local_file_read']);
    const sse =
      `data: {"response":"思考中"}\n\n` +
      `data: {"response":"<shell_exec>{"command":"ls -la"}</shell_exec> 已执行"}\n\n` +
      `data: {"response":"结束"}\n\n`;
    const { calls, clean } = parser.feed(sse);
    expect(calls).toHaveLength(1);
    expect(calls[0].invocationName).toBe('shell_exec');
    expect(calls[0].params).toEqual({ command: 'ls -la' });
    // 可见文本中不应再出现工具标签
    expect(clean).not.toContain('<shell_exec>');
    expect(clean).toContain('已执行');
    expect(clean).toContain('data:');
  });

  it('handles tool calls split across chunks', () => {
    const parser = new StreamingToolCallParser(['local_file_read']);
    const part1 = 'prefix <local_file_read>{"path":"/a/';
    const part2 = 'b.txt"}</local_file_read> suffix';
    const r1 = parser.feed(part1);
    expect(r1.calls).toHaveLength(0); // 尚未闭合
    const r2 = parser.feed(part2);
    expect(r2.calls).toHaveLength(1);
    expect(r2.calls[0].params).toEqual({ path: '/a/b.txt' });
  });

  it('flushes incomplete tail as clean text', () => {
    const parser = new StreamingToolCallParser(['shell_exec']);
    const { clean } = parser.feed('hello <shell_exec>');
    expect(clean).toContain('hello');
    const fin = parser.flush();
    expect(fin.clean).toContain('<shell_exec>');
  });
});

describe('main-world interceptor reinjection', () => {
  it('reinjects tool results into the prompt', () => {
    const prompt = reinjectIntoPrompt('hi', [
      { invocationName: 'shell_exec', ok: true, result: { stdout: 'file.txt' } },
    ]);
    expect(prompt).toContain('[tool-result:shell_exec]');
    expect(prompt).toContain('file.txt');
  });

  it('returns prompt unchanged when no results', () => {
    expect(reinjectIntoPrompt('hi', [])).toBe('hi');
  });
});
