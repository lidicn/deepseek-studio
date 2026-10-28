import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import {
  createAgentChannel,
  isAllowedAgentOrigin,
  type AgentChannelHost,
  type BotHandle,
} from '../../src/host/agent-channel';
import {
  createEmptyStudioExecutionSession,
  type StudioExecutionIndex,
  type StudioExecutionSession,
} from '../../src/shared/studio-execution';

const bot: BotHandle = {
  sendMessage: () => Promise.resolve(),
  stop: () => {},
  running: false,
  health: () => Promise.resolve({ ok: true }),
};

function makeHost() {
  let sessionCb: ((session: StudioExecutionSession) => void) | null = null;
  let indexCb: ((index: StudioExecutionIndex) => void) | null = null;
  let clearedCb: (() => void) | null = null;
  const index: StudioExecutionIndex = {
    version: 2,
    sessions: [{ key: 'chat:one', updatedAt: 100, title: '测试会话' }],
  };
  const session = createEmptyStudioExecutionSession('chat:one', 100);
  const host: AgentChannelHost & {
    emitSession(value: StudioExecutionSession): void;
    emitIndex(value: StudioExecutionIndex): void;
    emitCleared(): void;
  } = {
    bots: {
      get: () => bot,
      list: () => [{ botId: 'main', running: false }],
    },
    onAgentEvent: () => () => {},
    onExecutionSession: (cb) => {
      sessionCb = cb;
      return () => { sessionCb = null; };
    },
    onExecutionIndex: (cb) => {
      indexCb = cb;
      return () => { indexCb = null; };
    },
    onExecutionCleared: (cb) => {
      clearedCb = cb;
      return () => { clearedCb = null; };
    },
    getExecutionIndex: async () => index,
    getExecutionSession: async (key) => (key === session.key ? session : null),
    desktopPageConnected: () => true,
    policyMode: 'auto',
    setPolicyMode: () => {},
    workspaceRoot: null,
    setWorkspaceRoot: () => ({ ok: true }),
    pickFolder: async () => null,
    emitSession(value) { sessionCb?.(value); },
    emitIndex(value) { indexCb?.(value); },
    emitCleared() { clearedCb?.(); },
  };
  return { host, session, index };
}

class Client {
  readonly messages: Record<string, unknown>[] = [];
  private readonly ws: WebSocket;
  private readonly openPromise: Promise<void>;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/agent-ws?token=tok`);
    this.openPromise = new Promise((resolve) => {
      this.ws.on('open', () => resolve());
      setTimeout(resolve, 3000);
    });
    this.ws.on('message', (raw) => {
      try { this.messages.push(JSON.parse(raw.toString()) as Record<string, unknown>); } catch { /* ignore */ }
    });
  }

  open(): Promise<void> {
    return this.openPromise;
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  async waitFor(predicate: (msg: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { type: 'timeout' };
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

describe('agent-channel · 统一执行会话镜像', () => {
  it('连接后下发索引；实时广播会话、索引、清空，并可读取指定会话', async () => {
    const { host, session, index } = makeHost();
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;
    const client = new Client(port);
    await client.open();

    const initialIndex = await client.waitFor((m) => m.type === 'execution-index');
    expect((initialIndex.index as StudioExecutionIndex).sessions[0].key).toBe('chat:one');

    host.emitSession(session);
    const sessionMsg = await client.waitFor((m) => m.type === 'execution-session');
    expect((sessionMsg.session as StudioExecutionSession).key).toBe('chat:one');

    host.emitIndex(index);
    expect((await client.waitFor((m) => m.type === 'execution-index')).type).toBe('execution-index');

    client.send({ type: 'get-execution-session', key: 'chat:one', reqId: 'r1' });
    const ack = await client.waitFor((m) => m.type === 'ack' && m.reqId === 'r1');
    expect(ack.ok).toBe(true);
    expect((ack.data as { session?: StudioExecutionSession }).session?.key).toBe('chat:one');

    host.emitCleared();
    expect((await client.waitFor((m) => m.type === 'execution-cleared')).type).toBe('execution-cleared');

    client.close();
    channel.dispose();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('agent-channel · Origin 白名单', () => {
  it('localhost 永远允许', () => {
    expect(isAllowedAgentOrigin('http://127.0.0.1:8760', '127.0.0.1:8760', false)).toBe(true);
    expect(isAllowedAgentOrigin('http://localhost:8760', 'localhost:8760', false)).toBe(true);
  });

  it('LAN 未开启时拒绝局域网 Origin', () => {
    expect(isAllowedAgentOrigin('http://192.168.1.8:8760', '192.168.1.8:8760', false)).toBe(false);
  });

  it('LAN 开启时只允许与 Host 完全同源', () => {
    expect(isAllowedAgentOrigin('http://192.168.1.8:8760', '192.168.1.8:8760', true)).toBe(true);
    expect(isAllowedAgentOrigin('http://192.168.1.9:8760', '192.168.1.8:8760', true)).toBe(false);
    expect(isAllowedAgentOrigin('https://evil.example', '192.168.1.8:8760', true)).toBe(false);
  });
});
