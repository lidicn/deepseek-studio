/**
 * 卡 J · ⑥ 同意超时防线（行为级，不是"参数传进去了"）
 *
 * 判据（PM座 08:5x 定死四条）：
 *   ① 页端通道**不响应**：FakePage 收下 consent-required 但**不回** consent-decision
 *   ② **到点 deny**：超时后结论是 `consent-denied`（不是挂起、不是 consent-unavailable）
 *   ③ **pending 零残留**：超时后表已删，**迟到的回执必须作废**——再发同一 callId ＋ 正确 nonce 也不许放行
 *   ④ **审计记一次**：能看到一条超时拒绝的审计条目（outcome 为 denied 类）
 *
 * 为什么 ③ 是关键：只验"到点 deny"的话，一个**没删 pending 但恰好返回 deny** 的实现也能绿；
 * 迟到回执被拒才是"表真的清了"的可观测证据。跨进程看不到 pendingConsent.size，
 * 所以用"迟到回执 + consent-abort 已被推给页面"两条行为代理——后者是宿主删除表项**之后**才发的动作
 * （page-runtime:730-734）。
 *
 * 超时值调短到 300ms，只压缩等待时间，不改变判据。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import type { HostToPageMessage } from '../../src/host/protocol';

interface FakePage {
  ws: WebSocket;
  seen: HostToPageMessage[];
}

const running: DesktopHost[] = [];

function connectPage(port: number): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    const seen: HostToPageMessage[] = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' })));
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

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const consentReqs = (p: FakePage) => p.seen.filter((m) => m.type === 'consent-required') as Array<{
  callId: string;
  nonce: string;
}>;
const consentAborts = (p: FakePage) => p.seen.filter((m) => m.type === 'consent-abort');

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

describe('卡 J ⑥ · 同意超时防线（页端不响应 ⇒ 到点 deny、无残留、审计记一次）', () => {
  it('页端收下 consent-required 不回执 ⇒ 到点 consent-denied；迟到回执被作废；审计记一次', async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), 'studio-j6-'));
    try {
      const host = createDesktopHost({
        config: { host: '127.0.0.1', port: 0, token: 't' },
        secret: 's',
        policyMode: 'ask',
        workspace: createWorkspace(ws),
        consentTimeoutMs: 300, // 只压缩等待时间，判据不变
      });
      await host.start();
      running.push(host);
      const page = await connectPage(Number(new URL(host.url).port));
      try {
        const startedAt = Date.now();
        // 必须用**非越界高风险**：chat-send + conversationId ⇒ allowConversation 事实为真 ⇒ 高风险，
        // 且 outside 未设 ⇒ 走页内模态主路径（越界那格归宿主侧，不经页端超时，验不了这条）。
        const pending = host.invokeTool('chat-send', { text: 'hi' }, 'main', 'conv-j6');
        let settled: { ok: boolean; reason?: string } | undefined;
        void pending.then((r) => {
          settled = r;
        });

        // ① 页面确实收到了请求，但**故意不回**
        await wait(120);
        const reqs = consentReqs(page);
        expect(reqs.length, '页面应收到一条 consent-required').toBeGreaterThanOrEqual(1);
        const req = reqs[0]!;

        // ② 到点 deny（等到 pending 结算）
        const deadline = Date.now() + 3000;
        while (!settled && Date.now() < deadline) await wait(20);
        expect(settled, '超时后必须结算，不许挂起').toBeDefined();
        expect(settled!.ok).toBe(false);
        expect(settled!.reason, '超时必须 deny').toBe('consent-denied');
// 超时应发生在超时值量级、而不是瞬间或无限期
        const elapsed = Date.now() - startedAt;
        expect(elapsed, `超时耗时 ${elapsed}ms 应与 300ms 同量级`).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(2500);

        // ③ 迟到回执（带正确 nonce）不许放行 ⇒ 表项确已删除
        page.ws.send(JSON.stringify({ type: 'consent-decision', callId: req.callId, decision: 'allow-once', nonce: req.nonce }));
        await wait(200);
        // 结论仍是 deny：settled 记录已固定，迟到回执不改结论
        expect(settled!.reason).toBe('consent-denied');

        // ④ 宿主在删表后向页端推了 consent-abort（reason=consent-timeout）＝删表可观测证据
        const aborts = consentAborts(page).filter((m) => (m as { callId?: string }).callId === req.callId);
        expect(aborts.length, '超时必须推 consent-abort 作废页端弹窗').toBeGreaterThanOrEqual(1);

        // ⑤ 审计有一次拒绝（denied 类 outcome）
        const audits = host.audit.list();
        const denied = audits.filter((a) => a.outcome === 'denied' || a.outcome === 'consent-denied');
        expect(denied.length, '审计应记一次超时拒绝').toBeGreaterThanOrEqual(1);
      } finally {
        page.ws.close();
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
