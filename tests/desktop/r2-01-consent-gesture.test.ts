/**
 * R2-01：consent 决议必须来自用户手势 —— host 侧（nonce 绑定 + 高风险原生框）单测。
 *
 * 核心负控（本卡主负控）：页面伪造决议必须被拒——
 *   页端直接 ws.send({type:'consent-decision', callId, decision:'allow-session'})
 *   不带 nonce / 错 nonce / 重复 nonce → 宿主保持 pending → 超时 deny。
 *   （修法撤掉 = 回到 ownerId===id 就 resolve → 此用例必红。）
 *
 * 另覆盖：低风险走页端 nonce 模态、高风险走 nativeConsent（不发给页面）、超时仍 deny。
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopHost } from '../../src/host/desktop-host';
import { createWorkspace } from '../../src/host/workspace';
import type { HostToPageMessage } from '../../src/host/protocol';

interface FakePage {
  ws: WebSocket;
  seen: HostToPageMessage[];
}

function connectFakePage(port: number, hello: Record<string, unknown>): Promise<FakePage> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    const seen: HostToPageMessage[] = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', ...hello }));
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

function probe<T>(promise: Promise<T>): { settled: boolean; value: unknown } {
  const state: { settled: boolean; value: unknown } = { settled: false, value: undefined };
  void promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error: unknown) => { state.settled = true; state.value = `rejected:${String(error)}`; },
  );
  return state;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 取本页收到的第一条 consent-required 的 nonce。 */
function firstConsent(p: FakePage): Extract<HostToPageMessage, { type: 'consent-required' }> | undefined {
  return p.seen.find((m) => m.type === 'consent-required') as
    | Extract<HostToPageMessage, { type: 'consent-required' }>
    | undefined;
}

describe('R2-01 consent nonce 绑定（低风险页端模态）', () => {
  it('主负控：页面伪造 consent-decision（不带 nonce）→ 被拒，宿主保持 pending 直到超时 deny', async () => {
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      consentTimeoutMs: 800, // 缩短超时以便测试
    });
    await host.start();
    const port = Number(new URL(host.url).port);
    const page = await connectFakePage(port, { id: 'p' });
    try {
      // echo 是低风险（不走原生框），走页端 modal；但需确保命中 consent 闸门。
      // 用 file.write 越界? 不用——用一个一定会 ask 的路径。这里直接驱动 requestConsent 的语义：
      // invokeTool 对一个 approvalClass=mode 且无放行的工具会 ask。用 chat-send（非零审批）。
      const pending = probe(host.invokeTool('chat-send', { text: 'hi' }));
      await wait(120);
      // 页端应收到 consent-required（含 nonce）
      const c = firstConsent(page);
      expect(c).toBeTruthy();
      expect(typeof c!.nonce).toBe('string');

      // 伪造决议：不带 nonce → 必须被忽略（pending 不 settle）
      page.ws.send(JSON.stringify({ type: 'consent-decision', callId: c!.callId, decision: 'allow-session' }));
      await wait(120);
      expect(pending.settled).toBe(false);

      // 错 nonce → 仍被忽略
      page.ws.send(JSON.stringify({ type: 'consent-decision', callId: c!.callId, decision: 'allow-session', nonce: 'wrong' }));
      await wait(120);
      expect(pending.settled).toBe(false);

      // 等超时 → deny（settled，且不是 approved）
      await wait(800);
      expect(pending.settled).toBe(true);
      // invokeTool 对 consent 被拒应返回 ok:false（deny 路径），不是成功执行
      const r = pending.value as { ok?: boolean; error?: string };
      expect(r.ok).not.toBe(true);
    } finally {
      page.ws.close();
      await host.stop();
    }
  });

  it('带正确 nonce 的合法决议 → 正常放行（证明 nonce 通道本身可用）', async () => {
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      consentTimeoutMs: 3000,
    });
    await host.start();
    const port = Number(new URL(host.url).port);
    const page = await connectFakePage(port, { id: 'p' });
    try {
      const pending = probe(host.invokeTool('chat-send', { text: 'ok' }));
      await wait(120);
      const c = firstConsent(page);
      expect(c).toBeTruthy();
      page.ws.send(JSON.stringify({ type: 'consent-decision', callId: c!.callId, decision: 'deny', nonce: c!.nonce }));
      await wait(150);
      expect(pending.settled).toBe(true); // deny 也立即结算（不是挂到超时）
    } finally {
      page.ws.close();
      await host.stop();
    }
  });

  it('nonce 一次性：同一 nonce 第二次回执被忽略（第一次已结算后不存在 pending，构造重复无效）', async () => {
    // 说明：正确 nonce 一旦被消费即 delete pending，第二次回执因 pending 不存在被忽略（相当于 consumed）。
    // 这里直接验证「重复发送不会二次结算/异常」。
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      consentTimeoutMs: 3000,
    });
    await host.start();
    const port = Number(new URL(host.url).port);
    const page = await connectFakePage(port, { id: 'p' });
    try {
      const pending = probe(host.invokeTool('chat-send', { text: 'x' }));
      await wait(120);
      const c = firstConsent(page)!;
      const body = JSON.stringify({ type: 'consent-decision', callId: c.callId, decision: 'deny', nonce: c.nonce });
      page.ws.send(body);
      page.ws.send(body); // 重复
      await wait(150);
      expect(pending.settled).toBe(true);
    } finally {
      page.ws.close();
      await host.stop();
    }
  });
});

describe('R2-01 高风险路由（2026-11-09 卡 J 起按 A′）', () => {
  it('非越界高风险 → 页内模态（页面收到 consent-required），原生框不弹', async () => {
    // 卡 J：R2-01 的「高风险（除越界外）决议不得由页面自答」已作废 ⇒ 非越界高风险改走页内模态。
    // 本用例原断言「页面收不到 consent-required、决议来自 native」是**旧路由**的行为，
    // 路由翻转后按新语义改写（纪律④；原断言面一条没删，见下方仍保留的决策项断言）。
    let nativeCalled = 0;
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      consentTimeoutMs: 3000,
      nativeConsent: async () => {
        nativeCalled += 1;
        return 'deny';
      },
    });
    await host.start();
    const port = Number(new URL(host.url).port);
    const page = await connectFakePage(port, { id: 'p' });
    try {
      // 触发高风险：chat-send 带 conversationId → meta.allowConversation=true；且**不越界**。
      const pending = probe(host.invokeTool('chat-send', { text: 'hi' }, 'main', 'conv-r201'));
      await wait(200);
      // 新语义：页面**收到** consent-required（页内模态），带 nonce
      const c = firstConsent(page);
      expect(c, '非越界高风险应走页内模态').toBeTruthy();
      expect(typeof c!.nonce).toBe('string');
      // 原生框一次都不该弹（主路径不是它）
      expect(nativeCalled, '非越界高风险不再走原生框').toBe(0);
      // 页面回一个带 nonce 的拒绝 → 结论 deny
      page.ws.send(JSON.stringify({ type: 'consent-decision', callId: c!.callId, decision: 'deny', nonce: c!.nonce }));
      await wait(200);
      expect(pending.settled).toBe(true);
    } finally {
      page.ws.close();
    }
  });

  it('越界高风险 → 宿主侧（页面收不到 consent-required），决策项基线仍锁在 allow-once/deny', async () => {
    // 卡 J 的不变量：**越界不得由页面自答**——任何档位都由宿主侧确认（今天＝原生框）。
    let nativeCalled = 0;
    let lastDecisions: readonly string[] = [];
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      consentTimeoutMs: 3000,
      policyMode: 'ask',
      workspace: createWorkspace(mkdtempSync(path.join(os.tmpdir(), 'studio-r201-'))),
      nativeConsent: async (req) => {
        nativeCalled += 1;
        lastDecisions = req.allowedDecisions;
        return 'deny';
      },
    });
    await host.start();
    const port = Number(new URL(host.url).port);
    const page = await connectFakePage(port, { id: 'p' });
    try {
      // 目标在工作区**之外**（工作区已配好，否则策略层 workspace-unconfigured 直接 deny，走不到 consent 路由）
      const outsideFile = path.join(os.tmpdir(), 'r201-outside-of-workspace.txt');
      const pending = probe(host.invokeTool('file.read', { path: outsideFile }, 'main'));
      await wait(300);
      expect(firstConsent(page), '越界决议不得交给页面').toBeUndefined();
      expect(nativeCalled, '越界必须走宿主侧').toBeGreaterThanOrEqual(1);
      expect(lastDecisions).toContain('allow-once');
      expect(lastDecisions).toContain('deny');
      expect(lastDecisions).not.toContain('allow-session');
      await wait(200);
      expect(pending.settled).toBe(true);
    } finally {
      page.ws.close();
    }
  });
});
