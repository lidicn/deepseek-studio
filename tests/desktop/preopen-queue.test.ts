// @vitest-environment node
/**
 * 卡⑪（2026-11-16）：**预 OPEN 有界队列**回归。
 *
 * 缺陷现场（UI 探针取证 + PM 读码实锤）：`send()` 在 socket 非 OPEN 时**直接丢弃、无队列无痕迹**。
 * 于是页面装好、socket 还在 CONNECTING 的那段时间里，`[auth] boot-check` 这类诊断行、
 * `trace` 断流取证、`integrity-alert` 安全告警**全部消失**——「掉登录那一刻发生了什么」
 * 在宿主机上永远看不到（`responses/logs 稳定后 auth hits=0` 就是这个形状）。
 *
 * 本文件锁五件事：
 *   ① 未 OPEN 期间发的 `log`/`trace` 在 OPEN 后**按原序**补齐，一条不多不少；
 *   ② 超上限（256）⇒ 留满 256 条 + **显式** `[transport] preopen queue overflow N`（不许静默吞）；
 *   ③ 不入队类型（`stream-delta`/`assistant-reply`/`finish-sentinel`/`tool-call`/`kv-*`）在未 OPEN 时
 *      行为与改前**逐字相同**（fail-fast，不排队）；
 *   ④ 二次 open 不重放同一批；
 *   ⑤ 端到端：未 OPEN 即安装 ⇒ `[auth] boot-check` 最终**恰一行**（不多不少）。
 *
 * 负控（见交卷）：摘掉队列 ⇒ ①②⑤ 必红；字节备份 + SHA256 逐字节还原。
 */
import { describe, it, expect } from 'vitest';
import {
  createHostClient,
  type WebSocketLike,
  type WebSocketFactory,
} from '../../src/desktop/host-client';

class FakeSocket implements WebSocketLike {
  /** 0 = CONNECTING（真实页面刚装好就是这态，缺陷就发生在这里）。 */
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  /** 模拟握手完成（会跑 onopen：hello + 队列 flush 都在这里）。 */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

interface Parsed {
  type?: string;
  text?: string;
  line?: string;
  [k: string]: unknown;
}

function makeClient(): { client: ReturnType<typeof createHostClient>; socket: () => FakeSocket } {
  let sock: FakeSocket | null = null;
  const factory: WebSocketFactory = () => {
    sock = new FakeSocket();
    return sock;
  };
  const client = createHostClient({
    url: 'ws://127.0.0.1:0/studio',
    capabilities: [],
    wsFactory: factory,
  });
  client.connect();
  if (!sock) throw new Error('socket not created');
  return { client, socket: () => sock as FakeSocket };
}

function parsed(sock: FakeSocket): Parsed[] {
  return sock.sent.map((s) => JSON.parse(s) as Parsed);
}

describe('卡⑪ 预 OPEN 有界队列', () => {
  it('① 未 OPEN 发 3 条 log ⇒ OPEN 后到 3 条、序不变、hello 在最前', () => {
    const { client, socket } = makeClient();
    client.log('first');
    client.log('second');
    client.trace('{"third":true}');
    // 未 OPEN：一条都不许直接发（也不许静默丢掉——下面 open 后必须全在）
    expect(socket().sent).toHaveLength(0);

    socket().open();
    const msgs = parsed(socket());
    expect(msgs[0]?.type).toBe('hello');
    const tail = msgs.slice(1);
    expect(tail).toHaveLength(3);
    expect(tail[0]).toMatchObject({ type: 'log', text: 'first' });
    expect(tail[1]).toMatchObject({ type: 'log', text: 'second' });
    expect(tail[2]).toMatchObject({ type: 'trace', line: '{"third":true}' });
  });

  it('② 超上限 256 ⇒ 留满 256 条 ＋ 显式 overflow 行（丢最新的那 44 条）', () => {
    const { client, socket } = makeClient();
    for (let i = 0; i < 300; i += 1) client.log(`l${i}`);

    socket().open();
    const tail = parsed(socket()).slice(1);
    const logs = tail.filter((m) => m.type === 'log' && typeof m.text === 'string' && m.text.startsWith('l'));
    expect(logs).toHaveLength(256);
    // FIFO：留下的是最早的 256 条，顺序不变
    expect(logs[0]?.text).toBe('l0');
    expect(logs[255]?.text).toBe('l255');
    // 溢出不许静默：末尾补一行可读提示，N 是被丢掉的最新条数
    expect(tail[tail.length - 1]).toMatchObject({
      type: 'log',
      text: '[transport] preopen queue overflow 44',
    });
  });

  it('③ 不入队类型未 OPEN 时与改前逐字相同（fail-fast，不排队、不补发；卡⑫ 起允许一条 dropped log）', async () => {
    const { client, socket } = makeClient();
    client.streamDelta('delta');
    client.assistantReply('reply', 1);
    client.finishSentinel(2, true);
    // kvGet 未 OPEN：立即 resolve(undefined)——这是既有语义，本卡不许改
    await expect(client.kvGet('k')).resolves.toBeUndefined();
    // sendToolCall 未 OPEN：仍然先挂 pending 再被丢弃（等超时/断线结算），不进队列
    const toolPending = client.sendToolCall({ callId: 'c1', invocationName: 'echo', params: {} });

    socket().open();
    const tail = parsed(socket()).slice(1);
    const banned = ['stream-delta', 'assistant-reply', 'finish-sentinel', 'tool-call', 'kv-get'];
    // 卡⑫ 口径（PM 2026-11-16 批准）：三型本体仍不得出现，但**允许恰好一条** dropped `log`。
    expect(tail.filter((m) => typeof m.type === 'string' && banned.includes(m.type))).toEqual([]);
    const dropLines = tail.filter((m) => typeof m.text === 'string' && m.text.startsWith('[transport] preopen dropped'));
    expect(dropLines).toHaveLength(1);
    // 断开让那枚 tool-call 立刻结算，避免挂到 30s 超时
    socket().close();
    await expect(toolPending).resolves.toMatchObject({ ok: false });
  });

  it('④ 二次 open 不重放同一批', () => {
    const { client, socket } = makeClient();
    client.log('once');
    socket().open();
    expect(parsed(socket()).filter((m) => m.text === 'once')).toHaveLength(1);

    socket().open(); // 第二次 onopen（重连/重复触发）
    expect(parsed(socket()).filter((m) => m.text === 'once')).toHaveLength(1);
    // 第二次 open 只多一条自己的 hello，没有别的重放
    expect(parsed(socket()).filter((m) => m.type === 'hello')).toHaveLength(2);
  });

  it('⑤ 端到端：未 OPEN 即安装 ⇒ `[auth] boot-check` 最终恰一行', () => {
    const { client, socket } = makeClient();
    // 注入层装好就调一次（此时 socket 仍在 CONNECTING）——这正是真机丢行的那一刻
    client.trace('{"t":"trace","line":"[auth] boot-check user=存在 cookie_count=8 did=abc"}');
    socket().open();
    const hits = parsed(socket()).filter(
      (m) => (typeof m.text === 'string' && m.text.startsWith('[auth] boot-check'))
        || (typeof m.line === 'string' && m.line.includes('[auth] boot-check')),
    );
    expect(hits).toHaveLength(1);
  });

  it('安全告警（integrity-alert）同样不许丢：未 OPEN 也入队', () => {
    const { client, socket } = makeClient();
    client.reportIntegrity({ reason: 'host-object-tampered', detail: 'detail' });
    socket().open();
    expect(parsed(socket()).filter((m) => m.type === 'integrity-alert')).toHaveLength(1);
  });

  it('integrity-alert 迟到重放：**重连后不重放旧告警**（已恢复的页不会被再判篡改），新告警仍即时生效', async () => {
    const { client, socket } = makeClient();
    client.reportIntegrity({ reason: 'host-object-tampered' });
    client.log('boot');

    const first = socket();
    first.open();
    expect(parsed(first).filter((m) => m.type === 'integrity-alert')).toHaveLength(1);

    // 掉线：client 会走 30s 冷却外的自动重连（本测试把退避压到最小，等它建出第二条 socket）
    first.onclose?.();
    await new Promise((r) => setTimeout(r, 700));
    const second = socket();
    expect(second).not.toBe(first);
    second.open();

    // ★ 安全面判据：旧告警**不重放**——否则每次重连都把已恢复的页重新标记成篡改/降级。
    expect(parsed(second).filter((m) => m.type === 'integrity-alert')).toEqual([]);
    expect(parsed(second).filter((m) => m.text === 'boot')).toEqual([]);
    // 跨两条 socket 合计仍只有一枚告警：不重复、不遗漏
    expect([...parsed(first), ...parsed(second)].filter((m) => m.type === 'integrity-alert')).toHaveLength(1);

    // 但**新发生**的篡改告警在重连后照旧发得出去（不能因为"不重放"而对新告警失聪）
    client.reportIntegrity({ reason: 'host-object-tampered-again' });
    expect(parsed(second).filter((m) => m.type === 'integrity-alert')).toHaveLength(1);
  });
});

/**
 * 卡⑫（2026-11-16）：续跑三型在预 OPEN 窗口**仍不投递**，但丢弃必须**可数、按型分列**。
 * 这组是"取证面"的牙：没有它，三型丢了就是静默丢失（宿主只能靠超时兜底、断流被当答完）。
 */
describe('卡⑫ 预 OPEN 丢弃计数（按型分列、不跨连接、正常路径零噪音）', () => {
  const DROP_PREFIX = '[transport] preopen dropped';

  function dropLines(msgs: Parsed[]): Parsed[] {
    return msgs.filter((m) => typeof m.text === 'string' && String(m.text).startsWith(DROP_PREFIX));
  }

  it('① 三型各丢若干 ⇒ OPEN 后恰一条 dropped 行，且**逐型分列**（顺序固定）', () => {
    const { client, socket } = makeClient();
    client.assistantReply('a1', 1);
    client.assistantReply('a2', 2);
    for (let i = 0; i < 3; i += 1) client.streamDelta(`d${i}`);
    client.finishSentinel(1, true);

    socket().open();
    const lines = dropLines(parsed(socket()));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe(
      '[transport] preopen dropped 2 assistant-reply / 3 stream-delta / 1 finish-sentinel (since last open)',
    );
    // 三型本体仍然一个都没投递（甲不改变投递语义）
    expect(parsed(socket()).slice(1).filter((m) => m.type !== 'log')).toEqual([]);
  });

  it('② 计数**不跨连接累计**：第二次 open 不重报上一次的数，新丢的只数新的', async () => {
    const { client, socket } = makeClient();
    client.streamDelta('d1');
    const first = socket();
    first.open();
    expect(dropLines(parsed(first))).toHaveLength(1);

    // 掉线重连（新 socket），这期间再丢一条
    first.onclose?.();
    await new Promise((r) => setTimeout(r, 700));
    const second = socket();
    expect(second).not.toBe(first);
    client.finishSentinel(2, false);
    second.open();

    const lines = dropLines(parsed(second));
    expect(lines).toHaveLength(1);
    // 只有这一次窗口的 1 条 finish-sentinel，不含上一窗的 1 stream-delta、也不是累加值
    expect(lines[0]?.text).toBe('[transport] preopen dropped 1 finish-sentinel (since last open)');
  });

  it('③ 正常路径（OPEN 期发送）⇒ 零 dropped 行（不许把噪音塞进日常日志）', () => {
    const { client, socket } = makeClient();
    socket().open(); // 先 OPEN
    client.assistantReply('a', 1);
    client.streamDelta('d');
    client.finishSentinel(1, true);
    expect(dropLines(parsed(socket()))).toEqual([]);
    // 三型本体照常直发
    expect(parsed(socket()).filter((m) => m.type === 'stream-delta')).toHaveLength(1);
  });

  it('④ 三型一条都没丢 ⇒ 不发 dropped 行（空窗口不许刷一行 0）', () => {
    const { client, socket } = makeClient();
    client.log('only-a-log'); // 这类会入队、不算丢弃
    socket().open();
    expect(dropLines(parsed(socket()))).toEqual([]);
  });

  it('⑤ finish-sentinel 被丢 ⇒ 宿主侧只能看到 `undefined`（不判 interrupted 的老语义不变）', () => {
    const { client, socket } = makeClient();
    client.finishSentinel(3, false); // 预 OPEN 被丢
    socket().open();
    // 没有任何 finish-sentinel 本体到宿主 ⇒ 宿主 finishSentinels 拿不到值 ⇒ m1c 的
    // 「undefined ⇒ 不判 interrupted」语义原样成立；我们只把"丢过一条"记在 dropped 行里。
    expect(parsed(socket()).filter((m) => m.type === 'finish-sentinel')).toEqual([]);
    expect(dropLines(parsed(socket()))[0]?.text).toContain('1 finish-sentinel');
  });
});
