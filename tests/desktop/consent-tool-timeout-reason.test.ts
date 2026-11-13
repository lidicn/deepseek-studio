// @vitest-environment node
/**
 * 2026-11-14 真机卡：**审批等待超时被 `tool-call-timeout` 抢先覆盖**（基线 `227bdba`，pid 33892 系）。
 *
 * 现场：`python.exec` 审批挂满 60s，宿主审计记的是 `consent-denied`（真实原因），
 * 模型侧拿到的却是 `tool-call-timeout`——两者都是 60s 常量、两个计时器并列到点，
 * page-runtime 的计时器先回执，真实 reason 被 `settleToolCall()` 的 `return` 丢掉。
 * 于是模型（进而用户）被告知"超时未返回"，暗示"重试有用"，而真相是"审批窗口没人点"。
 *
 * 三条互为判别（判据 4）：
 *   ① 审批等待超时 ⇒ 模型侧拿到**审批类**可行动文本（含 `consent-denied` 码），**不是** `tool-call-timeout`；
 *   ② 用户明确拒绝 ⇒ 同样走审批类文本（含「拒绝」字样、含码）；
 *   ③ 真·工具执行超时（执行器不返回、与审批无关）⇒ 仍报 `tool-call-timeout`，文案带秒数，
 *      并显式写明"这不是审批问题"。
 *
 * 判据 1 的机制锁：工具总超时缺省值 = `max(60s, consentTimeoutMs + TOOL_CALL_TIMEOUT_MARGIN_MS)`。
 * 负控：把缺省值改回 `60_000`（与审批预算并列）⇒ ① 红（拿到的是 tool-call-timeout）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import {
  TOOL_CALL_TIMEOUT_MARGIN_MS,
  createPageRuntimeHub,
  describeToolFailure,
} from '../../src/host/page-runtime';
import type { HostToPageMessage } from '../../src/host/protocol';
import type { ToolExecutionResult } from '../../src/host/desktop-host';

const running: DesktopHost[] = [];

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

interface FakePage {
  ws: WebSocket;
  seen: HostToPageMessage[];
}

function connectPage(port: number): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    const seen: HostToPageMessage[] = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' })));
    ws.on('message', (raw) => {
      try {
        seen.push(JSON.parse(raw.toString()) as HostToPageMessage);
      } catch {
        /* ignore */
      }
    });
    ws.on('error', reject);
    setTimeout(() => resolve({ ws, seen }), 80);
  });
}

/** 页端发起一次工具调用，并等它的 `tool-call-result`。 */
function callToolFromPage(page: FakePage, callId: string, invocationName: string, params: unknown) {
  return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tool-call-result within 8s')), 8_000);
    const tick = setInterval(() => {
      const hit = page.seen.find((m) => m.type === 'tool-call-result' && (m as { callId?: string }).callId === callId) as
        | { type: 'tool-call-result'; ok: boolean; error?: string }
        | undefined;
      if (!hit) return;
      clearInterval(tick);
      clearTimeout(timer);
      resolve({ ok: hit.ok, ...(hit.error !== undefined ? { error: hit.error } : {}) });
    }, 10);
    page.ws.send(JSON.stringify({ type: 'tool-call', callId, invocationName, params }));
  });
}

async function startHost(consentTimeoutMs: number): Promise<{ host: DesktopHost; page: FakePage }> {
  const ws = mkdtempSync(path.join(os.tmpdir(), 'studio-ctr-'));
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    policyMode: 'ask',
    workspace: createWorkspace(ws),
    consentTimeoutMs,
  });
  await host.start();
  running.push(host);
  const page = await connectPage(Number(new URL(host.url).port));
  return { host, page };
}

describe('审批超时 / 拒绝 / 真超时：模型侧 reason 三分（判据 4）', () => {
  it('① 审批等待无人应答 ⇒ 审批类可行动文本（含 consent-denied），不是 tool-call-timeout', async () => {
    // 审批预算 300ms；工具总超时缺省 30_300ms ⇒ 审批先落地
    const { page } = await startHost(300);
    try {
      const startedAt = Date.now();
      const r = await callToolFromPage(page, 'ctr-timeout-1', 'python_exec', { code: 'print(1)' });
      const elapsed = Date.now() - startedAt;

      expect(r.ok).toBe(false);
      expect(r.error).toContain('审批');
      expect(r.error).toContain('consent-denied');
      expect(r.error).not.toContain('tool-call-timeout');
      expect(r.error).toContain('不要重复调用同一工具');
      // 审批预算量级，而不是工具总超时量级
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      page.ws.close();
    }
  });

  it('② 用户明确拒绝 ⇒ 审批类文本（含「拒绝」与 consent-denied），不是 tool-call-timeout', async () => {
    const { page } = await startHost(5_000);
    try {
      // 收到审批请求即回 deny
      page.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as HostToPageMessage;
        if (m.type === 'consent-required') {
          page.ws.send(
            JSON.stringify({
              type: 'consent-decision',
              callId: m.callId,
              decision: 'deny',
              nonce: (m as { nonce?: string }).nonce,
            }),
          );
        }
      });
      const r = await callToolFromPage(page, 'ctr-deny-1', 'python_exec', { code: 'print(1)' });

      expect(r.ok).toBe(false);
      expect(r.error).toContain('审批');
      expect(r.error).toContain('拒绝');
      expect(r.error).toContain('consent-denied');
      expect(r.error).not.toContain('tool-call-timeout');
    } finally {
      page.ws.close();
    }
  });

  it('③ 真·工具执行超时（执行器不返回）⇒ 仍报 tool-call-timeout，文案带秒数且声明"不是审批问题"', async () => {
    const server = createServer();
    const hub = createPageRuntimeHub({
      server,
      path: '/studio',
      token: 't',
      // 只压工具总超时（模拟"执行器卡死"）；审批预算保持默认，证明这条分支与审批无关
      toolCallTimeoutMs: 400,
      consentTimeoutMs: 60_000,
      executor: () => new Promise<ToolExecutionResult>(() => {}),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const page = await connectPage(port);
    try {
      page.ws.send(JSON.stringify({ type: 'tool-call', callId: 'ctr-real-1', invocationName: 'shell_exec', params: { command: 'echo hi' } }));
      const hit = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no result')), 8_000);
        const tick = setInterval(() => {
          const m = page.seen.find(
            (x) => x.type === 'tool-call-result' && (x as { callId?: string }).callId === 'ctr-real-1',
          ) as { ok: boolean; error?: string } | undefined;
          if (!m) return;
          clearInterval(tick);
          clearTimeout(timer);
          resolve(m);
        }, 10);
      });

      expect(hit.ok).toBe(false);
      expect(hit.error).toContain('tool-call-timeout');
      expect(hit.error).toContain('秒');
      expect(hit.error).toContain('这不是审批问题');
    } finally {
      page.ws.close();
      hub.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('判据 1 的机制锁：工具总超时严格大于审批预算', () => {
  it('余量常量存在且为正；describeToolFailure 对审批类与真超时给出三种互不相同文本', () => {
    expect(TOOL_CALL_TIMEOUT_MARGIN_MS).toBeGreaterThan(0);

    const denied = describeToolFailure('consent-denied', 'python.exec', 90_000);
    const unavailable = describeToolFailure('consent-unavailable', 'python.exec', 90_000);
    const timeout = describeToolFailure('tool-call-timeout', 'python.exec', 90_000);

    expect(denied).toContain('consent-denied');
    expect(unavailable).toContain('consent-unavailable');
    expect(timeout).toContain('tool-call-timeout');
    // 三种互不相同（防止"一个模板套所有码"的假修）
    expect(new Set([denied, unavailable, timeout]).size).toBe(3);
    // 其余 reason 原样透传（不吞错误码）
    expect(describeToolFailure('workspace-unconfigured', 'file.read', 90_000)).toBe('workspace-unconfigured');
    expect(describeToolFailure(undefined, 'file.read', 90_000)).toBeUndefined();
  });
});
