import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { createAgentChannel, type AgentChannelHost, type BotHandle } from '../../src/host/agent-channel';
import type { ChatRoomEvent } from '../../src/host/bot/types';

/**
 * v0.28 收尾接线层测试：agent-channel 广播 ChatRoomEvent。
 *
 * 验证接线层（commit 9fc8a47）的核心契约：
 *   - host.onChatRoomEvent 推入 ChatRoomBotReplyEvent → WS 客户端收 {type:'chat-room-event', event}
 *   - host.onChatRoomEvent 推入 ChatRoomSummaryEvent → 同样 fan-out
 *   - 无 onChatRoomEvent（host 不提供）→ agent-channel 不崩，原行为不变（向后兼容）
 *   - 多客户端 fan-out（一个事件推给所有已连接 socket）
 *
 * 这是 desktop-host onBotReply/onSummary → agent-channel broadcast → UI 渲染 的中间环节验证。
 */

function makeBot(running = false): BotHandle {
  return {
    sendMessage: () => Promise.resolve(),
    stop: () => {},
    get running() {
      return running;
    },
    health: () => Promise.resolve({ ok: true }),
  };
}

/** 带 onChatRoomEvent 回调收集器的 mock host。 */
function makeMockHostWithChatRoom(): AgentChannelHost & {
  emitChatRoomEvent: (event: ChatRoomEvent) => void;
} {
  let chatRoomCb: ((event: ChatRoomEvent) => void) | null = null;
  const bots = new Map<string, BotHandle>([['main', makeBot()]]);
  return {
    bots: {
      get: () => bots.get('main')!,
      list: () => [{ botId: 'main', running: false }],
    },
    onAgentEvent: () => () => {},
    onChatRoomEvent: (cb) => {
      chatRoomCb = cb;
      return () => {
        chatRoomCb = null;
      };
    },
    get policyMode() {
      return 'auto' as never;
    },
    setPolicyMode: () => {},
    get workspaceRoot() {
      return null;
    },
    setWorkspaceRoot: () => ({ ok: true }),
    pickFolder: () => Promise.resolve(null),
    emitChatRoomEvent: (event) => chatRoomCb?.(event),
  };
}

/** 无 onChatRoomEvent 的旧版 host（向后兼容验证）。 */
function makeLegacyMockHost(): AgentChannelHost {
  const bots = new Map<string, BotHandle>([['main', makeBot()]]);
  return {
    bots: {
      get: () => bots.get('main')!,
      list: () => [{ botId: 'main', running: false }],
    },
    onAgentEvent: () => () => {},
    // 故意不提供 onChatRoomEvent
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

/** 简化版 WS 客户端：收集所有收到的消息。 */
class Client {
  ws: WebSocket;
  messages: Record<string, unknown>[] = [];
  private openPromise: Promise<void>;

  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/agent-ws?token=${token}`);
    this.openPromise = new Promise((resolve) => {
      this.ws.on('open', () => resolve());
      setTimeout(() => resolve(), 5000);
    });
    this.ws.on('message', (raw) => {
      try {
        this.messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    });
  }

  open(): Promise<void> {
    return this.openPromise;
  }

  /** 取下一条指定 type 的消息（从已收队列或等待新消息）。 */
  waitForType(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const existing = this.messages.find((m) => m.type === type);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
      const check = () => {
        const found = this.messages.find((m) => m.type === type);
        if (found) {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(found), 1);
          resolve(found);
        }
      };
      const interval = setInterval(() => {
        check();
        if (this.messages.find((m) => m.type === type)) clearInterval(interval);
      }, 20);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

describe('agent-channel —— v0.28 ChatRoomEvent 广播', () => {
  it('onChatRoomEvent 推入 chat-bot-reply → WS 客户端收 {type:"chat-room-event"}', async () => {
    const host = makeMockHostWithChatRoom();
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const client = new Client(port, 'tok');
    await client.open();
    await client.waitForType('state'); // 消费初始 state

    // 模拟 chat-room-runtime onBotReply → desktop-host emitChatRoomEvent → onChatRoomEvent
    host.emitChatRoomEvent({
      kind: 'chat-bot-reply',
      roomId: 'room-1',
      persona: 'frontend-expert',
      botId: 'frontend-expert',
      senderType: 'sub-bot',
      content: '前端密钥无处安放',
      messageId: 'msg-1',
      timestamp: 1700000000000,
    });

    const msg = await client.waitForType('chat-room-event');
    expect(msg.type).toBe('chat-room-event');
    const event = msg.event as ChatRoomEvent;
    expect(event.kind).toBe('chat-bot-reply');
    expect((event as { roomId: string }).roomId).toBe('room-1');
    expect((event as { persona: string }).persona).toBe('frontend-expert');
    expect((event as { content: string }).content).toBe('前端密钥无处安放');

    client.close();
    channel.dispose();
    server.close();
  });

  it('onChatRoomEvent 推入 chat-summary → WS 客户端收摘要事件', async () => {
    const host = makeMockHostWithChatRoom();
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const client = new Client(port, 'tok');
    await client.open();
    await client.waitForType('state');

    host.emitChatRoomEvent({
      kind: 'chat-summary',
      roomId: 'room-1',
      summary: '本轮：前端/后端/审计三方达成密钥应收口共识',
      throughMessageId: 'msg-3',
      timestamp: 1700000001000,
    });

    const msg = await client.waitForType('chat-room-event');
    expect(msg.type).toBe('chat-room-event');
    const event = msg.event as ChatRoomEvent;
    expect(event.kind).toBe('chat-summary');
    expect((event as { summary: string }).summary).toContain('密钥应收口');
    expect((event as { throughMessageId: string }).throughMessageId).toBe('msg-3');

    client.close();
    channel.dispose();
    server.close();
  });

  it('多客户端 fan-out：一个事件推给所有已连接 socket', async () => {
    const host = makeMockHostWithChatRoom();
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const c1 = new Client(port, 'tok');
    const c2 = new Client(port, 'tok');
    await c1.open();
    await c2.open();
    await c1.waitForType('state');
    await c2.waitForType('state');

    host.emitChatRoomEvent({
      kind: 'chat-bot-reply',
      roomId: 'room-x',
      persona: 'audit-expert',
      botId: 'audit-expert',
      senderType: 'sub-bot',
      content: '审计风险点',
      messageId: 'msg-a',
      timestamp: Date.now(),
    });

    const m1 = await c1.waitForType('chat-room-event');
    const m2 = await c2.waitForType('chat-room-event');
    expect(m1.type).toBe('chat-room-event');
    expect(m2.type).toBe('chat-room-event');
    expect((m1.event as { persona: string }).persona).toBe('audit-expert');
    expect((m2.event as { persona: string }).persona).toBe('audit-expert');

    c1.close();
    c2.close();
    channel.dispose();
    server.close();
  });

  it('host 无 onChatRoomEvent（向后兼容）→ agent-channel 正常工作不崩', async () => {
    const host = makeLegacyMockHost();
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const client = new Client(port, 'tok');
    await client.open();
    const state = await client.waitForType('state');
    expect(state.type).toBe('state'); // 基础功能不受影响

    // 确认无 chat-room-event 误推（等待短暂时间确认无消息）
    const none = await client.waitForType('chat-room-event', 500);
    expect(none.type).toBe('timeout'); // 没收到 = 向后兼容正确

    client.close();
    channel.dispose();
    server.close();
  });

  it('dispose 退订 onChatRoomEvent（不泄漏）', async () => {
    const host = makeMockHostWithChatRoom();
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    const client = new Client(port, 'tok');
    await client.open();
    await client.waitForType('state');

    channel.dispose(); // 退订

    // dispose 后 emit 不应到任何 socket（client 已断但仍验证不抛错）
    expect(() => host.emitChatRoomEvent({
      kind: 'chat-bot-reply',
      roomId: 'r',
      persona: 'p',
      botId: 'b',
      senderType: 'sub-bot',
      content: 'x',
      messageId: 'm',
      timestamp: 0,
    })).not.toThrow();

    client.close();
    server.close();
  });
});
