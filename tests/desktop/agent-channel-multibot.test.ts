import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { createAgentChannel, type AgentChannelHost, type BotHandle } from '../../src/host/agent-channel';

/**
 * v0.23：agent-channel 多 bot 路由测试。
 *
 * 验证：
 *   - 面板不传 botId → 路由到 main（向后兼容）
 *   - 面板传 botId → 路由到对应 bot
 *   - per-bot busy 检查（一个 bot busy 不阻塞另一个）
 *   - get-state 返回 bots 列表
 *
 * 注意：消息监听器必须在 WebSocket open 之前注册，否则初始 state 消息会丢失
 * （ws 库不缓冲无监听器时的消息）。
 */

function makeBot(running = false): BotHandle & { _sends: string[] } {
  const sends: string[] = [];
  return {
    _sends: sends,
    sendMessage: (text) => {
      sends.push(text);
      return Promise.resolve();
    },
    stop: () => {},
    get running() {
      return running;
    },
    health: () => Promise.resolve({ ok: true }),
  };
}

function makeMockHost(bots: Map<string, BotHandle & { _sends: string[] }>): AgentChannelHost {
  return {
    bots: {
      get(botId = 'main') {
        const b = bots.get(botId);
        if (!b) throw new Error(`bot not found: ${botId}`);
        return b;
      },
      list() {
        return [...bots.keys()].map((botId) => ({ botId, running: bots.get(botId)!.running }));
      },
    },
    onAgentEvent: () => () => {},
    get policyMode() {
      return 'auto' as never;
    },
    setPolicyMode: () => {},
    get workspaceRoot() {
      return null;
    },
    setWorkspaceRoot: () => ({ ok: true }),
    pickFolder: () => Promise.resolve(null),
  };
}

/**
 * 面板连接管理器：封装 ws 连接 + 消息队列。
 * 消息监听器在连接前注册，防止丢失初始 state。
 */
class PanelConnection {
  ws: WebSocket;
  private queue: Record<string, unknown>[] = [];
  private waiters: Array<{ type: string; resolve: (msg: Record<string, unknown>) => void }> = [];

  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/agent-ws?token=${token}`);
    // 立即注册消息监听器（在 open 之前）
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const waiter = this.waiters.find((w) => w.type === msg.type);
        if (waiter) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(msg);
        } else {
          this.queue.push(msg);
        }
      } catch {
        /* ignore */
      }
    });
  }

  /** 等待 open 完成。 */
  async open(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.on('open', () => resolve());
      setTimeout(() => resolve(), 5000);
    });
  }

  /** 发送消息并等待指定类型的 ack 回复。 */
  async sendAndAck(msg: unknown, ackType = 'ack'): Promise<Record<string, unknown>> {
    // 先检查队列里是否已有未消费的回复
    const qi = this.queue.findIndex((m) => m.type === ackType);
    if (qi >= 0) {
      this.ws.send(JSON.stringify(msg));
      return this.queue.splice(qi, 1)[0];
    }
    // 等待新的回复
    return new Promise((resolve) => {
      this.waiters.push({ type: ackType, resolve });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.type === ackType);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          resolve({ type: 'timeout' });
        }
      }, 3000);
    });
  }

  /** 取出下一条指定类型的消息。 */
  async next(type: string): Promise<Record<string, unknown>> {
    const qi = this.queue.findIndex((m) => m.type === type);
    if (qi >= 0) return this.queue.splice(qi, 1)[0];
    return new Promise((resolve) => {
      this.waiters.push({ type, resolve });
      setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.type === type);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          resolve({ type: 'timeout' });
        }
      }, 3000);
    });
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

describe('agent-channel —— v0.23 多 bot 路由', () => {
  it('不传 botId → 路由到 main（向后兼容）', async () => {
    const main = makeBot();
    const bots = new Map([['main', main]]);
    const server = createServer();
    const channel = createAgentChannel({
      server,
      host: makeMockHost(bots),
      token: 'tok',
      path: '/agent-ws',
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const panel = new PanelConnection(port, 'tok');
    await panel.open();
    await panel.next('state'); // 消费初始 state

    const ack = await panel.sendAndAck({ type: 'send', text: '你好', reqId: 'r1' });
    expect(ack).toMatchObject({ type: 'ack', ok: true });
    expect((ack as any).data).toMatchObject({ botId: 'main' });
    await new Promise((r) => setTimeout(r, 20));
    expect(main._sends).toEqual(['你好']);

    panel.close();
    channel.dispose();
    server.close();
  });

  it('传 botId=expert-1 → 路由到 expert-1', async () => {
    const main = makeBot();
    const expert = makeBot();
    const bots = new Map([
      ['main', main],
      ['expert-1', expert],
    ]);
    const server = createServer();
    const channel = createAgentChannel({
      server,
      host: makeMockHost(bots),
      token: 'tok',
      path: '/agent-ws',
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const panel = new PanelConnection(port, 'tok');
    await panel.open();
    await panel.next('state');

    const ack = await panel.sendAndAck({ type: 'send', text: '审计一下', botId: 'expert-1', reqId: 'r1' });
    expect(ack).toMatchObject({ type: 'ack', ok: true });
    expect((ack as any).data).toMatchObject({ botId: 'expert-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(expert._sends).toEqual(['审计一下']);
    expect(main._sends).toEqual([]);

    panel.close();
    channel.dispose();
    server.close();
  });

  it('main busy 时 send 到 main 返回 agent-busy，但不阻塞 send 到 expert-1', async () => {
    const main = makeBot(true); // main busy
    const expert = makeBot(false);
    const bots = new Map([
      ['main', main],
      ['expert-1', expert],
    ]);
    const server = createServer();
    const channel = createAgentChannel({
      server,
      host: makeMockHost(bots),
      token: 'tok',
      path: '/agent-ws',
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const panel = new PanelConnection(port, 'tok');
    await panel.open();
    await panel.next('state');

    // main busy → 拒绝
    const busyAck = await panel.sendAndAck({ type: 'send', text: '任务', reqId: 'r1' });
    expect(busyAck).toMatchObject({ type: 'ack', ok: false, error: 'agent-busy' });

    // expert-1 不忙 → 放行
    const expertAck = await panel.sendAndAck({ type: 'send', text: '任务', botId: 'expert-1', reqId: 'r2' });
    expect(expertAck).toMatchObject({ type: 'ack', ok: true });
    expect((expertAck as any).data).toMatchObject({ botId: 'expert-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(expert._sends).toEqual(['任务']);

    panel.close();
    channel.dispose();
    server.close();
  });

  it('get-state 返回 bots 列表', async () => {
    const main = makeBot(true);
    const expert = makeBot(false);
    const bots = new Map([
      ['main', main],
      ['expert-1', expert],
    ]);
    const server = createServer();
    const channel = createAgentChannel({
      server,
      host: makeMockHost(bots),
      token: 'tok',
      path: '/agent-ws',
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const panel = new PanelConnection(port, 'tok');
    await panel.open();
    const state = (await panel.next('state')) as { bots: { botId: string; running: boolean }[]; running: boolean };
    expect(state.bots).toHaveLength(2);
    expect(state.bots.find((b) => b.botId === 'main')?.running).toBe(true);
    expect(state.bots.find((b) => b.botId === 'expert-1')?.running).toBe(false);
    // running 字段向后兼容（指向 main）
    expect(state.running).toBe(true);

    panel.close();
    channel.dispose();
    server.close();
  });

  it('stop 带 botId 停对应 bot', async () => {
    const main = makeBot();
    const expert = makeBot();
    const stopSpy = vi.spyOn(expert, 'stop');
    const bots = new Map([
      ['main', main],
      ['expert-1', expert],
    ]);
    const server = createServer();
    const channel = createAgentChannel({
      server,
      host: makeMockHost(bots),
      token: 'tok',
      path: '/agent-ws',
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const panel = new PanelConnection(port, 'tok');
    await panel.open();
    await panel.next('state');

    const ack = await panel.sendAndAck({ type: 'stop', botId: 'expert-1', reqId: 'r1' });
    expect(ack).toMatchObject({ type: 'ack', ok: true });
    expect((ack as any).data).toMatchObject({ botId: 'expert-1' });
    expect(stopSpy).toHaveBeenCalled();

    panel.close();
    channel.dispose();
    server.close();
  });
});
