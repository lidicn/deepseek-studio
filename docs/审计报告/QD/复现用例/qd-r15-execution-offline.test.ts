/**
 * QD-R15 复现件 · 执行记录落盘链在「宿主断线窗口」上的行为
 *
 * 真源：src/desktop/host-client.ts（b8f23ba1）+ src/ui/studio-execution-store.ts（d5e16984）
 *      + src/desktop/entry.ts:162-171 的装配形状（store.kv 直接指向 host.kvGet/kvSet/kvRemove）。
 * 假物：只有 WebSocket 与宿主侧 KV 的存储是假的；协议消息、超时、pending、cache、索引全部走真码。
 */
import { describe, expect, it } from 'vitest';
import { createHostClient, type HostClient, type WebSocketLike } from '../../src/desktop/host-client';
import {
  STUDIO_EXECUTION_INDEX_KEY,
  STUDIO_EXECUTION_VERSION,
  studioExecutionStorageKey,
  type StudioExecutionEvent,
  type StudioExecutionSession,
} from '../../src/shared/studio-execution';
import { createStudioExecutionStore, type StudioExecutionKv } from '../../src/ui/studio-execution-store';

type Rec = Record<string, unknown>;

class FakeHost {
  readonly map = new Map<string, unknown>();
  readonly received: Rec[] = [];
  readonly sockets: FakeSocket[] = [];

  handle(sock: FakeSocket, msg: Rec): void {
    this.received.push(msg);
    const requestId = msg.requestId as string;
    if (msg.type === 'kv-get') {
      this.push(sock, { type: 'kv-result', requestId, ok: true, value: this.map.get(String(msg.key)) ?? null });
    } else if (msg.type === 'kv-set') {
      this.map.set(String(msg.key), msg.value);
      this.push(sock, { type: 'kv-result', requestId, ok: true });
    } else if (msg.type === 'kv-remove') {
      this.map.delete(String(msg.key));
      this.push(sock, { type: 'kv-result', requestId, ok: true });
    }
  }

  private push(sock: FakeSocket, msg: Rec): void {
    setTimeout(() => sock.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }

  /** 该会话当前真正落在「宿主磁盘」上的事件。 */
  diskEvents(key: string): StudioExecutionEvent[] {
    const raw = this.map.get(studioExecutionStorageKey(key)) as StudioExecutionSession | undefined;
    return raw?.events ?? [];
  }

  texts(key: string): string[] {
    return this.diskEvents(key)
      .map((e) => (('text' in e ? e.text : 'toolName' in e ? e.toolName : '')))
      .filter(Boolean);
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(private readonly host: FakeHost, readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send on closed socket');
    this.host.handle(this, JSON.parse(data) as Rec);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

const SESSION_KEY = 'chat:qd-r15';

function makeClient(host: FakeHost): HostClient {
  return createHostClient({
    url: 'ws://127.0.0.1:8760/studio',
    capabilities: [],
    origin: 'https://chat.deepseek.com',
    wsFactory: (url) => {
      const sock = new FakeSocket(host, url);
      host.sockets.push(sock);
      return sock;
    },
  });
}

/** 打开最近一条假 socket（模拟 ws 握手完成 → host-client 会发 hello）。 */
function bringUp(host: FakeHost): void {
  host.sockets[host.sockets.length - 1]?.open();
}

function userEvent(text: string, turnId: string): StudioExecutionEvent {
  return { type: 'user-message', at: Date.now(), turnId, text };
}

function seedDisk(host: FakeHost, events: StudioExecutionEvent[]): void {
  const session: StudioExecutionSession = {
    version: STUDIO_EXECUTION_VERSION,
    key: SESSION_KEY,
    createdAt: Date.now() - 5000,
    updatedAt: Date.now() - 1000,
    events,
  };
  host.map.set(studioExecutionStorageKey(SESSION_KEY), session);
  host.map.set(STUDIO_EXECUTION_INDEX_KEY, {
    version: STUDIO_EXECUTION_VERSION,
    sessions: [{ key: SESSION_KEY, updatedAt: session.updatedAt, title: 'qd-r15' }],
  });
}

function makeStore(client: HostClient, errors: string[]) {
  const kv: StudioExecutionKv = {
    kvGet: (key) => client.kvGet(key),
    kvSet: (key, value) => client.kvSet(key, value),
    kvRemove: (key) => client.kvRemove(key),
  };
  return createStudioExecutionStore({
    kv,
    onConnected: (cb) => client.onConnected(cb),
    isConnected: () => client.connected,
    reportError: (message) => errors.push(message),
  });
}

describe('QD-R15 · 执行记录落盘链 × 宿主断线窗口', () => {
  it('CONTROL：全程在线时，loadSession 读到磁盘真相且 saveEvent 真的落盘', async () => {
    const host = new FakeHost();
    const client = makeClient(host);
    client.connect();
    bringUp(host);
    seedDisk(host, [
      userEvent('第一轮提问', 't1'),
      userEvent('第二轮提问', 't2'),
      userEvent('第三轮提问', 't3'),
    ]);

    const loaded = await makeStore(client, []).loadSession(SESSION_KEY);
    expect.soft(loaded?.events.map((e) => (e as { text: string }).text)).toEqual([
      '第一轮提问',
      '第二轮提问',
      '第三轮提问',
    ]);

    await makeStore(client, []).saveEvent(SESSION_KEY, userEvent('第四轮提问', 't4'));
    // 在线面：这条腿**应当**是绿的，用来证明假宿主与真 store 的通道本身会响。
    expect.soft(host.texts(SESSION_KEY)).toContain('第四轮提问');
    expect(host.diskEvents(SESSION_KEY).length).toBe(4);
  });

  it('EVIDENCE-0：未连接时 host-client 的 kvGet 回 undefined、kvSet 直接 resolve 且一个字节都不发', async () => {
    const host = new FakeHost();
    const client = makeClient(host);
    // 不 connect：client.connected === false，走 host-client.ts:387 / :399 的「未连接短路」
    expect(client.connected).toBe(false);
    const before = host.received.length;

    const got = await client.kvGet(studioExecutionStorageKey(SESSION_KEY));
    await client.kvSet(studioExecutionStorageKey(SESSION_KEY), { version: 2, key: SESSION_KEY, events: [] });

    // 这两条断言的是**现状**（不是期望行为），用来钉住后续复现腿的机制：
    // 断线读 = 「没有这个会话」；断线写 = 「成功但什么都没发生」。
    expect(got).toBeUndefined();
    expect(host.received.length).toBe(before);
  });

  it('REPRO-A：断线窗口里的一次写入 ⇒ 空会话投毒 cache ⇒ 重连后不刷新 ⇒ 下一次写入把真历史覆盖掉', async () => {
    const host = new FakeHost();
    const client = makeClient(host);
    const errors: string[] = [];

    // 1) 先正常连上、把「已有三轮历史」的会话读进 cache，然后宿主断线（桌面端重启 / WS 掉线）
    client.connect();
    bringUp(host);
    seedDisk(host, [
      userEvent('第一轮提问', 't1'),
      userEvent('第二轮提问', 't2'),
      userEvent('第三轮提问', 't3'),
    ]);
    const store = makeStore(client, errors);
    await store.loadSession(SESSION_KEY);
    client.disconnect();
    expect(client.connected).toBe(false);

    // 2) 断线期间产生一次事件写入（页端仍在跑，recordEvent 照常调）
    const afterOfflineSave = await store.saveEvent(SESSION_KEY, userEvent('断线期间的第四轮', 't4'));
    console.log(
      `[REPRO-A] 断线 saveEvent 返回事件数=${afterOfflineSave.events.length} `
      + `磁盘事件数=${host.diskEvents(SESSION_KEY).length} reportError 次数=${errors.length}`,
    );
    // 期望①：断线写不得静默成功——至少要有错误上报
    expect.soft(errors.length, '断线期间的落盘失败没有任何 reportError').toBeGreaterThan(0);
    // 期望②：这一条事件最终要落到磁盘（重连后补齐），⛔ 永久消失
    expect.soft(host.diskEvents(SESSION_KEY).map((e) => (e as { text: string }).text))
      .toContain('断线期间的第四轮');

    // 3) 重连：entry.ts:182-184 的 onConnected → activateSession 会重新 loadSession，
    //    但 store 的 cache 从不因重连失效 ⇒ 读回来的仍是断线期间造出来的那份
    client.connect();
    bringUp(host);
    const afterReconnect = await store.loadSession(SESSION_KEY);
    console.log(
      `[REPRO-A] 重连后 store=${afterReconnect?.events.length} 条 / 磁盘=${host.diskEvents(SESSION_KEY).length} 条 `
      + `socket 数=${host.sockets.length}`,
    );
    expect.soft(afterReconnect?.events.length, '重连后 store 应回到磁盘真相（≥3 条历史）')
      .toBeGreaterThanOrEqual(3);

    // 4) 重连后的下一次写入 ⇒ 用被投毒的 cache 覆盖磁盘，真历史整段消失
    await store.saveEvent(SESSION_KEY, userEvent('第五轮提问', 't5'));
    console.log(`[REPRO-A] 覆盖后磁盘内容=${JSON.stringify(host.texts(SESSION_KEY))}`);
    expect.soft(host.texts(SESSION_KEY)).toContain('第一轮提问');
    expect.soft(host.texts(SESSION_KEY)).toContain('第三轮提问');
  });

  it('REPRO-B：首次读取就落在断线窗口（宿主还没起来就挂载覆盖层）⇒ 该会话从这一刻起与磁盘永久分叉', async () => {
    const host = new FakeHost();
    const client = makeClient(host);
    const errors: string[] = [];
    // 覆盖层先挂载，socket 尚未打开（entry.ts 的时序：createHostClient → connect 是异步的）
    client.connect();
    seedDisk(host, [
      userEvent('旧页面上的第一轮', 't1'),
      userEvent('旧页面上的第二轮', 't2'),
    ]);
    const store = makeStore(client, errors);

    const saved = await store.saveEvent(SESSION_KEY, userEvent('新写的一轮', 'n1'));
    console.log(
      `[REPRO-B] 未打开 socket 时 saveEvent 返回=${saved.events.length} 条，`
      + `磁盘=${host.diskEvents(SESSION_KEY).length} 条，reportError=${errors.length}`,
    );

    bringUp(host);
    const later = await store.loadSession(SESSION_KEY);
    console.log(`[REPRO-B] socket 打开后 store=${later?.events.length} 条 / 磁盘=${host.diskEvents(SESSION_KEY).length} 条`);
    // 期望：磁盘真相（2 条）不该被一份「读不到就当作空会话」的内存副本取代
    expect.soft((later?.events.length ?? 0), 'store 应至少带回磁盘上已有的 2 条').toBeGreaterThanOrEqual(2);
    await store.saveEvent(SESSION_KEY, userEvent('再写一轮', 'n2'));
    console.log(`[REPRO-B] 再次落盘后磁盘内容=${JSON.stringify(host.texts(SESSION_KEY))}`);
    expect.soft(host.texts(SESSION_KEY)).toContain('旧页面上的第一轮');
  });
});
