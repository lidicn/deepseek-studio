/**
 * 卡 J（2026-11-09）：高风险询问的**路由**——页内模态为主路径，宿主侧为越界与降级两条通路。
 *
 * 三态双向锁（PM 合同）：
 *   ① 正常：页内可用 + 非越界高风险 ⇒ 页内模态；审计里**没有** `degraded`；原生框 0 次。
 *   ② 降级：页内不可用 + 非越界高风险 ⇒ 走宿主框；审计**有** `degraded`；`outcome` 按最终值。
 *   ③ 双失败：页内不可用 + 宿主框也弹不出来 ⇒ `deny`；审计**有** `degraded` 且 `outcome='denied'`；
 *      **`hub.requestConsent` 调用次数＝0**（"绝不回到页面"的机器可验形态）。
 *   ④ 不变量：越界（outside）任何情况都不交给页面——页面收到 0 条 consent-required。
 *
 * 为什么要这一层：`isHighRiskConsent` 只决定"要不要问"，"问在哪儿"是这里的事。
 * 旧实现（R2-01）是"高风险 ⇒ 原生框"；卡 J 起改为页内为主，但**越界那格永远不给页面**。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopHost, type DesktopHost, type NativeConsentRequest } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import type { ConsentDecision, HostToPageMessage } from '../../src/host/protocol';

const running: DesktopHost[] = [];

interface FakePage {
  ws: WebSocket;
  seen: HostToPageMessage[];
}

function connectPage(port: number, helloExtra: Record<string, unknown> = {}): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    const seen: HostToPageMessage[] = [];
    ws.on('open', () =>
      ws.send(
        JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1', ...helloExtra }),
      ),
    );
    ws.on('message', (raw) => {
      let m: HostToPageMessage;
      try {
        m = JSON.parse(raw.toString()) as HostToPageMessage;
      } catch {
        return;
      }
      if (m.type === 'hello-ack') {
        resolve({ ws, seen });
        return;
      }
      seen.push(m);
    });
    ws.on('error', reject);
  });
}

const consentReqs = (p: FakePage): HostToPageMessage[] => p.seen.filter((m) => m.type === 'consent-required');

/** 等某条 ws 真正关闭（close 事件回调后宿主才会 clients.delete，避免与 close 赛跑）。 */
function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once('close', () => resolve());
    ws.close();
  });
}

async function startHost(opts: {
  policyMode?: 'workspace' | 'ask' | 'auto' | 'full';
  nativeConsent?: (req: NativeConsentRequest) => Promise<ConsentDecision | null>;
  consentTimeoutMs?: number;
}): Promise<DesktopHost> {
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    policyMode: opts.policyMode ?? 'auto',
    consentTimeoutMs: opts.consentTimeoutMs ?? 600,
    ...(opts.nativeConsent ? { nativeConsent: opts.nativeConsent } : {}),
  });
  await host.start();
  running.push(host);
  return host;
}

const auditReasons = (host: DesktopHost): string[] => host.audit.list().map((a) => String(a.reason ?? ''));

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

describe('卡 J · 高风险询问路由（三态双向锁）', () => {
  it('① 正常：页内可用 ⇒ 页内模态；原生框 0 次；审计无 degraded', async () => {
    let nativeCalls = 0;
    const host = await startHost({
      policyMode: 'auto',
      nativeConsent: async () => {
        nativeCalls += 1;
        return 'deny';
      },
    });
    const page = await connectPage(Number(new URL(host.url).port));
    try {
      // chat-send + conversationId ⇒ allowConversation=true ⇒ 高风险，且不越界
      const pending = host.invokeTool('chat-send', { text: 'hi' }, 'main', 'conv-j1');
      await new Promise((r) => setTimeout(r, 200));
      const c = consentReqs(page)[0];
      expect(c, '页内可用时高风险应走页内模态').toBeTruthy();
      expect(nativeCalls, '正常路径不得弹宿主框').toBe(0);
      // 回执拒绝，收敛
      page.ws.send(
        JSON.stringify({ type: 'consent-decision', callId: (c as { callId: string }).callId, decision: 'deny', nonce: (c as { nonce: string }).nonce }),
      );
      await pending;
      // 双向锁的另一头：正常路径审计里**不得**出现 degraded
      expect(auditReasons(host)).not.toContain('degraded');
    } finally {
      page.ws.close();
    }
  });

  it('② 降级：只剩 untrusted 页 ⇒ 宿主框；页面 0 次、审计有 degraded', async () => {
    // 三步配方（Chief 版，PM 采纳）：
    //   ① 连 A（带指纹 X）⇒ trusted
    //   ② 连 B（同 X）⇒ `page-runtime:401` 把 B 置 untrusted，**且不 close**（只推 account-duplicate-block）
    //   ③ **关掉 A 并等 `clients.delete`（L660）执行完**；请求**不带 botId**
    // ⇒ `connectedPages` 只剩 B（untrusted）：L2157 门（length===0）不成立 ⇒ 放行；
    //   L2219 `pageAvailable`（`p.untrusted === false` + `!botId` 恒真）⇒ false ⇒ **进降级分支**。
    let nativeCalls = 0;
    const host = await startHost({
      policyMode: 'auto',
      nativeConsent: async () => {
        nativeCalls += 1;
        return 'allow-once';
      },
    });
    const port = Number(new URL(host.url).port);
    const a = await connectPage(port, { accountFingerprint: 'fp-j2' });
    const b = await connectPage(port, { accountFingerprint: 'fp-j2' });
    try {
      await new Promise((r) => setTimeout(r, 150));
      // ③ 关掉 A，并**等它真的从 clients 里删掉**（不靠猜：用一条不触发 consent 的探测请求观察状态，
      //    不行的话就等 A 的 close 事件真正回调——close 事件由 ws 客户端触发，最可靠）。
      await closeAndWait(a.ws);
      // 前置断言：此时若 A 还在，探测会走页内模态；用一个必然 allow 的低风险工具不足以判别，
      // 所以这里直接断言"协议层只剩 B 那条连接"——通过再连一条探针看是否有 account-duplicate-block
      // 无法判别可信性，故改为：等 close 完成后再发请求，并用"宿主框被调用"作为降级已进入的判据。
      const r = await host.invokeTool('chat-send', { text: 'hi' }, undefined, 'conv-j2');
      expect(nativeCalls, '页内不可用必须降级到宿主框').toBeGreaterThanOrEqual(1);
      expect(consentReqs(b), 'untrusted 页收不到 consent-required').toHaveLength(0);
      const degraded = host.audit.list().filter((x) => x.reason === 'degraded');
      expect(degraded.length, '降级必须留痕').toBeGreaterThanOrEqual(1);
      expect(degraded.at(-1)?.outcome).toBe('executed');
      expect(r.reason === 'consent-denied' || r.reason === 'consent-unavailable').toBe(false);
    } finally {
      try {
        a.ws.close();
      } catch {
        /* 已关 */
      }
      b.ws.close();
    }
  });

  it('③ 双失败：只剩 untrusted 页 + 宿主框弹不出（注入实现抛错）⇒ deny；requestConsent 0 次；审计 denied + degraded', async () => {
    // 注入实现抛错 ⇒ `askHostSide` 就地折成 shown=false（不让异常穿出整条授权链）。
    let nativeCalls = 0;
    const host = await startHost({
      policyMode: 'auto',
      nativeConsent: async () => {
        nativeCalls += 1;
        throw new Error('no gui available');
      },
    });
    const port = Number(new URL(host.url).port);
    const a = await connectPage(port, { accountFingerprint: 'fp-j3' });
    const b = await connectPage(port, { accountFingerprint: 'fp-j3' });
    try {
      await new Promise((r) => setTimeout(r, 150));
      await closeAndWait(a.ws);
      const r = await host.invokeTool('chat-send', { text: 'hi' }, undefined, 'conv-j3');
      expect(nativeCalls, '宿主框应被尝试').toBeGreaterThanOrEqual(1);
      // 双失败 ⇒ 拒绝，且**不回到页面**（B 是 untrusted，收不到）
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('consent-denied');
      expect(consentReqs(b), '双失败不得回到页面').toHaveLength(0);
      const degraded = host.audit.list().filter((x) => x.reason === 'degraded');
      expect(degraded.length, '降级必须留痕').toBeGreaterThanOrEqual(1);
      expect(degraded.at(-1)?.outcome, '双失败必须记 denied').toBe('denied');
    } finally {
      try {
        a.ws.close();
      } catch {
        /* 已关 */
      }
      b.ws.close();
    }
  });

  it('④ 不变量：越界高风险任何情况都不交给页面（页面 0 条 consent-required）', async () => {
    // 必须先配工作区，否则"未配置工作区"会在策略层直接 deny（fail-closed），根本走不到 consent 路由。
    const ws = mkdtempSync(path.join(os.tmpdir(), 'studio-j4-'));
    let nativeCalls = 0;
    try {
      const host = createDesktopHost({
        config: { host: '127.0.0.1', port: 0, token: 't' },
        secret: 's',
        policyMode: 'ask',
        consentTimeoutMs: 600,
        workspace: createWorkspace(ws),
        nativeConsent: async () => {
          nativeCalls += 1;
          return 'deny';
        },
      });
      await host.start();
      running.push(host);
      const page = await connectPage(Number(new URL(host.url).port));
      try {
        // 目标在**工作区外** ⇒ outside=true ⇒ 高风险 + 越界
        const outsideFile = path.join(os.tmpdir(), 'outside-of-workspace.txt');
        const r = await host.invokeTool('file.read', { path: outsideFile }, 'main');
        expect(r.ok).toBe(false);
        expect(consentReqs(page), '越界决议不得交给页面').toHaveLength(0);
        expect(nativeCalls, '越界必须走宿主侧').toBeGreaterThanOrEqual(1);
      } finally {
        page.ws.close();
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
