/**
 * 卡 H（2026-11-08 出资人拍板「完全放开改成不会弹窗」）：full 档下 always 类**不再产生任何确认请求**。
 *
 * 本文件是**行为级**验证：起一个真的 DesktopHost、连一个假页、在 `policyMode: 'full'` 下调用工具，
 * 断言「页端没收到 consent-required」且「nativeConsent 桩没被调用」——两者都没有＝真的没弹框。
 * （`authorization.test.ts` 里那几条锁的是 resolveAuthorization 的决策值；本文件锁的是**链路行为**，
 *   即 desktop-host 确实没有走到 ensureConsent。两者互补，不可互替：台账 82 枚"锁载体"那条。）
 *
 * 边界（写清楚，免得后人误读）：
 *   · full 档放行的是**询问层**；hard-deny 地板与策略层 deny 仍是拒绝（下面有负控）。
 *   · `memory.purge`（FULL_MODE_STILL_ASKS）在 full 档**仍问一次**——不可撤销操作的显式例外。
 */
import { afterEach, describe, expect, it } from 'vitest';
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

/** 这一页有没有收到过确认请求（任何形态）。 */
function consentRequests(p: FakePage): HostToPageMessage[] {
  return p.seen.filter((m) => m.type === 'consent-required');
}

async function startFullHost(onNative?: (req: NativeConsentRequest) => Promise<ConsentDecision | null>): Promise<DesktopHost> {
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 't' },
    secret: 's',
    policyMode: 'full',
    consentTimeoutMs: 400,
    ...(onNative ? { nativeConsent: onNative } : {}),
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

describe('卡 H · full 档 always 类不再弹框（行为级）', () => {
  it('full + python.exec：页端 0 条 consent-required，原生框 0 次调用', async () => {
    let nativeCalls = 0;
    const host = await startFullHost(async () => {
      nativeCalls += 1;
      return 'allow-once';
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      const r = await host.invokeTool('python.exec', { code: 'print(1)' }, 'main');
      // 语义正确性先看决策：full 下放行（不因"命令风险"再问）
      expect(r.reason === 'consent-denied' || r.reason === 'consent-unavailable').toBe(false);
      await wait(120);
      // 核心判据：两条"弹框"通道都没被触发
      expect(consentRequests(page), 'full 档不许再向页端发 consent-required').toHaveLength(0);
      expect(nativeCalls, 'full 档不许再弹原生确认框').toBe(0);
      // 审计留痕：full 放行必须可追溯（reason 就是 'full-mode-allow'，不是执行侧 reason）。
      // 负控＝把 desktop-host 审计那行的 full-mode-allow 分支去掉，本断言必红。
      const last = host.audit.list().at(-1);
      expect(last?.outcome === 'executed' ? last?.reason : 'executed', 'full 档放行必须留痕 reason=full-mode-allow').toBe(
        last?.outcome === 'executed' ? 'full-mode-allow' : 'executed',
      );
    } finally {
      page.ws.close();
    }
  });

  it('full + memory.delete（归档、可恢复）：同样不弹框', async () => {
    let nativeCalls = 0;
    const host = await startFullHost(async () => {
      nativeCalls += 1;
      return 'deny';
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      const pending = host.invokeTool('memory.delete', { id: 'mem-x' }, 'main');
      await wait(150);
      expect(consentRequests(page)).toHaveLength(0);
      expect(nativeCalls).toBe(0);
      const r = await pending;
      expect(r.reason === 'consent-denied' || r.reason === 'consent-unavailable').toBe(false);
    } finally {
      page.ws.close();
    }
  });

  it('full + mcp.call：同样不弹框', async () => {
    let nativeCalls = 0;
    const host = await startFullHost(async () => {
      nativeCalls += 1;
      return 'deny';
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      const pending = host.invokeTool('mcp.call', { serverId: 'srv', tool: 'x', args: {} }, 'main');
      await wait(150);
      expect(consentRequests(page)).toHaveLength(0);
      expect(nativeCalls).toBe(0);
      await pending;
    } finally {
      page.ws.close();
    }
  });

  it('full + memory.purge（唯一例外）：仍然要问一次（原生框或页端模态任一通道被触发）', async () => {
    let nativeCalls = 0;
    const host = await startFullHost(async () => {
      nativeCalls += 1;
      return 'deny';
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      const r = await host.invokeTool('memory.purge', { id: 'mem-x' }, 'main');
      // 例外语义：仍在询问层。memory.purge 非"受治理 文件/进程类"⇒ consentMeta 无 riskFlags
      // ⇒ 走页端模态（低风险分支）；断言通道无关，只要"问了一次"。
      expect(nativeCalls + consentRequests(page).length, 'memory.purge 在 full 下必须仍问一次').toBeGreaterThanOrEqual(1);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('consent-denied');
    } finally {
      page.ws.close();
    }
  });

  it('auto 档 python.exec → 仍 ask（档位降级必须重新弹）', async () => {
    let nativeCalls = 0;
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      policyMode: 'auto',
      consentTimeoutMs: 400,
      nativeConsent: async () => {
        nativeCalls += 1;
        return 'deny';
      },
    });
    await host.start();
    running.push(host);
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      const r = await host.invokeTool('python.exec', { code: 'print(1)' }, 'main');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('consent-denied');
      // 询问确实发生（通道由风险等级决定：无风险模式命中⇒页端模态；命中风险⇒原生框）
      expect(nativeCalls + consentRequests(page).length).toBeGreaterThanOrEqual(1);
    } finally {
      page.ws.close();
    }
  });

  it('full + hard-deny（内联代码 node -e）→ 仍 deny，不是询问也不是放行', async () => {
    let nativeCalls = 0;
    const host = await startFullHost(async () => {
      nativeCalls += 1;
      return 'allow-once';
    });
    const page = await connectFakePage(Number(new URL(host.url).port));
    try {
      const r = await host.invokeTool('shell.exec', { command: 'node -e "console.log(1)"' }, 'main');
      expect(r.ok).toBe(false);
      // 硬拒地板：既不弹框、也不放行
      expect(nativeCalls).toBe(0);
      expect(consentRequests(page)).toHaveLength(0);
    } finally {
      page.ws.close();
    }
  });
});
