/**
 * D1–D4 账号重复判定误判链 —— 回归锁。
 *
 * 真机现场：单窗口 Studio 被判「同账号多窗口」，红底覆盖层 + `page-not-ready`，
 * 页面拿不到任何 MCP 工具（模型只能手写裸 `<mcp_call>` XML 当正文）。
 * 根因是四条缺陷叠加：
 *   D1 `connect()` 不幂等 → 重复调用再开一条 socket（旧的不关）；
 *   D2 `onclose` 无条件清引用 → 旧 socket 迟到的 close 抹掉新连接；
 *   D3 `untrusted` 只粘不放 → 占位者走了，重复方永远封着；
 *   D4 页端没有解封能力 → 覆盖层撤不掉。
 *
 * 本文件锁四件事（含**反证锁**：同账号真并发两窗仍必须 fail-closed）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { createPageRuntimeHub } from '../../src/host/page-runtime';
import type { HostToPageMessage } from '../../src/host/protocol';
import { createHostClient, type WebSocketLike, type WebSocketFactory } from '../../src/desktop/host-client';

// ── 假 socket（D1/D2 用）──────────────────────────────────────────────
class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }
  /** 模拟服务端接受连接。 */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 模拟 close 事件（可重复调用，用于「迟到 close」）。 */
  fireClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** 记录每一条被创建的 socket，供断言「只开了一条」。 */
function makeFactory() {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url: string) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return { sockets, factory };
}

describe('D1 connect() 幂等 —— 重复调用不得再开第二条 socket', () => {
  it('connect() 连调两次 → fake 工厂只创建 1 个 socket', () => {
    const { sockets, factory } = makeFactory();
    const client = createHostClient({
      url: 'ws://127.0.0.1:8760/studio',
      capabilities: [],
      wsFactory: factory,
    });
    client.connect();
    client.connect();
    client.connect();
    expect(sockets).toHaveLength(1);
    client.disconnect();
  });

  it('已 OPEN 时再次 connect() 不开新 socket', () => {
    const { sockets, factory } = makeFactory();
    const client = createHostClient({
      url: 'ws://127.0.0.1:8760/studio',
      capabilities: [],
      wsFactory: factory,
    });
    client.connect();
    sockets[0].open();
    client.connect();
    expect(sockets).toHaveLength(1);
    expect(client.connected).toBe(true);
    client.disconnect();
  });
});

describe('D2 onclose 不得抹掉新连接', () => {
  it('旧 socket 迟到的 onclose（新连接已接管）→ host.connected 仍为 true', async () => {
    const { sockets, factory } = makeFactory();
    const client = createHostClient({
      url: 'ws://127.0.0.1:8760/studio',
      capabilities: [],
      wsFactory: factory,
      maxBackoffMs: 50,
    });
    client.connect();
    const a = sockets[0];
    a.open();
    expect(client.connected).toBe(true);

    // A 正常断开 → onclose 清引用并排下一轮重连（退避 500ms 起步）。
    a.fireClose();
    expect(client.connected).toBe(false);

    // 等重连把 B 建起来并 OPEN。
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    const b = sockets[1];
    b.open();
    expect(client.connected).toBe(true);

    // **关键**：A 迟到的 close（例如底层重复上报 / reload 后旧事件晚到）不能再清掉 B。
    a.fireClose();
    expect(client.connected).toBe(true);

    client.disconnect();
  });
});

// ── 宿主侧（D3）────────────────────────────────────────────────────────
interface FakePage {
  ws: WebSocket;
  inbox: HostToPageMessage[];
  send: (msg: unknown) => void;
}

async function connectFakePage(opts: {
  port: number;
  botId?: string;
  accountFingerprint?: string;
}): Promise<FakePage> {
  const { port, botId, accountFingerprint } = opts;
  const inbox: HostToPageMessage[] = [];
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        origin: 'https://chat.deepseek.com',
        sessionId: crypto.randomUUID(),
        ...(botId !== undefined ? { botId } : {}),
        ...(accountFingerprint !== undefined ? { accountFingerprint } : {}),
      }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as HostToPageMessage;
        inbox.push(msg);
        if (msg.type === 'hello-ack') {
          resolve({ ws, inbox, send: (m: unknown) => ws.send(JSON.stringify(m)) });
        }
      } catch {
        /* ignore */
      }
    });
  });
}

const waitFor = async (fn: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('D3 账号锁重算 —— 占位者离开后重复方解封', () => {
  let server: ReturnType<typeof createServer>;
  let hub: ReturnType<typeof createPageRuntimeHub>;
  let port: number;

  async function startHub(): Promise<void> {
    server = createServer();
    hub = createPageRuntimeHub({ server, token: 't' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  afterEach(async () => {
    try { hub?.dispose(); } catch { /* ignore */ }
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it('两条同指纹连接，关闭 trusted 那条 → 另一条 untrusted 变 false 且收到 account-duplicate-cleared', async () => {
    await startHub();
    const a = await connectFakePage({ port, botId: 'bot-a', accountFingerprint: 'fp-SAME' });
    const b = await connectFakePage({ port, botId: 'bot-b', accountFingerprint: 'fp-SAME' });

    // 前置：b 被判重复。
    expect(b.inbox.find((m) => m.type === 'account-duplicate-block')).toBeDefined();
    expect(hub.trustedPages.map((p) => p.botId)).toEqual(['bot-a']);

    // 关闭占位者 a。
    a.ws.close();
    await waitFor(() => hub.trustedPages.some((p) => p.botId === 'bot-b'));

    // b 收到解封通知，且不再是 untrusted。
    await waitFor(() => b.inbox.some((m) => m.type === 'account-duplicate-cleared'));
    const bPage = hub.connectedPages.find((p) => p.botId === 'bot-b');
    expect(bPage?.untrusted).toBe(false);
    expect(hub.trustedPages.map((p) => p.botId)).toEqual(['bot-b']);

    b.ws.close();
  });

  /**
   * **反证锁（不许漏）**：两条同指纹连接**同时存活**时，后到的那条必须仍然
   * `untrusted === true`、仍然 `page-not-ready`——防封号铁律不能被本次修复拆掉。
   */
  it('反证锁：同指纹两条同时存活 → 后者仍 untrusted 且工具调用 page-not-ready', async () => {
    await startHub();
    const a = await connectFakePage({ port, botId: 'bot-a', accountFingerprint: 'fp-DUP' });
    const b = await connectFakePage({ port, botId: 'bot-b', accountFingerprint: 'fp-DUP' });

    // 两条都在线：a 仍 trusted，b 仍 untrusted（本次修复不得放宽这一点）。
    expect(hub.connectedPages.length).toBe(2);
    const aPage = hub.connectedPages.find((p) => p.botId === 'bot-a');
    const bPage = hub.connectedPages.find((p) => p.botId === 'bot-b');
    expect(aPage?.untrusted).toBe(false);
    expect(bPage?.untrusted).toBe(true);

    // b 发 tool-call → 必须被 page-not-ready 拒绝（fail-closed 仍然生效）。
    b.send({ type: 'tool-call', callId: 'dup-call-1', invocationName: 'mcp.list', params: {} });
    await waitFor(() =>
      b.inbox.some((m) => m.type === 'tool-call-result' && (m as { error?: string }).error === 'page-not-ready'),
    );
    const result = b.inbox.find(
      (m) => m.type === 'tool-call-result' && (m as { callId?: string }).callId === 'dup-call-1',
    ) as { ok?: boolean; error?: string } | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('page-not-ready');

    a.ws.close();
    b.ws.close();
  });

  it('三条同指纹：关闭 trusted 后只解封一条，其余仍 untrusted（不破铁律）', async () => {
    await startHub();
    const a = await connectFakePage({ port, botId: 'bot-a', accountFingerprint: 'fp-TRI' });
    const b = await connectFakePage({ port, botId: 'bot-b', accountFingerprint: 'fp-TRI' });
    const c = await connectFakePage({ port, botId: 'bot-c', accountFingerprint: 'fp-TRI' });

    expect(hub.trustedPages.length).toBe(1);
    expect(hub.trustedPages[0].botId).toBe('bot-a');

    a.ws.close();
    // 只剩一条 trusted（不会同时解封 b 和 c）。
    await waitFor(() => hub.trustedPages.length === 1 && hub.trustedPages[0].botId === 'bot-b');

    const cPage = hub.connectedPages.find((p) => p.botId === 'bot-c');
    expect(cPage?.untrusted).toBe(true);

    b.ws.close();
    c.ws.close();
  });
});
