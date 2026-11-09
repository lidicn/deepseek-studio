// @vitest-environment node
/**
 * tests/desktop/f2a-consent-surface.test.ts —— F-2a：**审批面可断言化**（2026-11-09）。
 *
 * ── 为什么要有它 ──
 * `AGENTS.md`「权限审批」条：**审批界面须独立于当前页面 DOM，agent 不得控制或影响其内容**；
 * **审批窗口不可用时须 fail-closed，不得回退到页内弹窗**。
 * 但"页内模态今天到底承担了多少审批"过去只能**读码推**。本卡把每次审批落在哪个面
 * 记成 `consentSurface`（`audit.ts`）＋`[consent]` 日志里的 `surface=`，让它变成**实测**。
 *
 * ── 本文件锁三格 ──
 * ① **原因可见**：越界审批走宿主侧、窗口起不来 ⇒ 决策 `deny`、`consentSurface='host-unavailable-deny'`、
 *    日志里带 `surface=host-unavailable-deny` 与 `host-window-unavailable` 字样
 *    （原来只有一句 `box unavailable → deny`，读的人分不清是"用户拒"还是"窗口不可用"）。
 * ② **现状锁定**（PM 的 (iii)）：**普通审批今天走页内模态**（`consentSurface='page-modal'`）。
 *    这条不是"认可现状"，是**将来谁把普通审批也改道独立窗口，它必红**——逼改的人承认这是语义变更。
 * ③ **「没问」不许带键**：full 档不进 ask（`policy.ts` 短路）⇒ 审计里**没有** `consentSurface` 这个键。
 *    把"没问"写成某个 surface＝让观测数据说谎，那是本卡唯一的存在理由。
 *
 * ── 判据 5 尾巴：本文件每枚锁**抓不住哪一类变异** ─────────────────
 * （枚枚锁都得自报无能力范围，否则下一班人会把"绿"读成"已覆盖"。）
 *
 * · **① 抓不住**：任何"拒绝原因"本身写错但**仍然写了字**的变异——例如把
 *   `host-window-unavailable` 改成另一个同样存在的字样、或把 `surface=` 的值
 *   换成另一个合法值但同时改了这两处的期望值时。它断的是**当场这三串字在那个
 *   日志行里**，不保证这串字在别处也表达同一件事（那是台账的活）。
 * · **② 抓不住**：普通审批**以外的**支被改道（它只钉 `python.exec` 这一发走
 *   `page-modal`）；也抓不住"页内模态仍然存在、但**同时**新增了独立窗口路径"——
 *   那种变异下 ② 仍绿，必须靠 F-2b 的删改本身 + 本枚的**期望值被同步改**才会红，
 *   **改期望值这一步机器拦不住**。
 * · **③ 抓不住**：`ensureConsent` **内部**的赋值变异（如把某支的 `consentSurface`
 *   初值改掉）。因为 **full 档压根不进 `ensureConsent`**（`policy.ts:L503` 短路）——
 *   ③ 是**位置保证型**断言：它证明的是"没问的路径在结构上到不了这里"，不是
 *   "函数内部每支都记得清空"。那一类变异要靠 ② 与真机取证抓。
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import type { HostToPageMessage } from '../../src/host/protocol';

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

async function startHost(opts: { mode: 'auto' | 'full'; wsRoot: string; nativeConsent?: () => Promise<never> }): Promise<DesktopHost> {
  const cfgDir = mkTemp('f2a-cfg-');
  if (prevConfigDir === undefined) prevConfigDir = process.env.STUDIO_CONFIG_DIR;
  process.env.STUDIO_CONFIG_DIR = cfgDir;
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    workspace: null,
    policyMode: opts.mode,
    consentTimeoutMs: 400,
    ...(opts.nativeConsent ? { nativeConsent: opts.nativeConsent } : {}),
  });
  await host.start();
  running.push(host);
  const set = host.setWorkspaceRoot(opts.wsRoot);
  expect(set.ok, `setWorkspaceRoot 应成功：${set.error ?? ''}`).toBe(true);
  return host;
}

function lastAudit(host: DesktopHost, tool: string) {
  return [...host.audit.list()].reverse().find((r) => r.tool === tool);
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

describe('F-2a ①：越界 + 独立窗口起不来 ⇒ deny 且原因可见', () => {
  it('consentSurface=host-unavailable-deny，日志带 surface 与 host-window-unavailable', async () => {
    const wsRoot = mkTemp('f2a-ws-');
    const outside = mkTemp('f2a-out-');
    const host = await startHost({
      mode: 'auto',
      wsRoot,
      // 负控桩：宿主侧窗口起不来（等价 C″ 轮询拿不到目标端口）
      nativeConsent: async () => {
        throw new Error('host window unavailable (stub)');
      },
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
      origWarn(...args);
    };
    try {
      const r = await host.invokeTool('file.write', { path: path.join(outside, 'x.txt'), content: 'y' }, 'main');
      // ① 决策：窗口不可用 ⇒ fail-closed 拒绝
      expect(r.ok).toBe(false);
      const rec = lastAudit(host, 'file.write');
      expect(rec, '必须有审计记录').toBeDefined();
      expect(rec?.consentSurface, '必须记到"宿主面不可用即拒"这一格').toBe('host-unavailable-deny');
      // ② 原因可见：日志要能读出事���"窗口不可用"而不是"用户拒绝"
      const line = warns.find((w) => w.includes('[consent]') && w.includes('outside-workspace'));
      expect(line, '越界拒绝必须有 [consent] 日志').toBeDefined();
      expect(line).toContain('surface=host-unavailable-deny');
      expect(line, '原因字样必须在日志里，不许只有 box unavailable').toContain('host-window-unavailable');
      // ③ 绝不回退页内：页端不得收到任何 consent-required
      expect(
        page.seen.filter((m) => m.type === 'consent-required'),
        '越界永不走页内',
      ).toHaveLength(0);
    } finally {
      console.warn = origWarn;
      page.ws.close();
    }
  });
});

describe('F-2a ②：现状锁定——普通审批今天走页内模态', () => {
  it('auto 档 python.exec（非越界、always 类）⇒ consentSurface=page-modal', async () => {
    const wsRoot = mkTemp('f2a-ws2-');
    const host = await startHost({ mode: 'auto', wsRoot });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      // 不 await：页端不会回话，靠 consentTimeout 收尾
      void host.invokeTool('python.exec', { code: 'print(1)' }, 'main');
      await wait(1200);
      const rec = lastAudit(host, 'python.exec');
      expect(rec, '必须有审计记录').toBeDefined();
      // ⚠️ 这条锁的是**现状**：断言"普通审批落在页内"。
      // 将来把普通审批也改道独立窗口 ⇒ 本枚必红 ⇒ 改的人必须承认这是**语义变更**，
      // 而不是"顺手优化"。见 `AGENTS.md`「权限审批」条与 PM 的 (iii)。
      expect(rec?.consentSurface, '普通审批今天走页内模态（语义变更必须改这条锁）').toBe('page-modal');
    } finally {
      page.ws.close();
    }
  });
});

describe('F-2a ③：「没问」的路径不许带 consentSurface', () => {
  it('full 档 python.exec（不进 ask）⇒ 审计里没有 consentSurface 这个键', async () => {
    const wsRoot = mkTemp('f2a-ws3-');
    const host = await startHost({ mode: 'full', wsRoot });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      await host.invokeTool('python.exec', { code: 'print(1)' }, 'main');
      await wait(200);
      const rec = lastAudit(host, 'python.exec');
      expect(rec, '必须有审计记录').toBeDefined();
      // 核心：把"没问"写成某个 surface ＝ 让观测数据说谎。
      expect('consentSurface' in (rec as object), 'full 档不进 ask ⇒ 不得带 consentSurface').toBe(false);
    } finally {
      page.ws.close();
    }
  });
});
