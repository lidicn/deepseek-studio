import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import {
  STUDIO_EXECUTION_INDEX_KEY,
  isStudioExecutionSession,
  studioExecutionStorageKey,
  type StudioExecutionEvent,
  type StudioExecutionIndex,
  type StudioExecutionSession,
} from '../../src/shared/studio-execution';
import {
  createStudioExecutionStore,
  type StudioExecutionKv,
} from '../../src/ui/studio-execution-store';
import {
  createAgentChannel,
  type AgentChannelHost,
  type BotHandle,
} from '../../src/host/agent-channel';

function memoryKv(): StudioExecutionKv & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async kvGet(key) {
      return values.get(key);
    },
    async kvSet(key, value) {
      values.set(key, structuredClone(value));
    },
    async kvRemove(key) {
      values.delete(key);
    },
  };
}

function store(kv: StudioExecutionKv) {
  return createStudioExecutionStore({
    kv,
    onConnected: () => () => {},
    isConnected: () => true,
  });
}

function userEvent(text: string, at: number): StudioExecutionEvent {
  return { type: 'user-message', at, turnId: 'turn-1', text };
}

function indexKeys(kv: { values: Map<string, unknown> }): string[] {
  const index = kv.values.get(STUDIO_EXECUTION_INDEX_KEY) as StudioExecutionIndex | undefined;
  return (index?.sessions ?? []).map((entry) => entry.key);
}

const bot: BotHandle = {
  sendMessage: () => Promise.resolve(),
  stop: () => {},
  running: false,
  health: () => Promise.resolve({ ok: true }),
};

function makeHost(getExecutionIndex: () => Promise<StudioExecutionIndex | null>) {
  let indexCb: ((index: StudioExecutionIndex) => void) | null = null;
  const host: AgentChannelHost & { emitIndex(value: StudioExecutionIndex): void } = {
    bots: {
      get: () => bot,
      list: () => [{ botId: 'main', running: false }],
    },
    onAgentEvent: () => () => {},
    onExecutionIndex: (cb) => {
      indexCb = cb;
      return () => { indexCb = null; };
    },
    getExecutionIndex,
    policyMode: 'auto',
    setPolicyMode: () => {},
    workspaceRoot: null,
    setWorkspaceRoot: () => ({ ok: true }),
    pickFolder: async () => null,
    emitIndex(value) { indexCb?.(value); },
  };
  return host;
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

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function startChannel(host: AgentChannelHost) {
  const server = createServer();
  const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    async dispose() {
      channel.dispose();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('QD-R14 · 执行会话存储：rename 只删旧 blob，不删索引条目', () => {
  it('CONTROL：普通写入后索引只有该会话', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await persistence.saveEvent('chat:control', userEvent('对照会话', 1000));
    expect(indexKeys(kv)).toEqual(['chat:control']);
  });

  it('REPRO-A：route 桶迁移到 chat 键后，旧 route 条目仍留在索引里（悬空条目）', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await persistence.saveEvent('route:/chat', userEvent('临时会话正文', 1000));
    await persistence.renameSession('route:/chat', 'chat:stable');

    const keys = indexKeys(kv);
    // 期望：迁移后索引只剩 chat:stable。实际：route:/chat 条目没有被移除。
    expect.soft(keys).not.toContain('route:/chat');
    // 该条目指向的 blob 已被 renameSession 删除 ⇒ 列表可见但永远加载不到
    const oldBlob = await kv.kvGet(studioExecutionStorageKey('route:/chat'));
    expect.soft(isStudioExecutionSession(oldBlob)).toBe(true);
    // 对照：新键本身是好的（证明缺陷仅在索引簿记，不是整条迁移坏掉）
    expect((await persistence.loadSession('chat:stable'))?.events).toHaveLength(1);
    expect(await persistence.loadSession('route:/chat')).toBeNull();
  });

  it('REPRO-B：索引条目保留原会话标题 ⇒ 工作台列表出现一条重复的旧会话', async () => {
    const kv = memoryKv();
    const persistence = store(kv);
    await persistence.saveEvent('route:/chat', userEvent('重复标题-旧会话', 1000));
    await persistence.renameSession('route:/chat', 'chat:stable');

    const index = kv.values.get(STUDIO_EXECUTION_INDEX_KEY) as StudioExecutionIndex;
    const phantom = index.sessions.find((entry) => entry.key === 'route:/chat');
    expect.soft(phantom?.title).toBeUndefined();
  });
});

describe('QD-R14 · /agent-ws 执行索引快照与实时广播无版本序', () => {
  it('CONTROL：没有并发广播时，连接快照正常下发', async () => {
    const snapshot: StudioExecutionIndex = {
      version: 2,
      sessions: [{ key: 'chat:snapshot', updatedAt: 100, title: '快照' }],
    };
    const host = makeHost(async () => snapshot);
    const { port, dispose } = await startChannel(host);
    const client = new Client(port);
    await client.open();
    const msg = await client.waitFor((m) => m.type === 'execution-index');
    expect(((msg.index as StudioExecutionIndex).sessions)[0].key).toBe('chat:snapshot');
    client.close();
    await dispose();
  });

  it('REPRO-C：连接快照读得慢时，旧索引在更新的广播之后到达，客户端最终被旧值覆盖', async () => {
    let resolveSnapshot: ((value: StudioExecutionIndex | null) => void) | null = null;
    const slowSnapshot = new Promise<StudioExecutionIndex | null>((resolve) => {
      resolveSnapshot = resolve;
    });
    const host = makeHost(() => slowSnapshot);
    const { port, dispose } = await startChannel(host);
    const client = new Client(port);
    await client.open();
    await client.waitFor((m) => m.type === 'state');

    const fresh: StudioExecutionIndex = {
      version: 2,
      sessions: [{ key: 'chat:fresh', updatedAt: 2000, title: '新会话' }],
    };
    const stale: StudioExecutionIndex = {
      version: 2,
      sessions: [{ key: 'chat:old', updatedAt: 1000, title: '旧会话' }],
    };

    // 实时广播先到（宿主在执行写入时会广播索引）
    host.emitIndex(fresh);
    await client.waitFor((m) => m.type === 'execution-index');
    // 初始快照晚到：携带的是连接时刻读到的旧索引
    resolveSnapshot?.(stale);
    await new Promise((r) => setTimeout(r, 150));

    const delivered = client.messages
      .filter((m) => m.type === 'execution-index')
      .map((m) => ((m.index as StudioExecutionIndex).sessions[0]?.key ?? ''));
    // 期望：最后生效的是更新的广播（chat:fresh）；实际顺序 fresh → old
    expect.soft(delivered[delivered.length - 1]).toBe('chat:fresh');
    expect.soft(delivered).toEqual(['chat:fresh']);

    client.close();
    await dispose();
  });

  it('EVIDENCE-D：索引里存在的键，宿主按契约回 session:null（幽灵条目点击后的取材面）', async () => {
    const ghost: StudioExecutionSession | null = null;
    let resolveSession: ((value: StudioExecutionSession | null) => void) | null = null;
    const host = makeHost(async () => ({
      version: 2,
      sessions: [{ key: 'route:/chat', updatedAt: 1000, title: '重复标题-旧会话' }],
    }));
    (host as unknown as { getExecutionSession: (key: string) => Promise<StudioExecutionSession | null> }).getExecutionSession =
      () => new Promise<StudioExecutionSession | null>((resolve) => {
        resolveSession = resolve;
      });
    const { port, dispose } = await startChannel(host);
    const client = new Client(port);
    await client.open();
    await client.waitFor((m) => m.type === 'state');

    client.send({ type: 'get-execution-session', key: 'route:/chat', reqId: 'g1' });
    await wait(50);
    resolveSession?.(ghost);
    const ack = await client.waitFor((m) => m.type === 'ack' && m.reqId === 'g1');
    // 宿主侧行为合规：ok:true + session:null。缺陷在消费端（agent-panel 见下）。
    expect(ack.ok).toBe(true);
    expect((ack.data as { session?: StudioExecutionSession | null }).session).toBeNull();

    client.close();
    await dispose();
  });
});
