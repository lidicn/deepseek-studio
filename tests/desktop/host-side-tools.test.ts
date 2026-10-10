/**
 * 宿主侧能力接入集成测试（v0.5）
 *
 * 覆盖的是最关键的架构不变量：**shell / file 绝不能被派发到页面**。
 * 这一条若失守，页面脚本就获得了驱动宿主本机的能力，v0.5 的所有安全设计同时作废。
 * 因此这里用「有页端连接」这一最容易出错的前置条件来验证路由。
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
    // 显式传入（而非让宿主自动解析），保证测试不依赖开发者本机配置
    workspace,
    policyMode: options.policyMode ?? 'ask',
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

/** 连接一个「假页」，并把收到的所有消息记录下来。 */
function connectPage(host: DesktopHost, seen: HostToPageMessage[]): Promise<WebSocket> {
  const port = Number(new URL(host.url).port);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
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

describe('宿主侧能力执行侧解析', () => {
  it('shell / file 解析为 host 侧，既有 chat-* 仍为 page 侧', async () => {
    const host = await startHost({});
    expect(host.resolveSide('shell.exec')).toBe('host');
    expect(host.resolveSide('file.read')).toBe('host');
    expect(host.resolveSide('file.write')).toBe('host');
    expect(host.resolveSide('file.list')).toBe('host');
    expect(host.resolveSide('chat-send')).toBe('page');
    expect(host.resolveSide('echo')).toBe('page');
    // 未登记工具回落页端（默认向后兼容），但随后会被 unknown-capability 拒绝
    expect(host.resolveSide('not-a-tool')).toBe('page');
  });
});

describe('宿主侧能力绝不经过页面（核心不变量）', () => {
  it('有页端连接时，shell.exec 仍只在宿主内执行，页面收不到 dispatch', async () => {
    const host = await startHost({ policyMode: 'full' });
    const seen: HostToPageMessage[] = [];
    const ws = await connectPage(host, seen);

    const r = await host.invokeTool('shell.exec', {
      argv: [process.execPath, '-e', 'console.log("host-side-only")'],
    });

    expect(r.ok).toBe(true);
    // 结果里真的带回 stdout，才能证明子进程在宿主跑了且数据没被宿主丢掉
    expect((r.data as { stdout: string }).stdout).toContain('host-side-only');
    const dispatchedTools = seen.filter((m) => m.type === 'dispatch').map((m) => (m as { tool: string }).tool);
    expect(dispatchedTools).not.toContain('shell.exec');
    ws.close();
  });

  it('页端若声称能执行 shell.exec，宿主也不会把命令交给它', async () => {
    const host = await startHost({ policyMode: 'full' });
    const seen: HostToPageMessage[] = [];
    const ws = await connectPage(host, seen);
    // 假页对任何 dispatch 都立刻返回 ok=true，试图「截胡」宿主侧能力
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as HostToPageMessage;
        if (m.type === 'dispatch') ws.send(JSON.stringify({ type: 'result', callId: m.callId, ok: true }));
      } catch {
        /* ignore */
      }
    });

    await host.invokeTool('shell.exec', { argv: [process.execPath, '-e', 'process.exit(7)'] });
    // 若被页端截胡，结果会是 ok=true；宿主真跑则退出码 7 → ok=false
    const audit = host.audit.list().filter((r) => r.tool === 'shell.exec').at(-1);
    expect(audit?.outcome).toBe('execution-failed');
    ws.close();
  });
});

describe('三档策略在宿主链路上的行为', () => {
  it('ask 档 + 无页端：命令需审批但无人可问 → consent-unavailable', async () => {
    const host = await startHost({ policyMode: 'ask' });
    const r = await host.invokeTool('shell.exec', { command: 'npm run build' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('consent-unavailable');
    const rec = host.audit.list().at(-1);
    expect(rec?.mode).toBe('ask');
    expect(rec?.outcome).toBe('consent-unavailable');
  });

  it('full 档 + 无页端：直接执行，不阻塞在同意闸门上', async () => {
    const host = await startHost({ policyMode: 'full' });
    const r = await host.invokeTool('shell.exec', { argv: [process.execPath, '-e', 'console.log("ok")'] });
    expect(r.ok).toBe(true);
    const rec = host.audit.list().at(-1);
    expect(rec?.mode).toBe('full');
    expect(rec?.outcome).toBe('executed');
  });

  it('auto 档：常规命令无需审批即执行', async () => {
    const host = await startHost({ policyMode: 'auto' });
    const r = await host.invokeTool('shell.exec', { command: 'node --version' });
    expect(r.ok).toBe(true);
    expect(host.audit.list().at(-1)?.mode).toBe('auto');
  });

  it('auto 档：命中风险命令仍要审批（无页 → 拒绝）', async () => {
    const host = await startHost({ policyMode: 'auto' });
    const r = await host.invokeTool('shell.exec', { command: 'rm -rf C:/tmp/x' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('consent-unavailable');
  });
});

describe('文件能力受工作区约束', () => {
  it('未配置工作区 → file.* 被策略硬拒绝（不弹窗，直接 deny）', async () => {
    const host = await startHost({ policyMode: 'full' });
    const r = await host.invokeTool('file.read', { path: os.homedir() });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('workspace-unconfigured');
    expect(host.audit.list().at(-1)?.outcome).toBe('policy-denied');
  });

  it('工作区内读写放行，区外按档位处理', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-host-ws-'));
    try {
      const host = await startHost({ workspaceRoot: tmp, policyMode: 'full' });
      const file = path.join(tmp, 'a.txt');
      const w = await host.invokeTool('file.write', { path: file, content: 'hello' });
      expect(w.ok).toBe(true);
      const r = await host.invokeTool('file.read', { path: file });
      expect(r.ok).toBe(true);
      expect((r.data as { text: string }).text).toBe('hello');

      const outside = await host.invokeTool('file.list', { path: path.dirname(tmp) });
      expect(outside.ok).toBe(true); // full 档越界放行
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it('ask 档越界访问需审批，且页端收到越界徽标', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-host-ws-'));
    try {
      const host = await startHost({ workspaceRoot: tmp, policyMode: 'ask' });
      const seen: HostToPageMessage[] = [];
      const ws = await connectPage(host, seen);
      // 假页一律拒绝
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(raw.toString()) as HostToPageMessage;
          if (m.type === 'consent-required') {
            ws.send(JSON.stringify({ type: 'consent-decision', callId: m.callId, decision: 'deny' }));
          }
        } catch {
          /* ignore */
        }
      });

      const r = await host.invokeTool('file.read', { path: path.dirname(tmp) });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('consent-denied');

      const consentMsg = seen.find((m) => m.type === 'consent-required') as
        | (HostToPageMessage & { meta?: { outside?: boolean; riskLabel?: string } })
        | undefined;
      expect(consentMsg?.meta?.outside).toBe(true);
      expect(consentMsg?.meta?.riskLabel).toBe('特权级');
      ws.close();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});
