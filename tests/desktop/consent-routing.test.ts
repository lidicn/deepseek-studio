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

/**
 * 页端发一条 `tool-call` 并等对应回执——用来探测「这条连接还活着，但宿主已不认它」。
 * （`page-runtime.ts:426-433`：untrusted 连接的任何 tool-call 一律回 `page-not-ready`。）
 */
function callFromPage(p: FakePage, invocationName: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const callId = `probe-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      p.ws.off('message', onMsg);
      reject(new Error('tool-call 回执超时（页可能已被 close）'));
    }, 2000);
    function onMsg(raw: unknown): void {
      let m: { type?: string; callId?: string; ok?: boolean; error?: string };
      try {
        m = JSON.parse(String(raw)) as typeof m;
      } catch {
        return;
      }
      if (m.type !== 'tool-call-result' || m.callId !== callId) return;
      clearTimeout(timer);
      p.ws.off('message', onMsg);
      resolve({ ok: m.ok === true, ...(m.error ? { error: m.error } : {}) });
    }
    p.ws.on('message', onMsg);
    p.ws.send(JSON.stringify({ type: 'tool-call', callId, invocationName, params: {} }));
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
    // 构造（PM 2026-11-13 裁定，方案 A：**只换构造，断言一行不动**）：
    //   ① 连一条**不带 accountFingerprint** 的页 ⇒ trusted；
    //   ② 该页自报注入被篡改（`integrity-alert`）⇒ `page-runtime.ts:447-450` 置 `untrusted = true`，**不 close**；
    // ⇒ `connectedPages` 仍非空（L2311 那道 `length === 0` 的门不拦），
    //   但 L2417-2419 的 `pageAvailable`（**只看 `untrusted`，不看 `ready`**）⇒ false ⇒ **进降级分支**。
    //
    // 为什么不用旧配方「连 A/B 同指纹 → 关 A → B 承接」：那是借 D3 的缺陷（`untrusted` 只粘不放）
    // 造一个"永久被封的页"；D3 修好后关掉 A 会把 B 解封回 trusted，该构造随缺陷一起消失了
    //（「关 A → B 解封」现在由 `account-duplicate-misjudge.test.ts` 的反证锁覆盖，不要重复）。
    // `integrity-alert` 是**真实存在**的第三条置 untrusted 路径（另两条：origin mismatch、duplicate），
    // 且不会被 `reevaluateAccountLocks` 解封——那函数开头就是 `if (!c.accountFingerprint) continue;`，
    // 没指纹的连接根本不参与重算。覆盖面没缩，反而更贴生产（注入被篡改是真会发生的）。
    let nativeCalls = 0;
    const host = await startHost({
      policyMode: 'auto',
      nativeConsent: async () => {
        nativeCalls += 1;
        return 'allow-once';
      },
    });
    const port = Number(new URL(host.url).port);
    const b = await connectPage(port);
    try {
      b.ws.send(JSON.stringify({ type: 'integrity-alert', reason: 'injection-tampered' }));
      await new Promise((r) => setTimeout(r, 100));
      // 前置：页**还连着**（socket 仍 OPEN），但已被判不可信
      //（自报 tool-call 拿 `page-not-ready` ⇒ 确系 untrusted，而不是被 close 掉）。
      expect(b.ws.readyState, '构造失败：页已断开，测不到「页在但不可信」').toBe(WebSocket.OPEN);
      const probe = await callFromPage(b, 'mcp.list');
      expect(probe.ok, 'integrity-alert 之后该页必须已 untrusted（fail-closed）').toBe(false);
      expect(probe.error).toBe('page-not-ready');
      const r = await host.invokeTool('chat-send', { text: 'hi' }, undefined, 'conv-j2');
      expect(nativeCalls, '页内不可用必须降级到宿主框').toBeGreaterThanOrEqual(1);
      expect(consentReqs(b), 'untrusted 页收不到 consent-required').toHaveLength(0);
      const degraded = host.audit.list().filter((x) => x.reason === 'degraded');
      expect(degraded.length, '降级必须留痕').toBeGreaterThanOrEqual(1);
      expect(degraded.at(-1)?.outcome).toBe('executed');
      expect(r.reason === 'consent-denied' || r.reason === 'consent-unavailable').toBe(false);
    } finally {
      b.ws.close();
    }
  });

  it('③ 双失败：只剩 untrusted 页 + 宿主框弹不出（注入实现抛错）⇒ deny；requestConsent 0 次；审计 denied + degraded', async () => {
    // 与 ② 同一构造（`integrity-alert` 造「页在但不可信」），只把宿主框实现换成"抛错 ⇒ shown=false"。
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
    const b = await connectPage(port);
    try {
      b.ws.send(JSON.stringify({ type: 'integrity-alert', reason: 'injection-tampered' }));
      await new Promise((r) => setTimeout(r, 100));
      expect(b.ws.readyState, '构造失败：页已断开').toBe(WebSocket.OPEN);
      const probe = await callFromPage(b, 'mcp.list');
      expect(probe.error, 'integrity-alert 之后该页必须已 untrusted').toBe('page-not-ready');
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
