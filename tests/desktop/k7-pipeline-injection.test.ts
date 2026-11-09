// @vitest-environment node
/**
 * tests/desktop/k7-pipeline-injection.test.ts —— R50-1：**授权管线注入点的端到端锁**（2026-11-09）。
 *
 * ── 为什么必须单独有这枚文件 ──
 * #50 的 34 枚新测试全绿，#48 的闸却红了：`c1p1-r301b-outside-conversation.test.ts` 的
 * 端到端用例挂在 `expect(first.ok).toBe(true)`。根因是 K7 第一版把「剔除 `cwd`」
 * 做在了**所有工具**上，非 MCP 工具进策略层时顶层 `cwd` 被整体抹掉 ⇒
 * `policy.ts` 的 `L411`（顶层优先，`#49` 的成果）取不到值 ⇒ `outside` 恒 false。
 *
 * **为什么 34 枚没抓住**：`mcp-spawn-target.test.ts` 与 `mcp-cwd-source-parity.test.ts`
 * 都是 `evaluatePolicy({ tool, params, … })` **直连策略层**，而失效发生在
 * **「送到策略层之前字段已被删」**——那一步在 `desktop-host.ts` 里。
 *
 * ⇒ 判据（记 PM 名下，约束所有人）：
 * **改动落在授权管线注入点上的，验收必须至少一枚走 `createDesktopHost`＋`invokeTool` 的
 * 端到端用例；直连 `evaluatePolicy` 的单元锁不得作为该注入点的证据。**
 *
 * ── 装置要点（踩过的坑，别改）──
 * · `workspace: null` 起宿主、再 `setWorkspaceRoot(实测目录)`：宿主默认工作区根可能为 `null`，
 *   而 `policy.ts` 在 `!workspace` 时对文件类直接 `workspace-unconfigured`、对进程类**根本不算越界**，
 *   那样本文件会「绿得没有意义」。
 * · `STUDIO_CONFIG_DIR` 指向临时目录：`setWorkspaceRoot` 会落盘 `config.json`，不许污染真实配置。
 *
 * ── 本文件锁什么 ──
 * ① auto 档 `shell.exec` 带**区外** `cwd` ⇒ 必须问（consent 通道被触发）；
 * ② 同一发在**审计**里 `outside === true`（判据用布尔字段，**不许**拿
 *    `reason === 'outside-workspace'` 代替——风险分支会把它抢成 `risk-detected`）；
 * ③ full 档同形：full 不弹框，但**越界事实仍要如实进审计**；
 * ④ 区内 cwd 不得被误判越界（防做成"每次都弹"）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import type { HostToPageMessage } from '../../src/host/protocol';
import type { NativeConsentRequest } from '../../src/host/desktop-host';
import type { ConsentDecision } from '../../src/host/protocol';

interface FakePage {
  ws: WebSocket;
  seen: HostToPageMessage[];
}

const running: DesktopHost[] = [];
const tempDirs: string[] = [];
let prevConfigDir: string | undefined;

function mkTemp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function connectFakePage(port: number): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    const seen: HostToPageMessage[] = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
    });
    ws.on('message', (raw) => {
      let msg: HostToPageMessage;
      try {
        msg = JSON.parse(raw.toString()) as HostToPageMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello-ack') {
        resolve({ ws, seen });
        return;
      }
      seen.push(msg);
    });
    ws.on('error', reject);
  });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  host: DesktopHost;
  wsRoot: string;
  outside: string;
}

async function startHost(
  mode: 'auto' | 'ask' | 'full',
  onNative?: (req: NativeConsentRequest) => Promise<ConsentDecision | null>,
): Promise<Ctx> {
  const cfgDir = mkTemp('k7-cfg-');
  const wsRoot = mkTemp('k7-ws-');
  const outside = mkTemp('k7-out-'); // 另一个临时目录 ⇒ 必然在 workspaces 之外
  if (prevConfigDir === undefined) prevConfigDir = process.env.STUDIO_CONFIG_DIR;
  process.env.STUDIO_CONFIG_DIR = cfgDir;

  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    workspace: null,
    policyMode: mode,
    consentTimeoutMs: 400,
    ...(onNative ? { nativeConsent: onNative } : {}),
  });
  await host.start();
  running.push(host);
  const set = host.setWorkspaceRoot(wsRoot);
  expect(set.ok, `setWorkspaceRoot 应成功：${set.error ?? ''}`).toBe(true);
  expect(host.workspaceRoot, '工作区根必须真的设上，否则本文件测不到越界').toBeTruthy();
  return { host, wsRoot, outside };
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
  if (prevConfigDir === undefined) delete process.env.STUDIO_CONFIG_DIR;
  else process.env.STUDIO_CONFIG_DIR = prevConfigDir;
  prevConfigDir = undefined;
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判据 */
      }
    }
  }
});

/** 这一发在审计里的记录（按工具名取最后一条）。 */
function lastAudit(host: DesktopHost, tool: string) {
  return [...host.audit.list()].reverse().find((r) => r.tool === tool);
}

/** 区外目录下的一个 cwd（用真实临时目录，避免硬编码路径在当前机器上碰巧"存在但无意义"）。 */
function outsideCwd(outside: string): string {
  return path.join(outside, 'sub');
}

describe('R50-1 ①：auto 档 shell.exec 带区外 cwd ⇒ 必须问，且审计 outside===true', () => {
  it('区外 cwd 触发确认通道、审计留 outside=true、拒绝后不执行', async () => {
    let nativeCalls = 0;
    const { host, outside } = await startHost('auto', async () => {
      nativeCalls += 1;
      return 'deny';
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      const pending = host.invokeTool('shell.exec', { argv: ['node', '--version'], cwd: outsideCwd(outside) }, 'main');
      await wait(600);
      const r = await pending;

      const pageAsked = page.seen.some((m) => m.type === 'consent-required');
      expect(pageAsked || nativeCalls > 0, 'auto 档区外 cwd 必须触发确认通道').toBe(true);

      const rec = lastAudit(host, 'shell.exec');
      expect(rec, '必须有审计记录').toBeDefined();
      expect(rec?.outside, '区外 cwd 必须如实记 outside===true（判据是这个布尔字段，不是 reason）').toBe(true);
      expect(r.ok).toBe(false);
    } finally {
      page.ws.close();
    }
  });
});

describe('R50-1 ②：full 档不弹框，但越界事实仍进审计', () => {
  it('full + shell.exec 区外 cwd ⇒ 不问、但 outside===true 留痕', async () => {
    let nativeCalls = 0;
    const { host, outside } = await startHost('full', async () => {
      nativeCalls += 1;
      return 'deny';
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      await host.invokeTool('shell.exec', { argv: ['node', '--version'], cwd: outsideCwd(outside) }, 'main');
      await wait(200);
      expect(nativeCalls, 'full 档不弹原生框').toBe(0);
      expect(
        page.seen.filter((m) => m.type === 'consent-required'),
        'full 档不向页端发 consent-required',
      ).toHaveLength(0);
      const rec = lastAudit(host, 'shell.exec');
      expect(rec?.outside, 'full 档越界也必须留痕').toBe(true);
    } finally {
      page.ws.close();
    }
  });
});

describe('R50-1 ③：区内 cwd 不得被误判越界（防做成"每次都弹"）', () => {
  it('auto + shell.exec 区内 cwd ⇒ 审计不记 outside', async () => {
    const { host, wsRoot } = await startHost('auto');
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      await host.invokeTool('shell.exec', { argv: ['node', '--version'], cwd: wsRoot }, 'main');
      await wait(200);
      const rec = lastAudit(host, 'shell.exec');
      expect(rec, '必须有审计记录').toBeDefined();
      expect(rec?.outside === true, '区内 cwd 不得被判越界').toBe(false);
    } finally {
      page.ws.close();
    }
  });
});
