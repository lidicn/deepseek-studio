/**
 * QD-R20 复现件 · 事件总线路由与串话/残留
 *
 * 真用：createAgentLoop、createTaskLoop、createMessageHistory、createAgentChannel（真 http+ws）、
 *      createModelSummarizer（聊天室摘要器真身）、applyLoopEvent/createInitialState/canSend/canStop（面板真 reducer）。
 * 假用：ModelEngine（只决定回复文本与到达时刻）、BotRegistry 外壳（按 desktop-host.ts:792-801 的
 *      agentListeners + per-callback try/catch 逐字复刻）、agentSender 外层包装（desktop-host.ts:886-911
 *      未导出，listener 与 return 表达式按原文复刻）。
 * 面（08:58:11 现读，复制树 == 实时盘逐字节一致）：
 *   workbench-state=db7ab372(≠HEAD d8b1c80) / agent-panel=248d0b3a(≠HEAD 949ae142)
 *   agent-channel=4bf0a7ba(≠HEAD 5175c861) / agent-loop=57f5dfa9(≠HEAD f2d8cafb)
 *   studio-chat-room=402dd1a0(==HEAD blob LF c174b4d2) / chat-room-runtime=faf7405a(==HEAD 6513e461)
 *   desktop-host=b20ab026(≠HEAD adf1806e) / HEAD=dcedede
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { createAgentLoop, AGENT_SENTINEL, type AgentLoopEvent } from '../../src/host/agent-loop';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createAgentChannel, type AgentChannelHost, type BotHandle } from '../../src/host/agent-channel';
import { createModelSummarizer } from '../../src/host/bot/chat-room-runtime';
import {
  applyLoopEvent,
  canSend,
  canStop,
  createInitialState,
  type WorkbenchState,
} from '../../src/ui/workbench/workbench-state';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';
import type { AgentEventType } from '../../src/shared/agent-loop-event';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stubEngine(text: string, delayMs = 0, toolCalls = 0): ModelEngine {
  return {
    name: 'web',
    health: () => Promise.resolve({ ok: true }),
    send: async (): Promise<EngineSendResult> => {
      if (delayMs > 0) await sleep(delayMs);
      return { content: text, toolCalls };
    },
  };
}

/** 复刻 desktop-host.ts:777 + :792-801 的总线：全局 Set + 逐回调 try/catch。 */
function makeBus() {
  const listeners = new Set<(e: AgentLoopEvent) => void>();
  return {
    emit(event: AgentLoopEvent): void {
      for (const cb of listeners) {
        try {
          cb(event);
        } catch {
          // 观察者异常不得中断智能体循环（原文注释）
        }
      }
    },
    onAgentEvent: (cb: (e: AgentLoopEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    size: () => listeners.size,
  };
}

function makeLoop(botId: string, engine: ModelEngine, onEvent: (e: AgentLoopEvent) => void) {
  return createAgentLoop({
    engine,
    onEvent,
    botId,
    stopFlag: { stopped: false },
    throttleBetweenSteps: false,
  });
}

/** 面板真 reducer 的「自己这一轮正在跑」起点：连接期 state 带 running=true（R9-01 唯一真值来源）。 */
function runningConnectedState(): WorkbenchState {
  const s = createInitialState();
  return { ...s, connection: 'connected', desktopPageConnected: true, running: true };
}

class Client {
  ws: WebSocket;
  messages: Record<string, unknown>[] = [];
  private opened: Promise<void>;

  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/agent-ws?token=${token}`);
    this.opened = new Promise((resolve) => {
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
    return this.opened;
  }

  /** 等某类型消息首次出现（不改全局 include，只在本件内轮询）。 */
  async waitForType(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find((m) => m.type === type);
      if (found) return found;
      if (Date.now() > deadline) return { type: 'timeout' };
      await sleep(20);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

describe('QD-R20 正控（尺子会响）', () => {
  it('C1：带 roomId 的 send ⇒ 每条事件都带 botId+roomId（消费端有字段可过滤）', async () => {
    const seen: AgentLoopEvent[] = [];
    const loop = makeLoop('analyst', stubEngine('甲房回复'), (e) => seen.push(e));
    await loop.send(`${AGENT_SENTINEL}甲房的提示词`, { roomId: 'room-A' });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((e) => e.roomId === 'room-A')).toBe(true);
    expect(seen.every((e) => e.botId === 'analyst')).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[C1] 事件数=${seen.length} 类型=${seen.map((e) => e.type).join(',')} 全部带 roomId=room-A`);
  });

  it('C2：日常对话 send（不带 opts）⇒ roomId 恒为 undefined', async () => {
    const seen: AgentLoopEvent[] = [];
    const loop = makeLoop('main', stubEngine('日常回复'), (e) => seen.push(e));
    await loop.send(`${AGENT_SENTINEL}普通提问`);
    expect(seen.every((e) => e.botId === 'main')).toBe(true);
    expect(seen.every((e) => e.roomId === undefined)).toBe(true);
    console.log(`[C2] 事件数=${seen.length} roomId=${Array.from(new Set(seen.map((e) => String(e.roomId)))).join()}`);
  });

  it('C3：真 reducer 收「本方」done ⇒ running 归位 false（同回合收尾是对的）', () => {
    let s = runningConnectedState();
    s = applyLoopEvent(s, { type: 'done', botId: 'main' });
    expect(s.running).toBe(false);
    expect(canStop(s)).toBe(false);
    console.log(`[C3] 本方 done 后 running=${s.running} canSend=${canSend(s)}`);
  });

  it('C4：真 channel 会把 bus 事件投给已连接 socket（证明投递机制本身在跑）', async () => {
    const bus = makeBus();
    const host = makeChannelHost(bus);
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;
    const client = new Client(port, 'tok');
    await client.open();
    await client.waitForType('state');

    bus.emit({ type: 'assistant', text: '本方回复', botId: 'main' });
    const msg = await client.waitForType('event');
    expect(msg.type).toBe('event');
    expect((msg.event as AgentLoopEvent).botId).toBe('main');
    console.log(`[C4] 投递到 socket 的事件=${JSON.stringify(msg.event)}`);

    client.close();
    channel.dispose();
    server.close();
  });
});

/** 复刻 desktop-host.ts:1462-1501 的 AgentChannelHost 形状（bots/onAgentEvent/policy 面）。 */
function makeChannelHost(bus: ReturnType<typeof makeBus>, opts?: { sendMessage?: (t: string) => Promise<void> }): AgentChannelHost {
  let mainRunning = false;
  const handle: BotHandle = {
    sendMessage: (t: string) => {
      mainRunning = true;
      return (opts?.sendMessage ?? (async () => { await sleep(200); mainRunning = false; }))(t)
        .finally(() => { mainRunning = false; });
    },
    stop: () => {},
    get running() {
      return mainRunning;
    },
    health: () => Promise.resolve({ ok: true }),
  };
  return {
    bots: {
      get: () => handle,
      list: () => [{ botId: 'main', running: mainRunning }],
    },
    onAgentEvent: bus.onAgentEvent,
    get policyMode() {
      return 'auto' as never;
    },
    setPolicyMode: () => {},
    get workspaceRoot() {
      return null;
    },
    setWorkspaceRoot: () => ({ ok: true }),
    pickFolder: () => Promise.resolve(null),
    desktopPageConnected: () => true,
  };
}

describe('QD-R20-A 面板 reducer 不辨事件来源（别房终态开自己家的闸门）', () => {
  it('REPRO-A：副 bot 的 done/error 把面板 running 置假、lastError 写成别房文案', () => {
    // 场景：用户在远程面板发起 main 的一轮，连接期 state 带 running=true（R9-01 认定的唯一真值来源）。
    // 期间聊天室里的 analyst 结束自己那一轮（botId=analyst、roomId=room-B）。
    let s = runningConnectedState();
    s = applyLoopEvent(s, { type: 'done', botId: 'analyst', roomId: 'room-B' });
    expect.soft(s.running, '本方回合未结束，running 不应由别房 done 抹平').toBe(true);
    expect.soft(canStop(s), '停止入口不应由别房终态消失').toBe(true);
    expect.soft(canSend(s), '发送闸门不应被别房终态打开').toBe(false);

    let e = runningConnectedState();
    e = applyLoopEvent(e, { type: 'error', botId: 'analyst', roomId: 'room-B', text: 'analyst：本轮未取得模型回复' });
    expect.soft(e.lastError, 'lastError 不应写别房副 bot 的错误').not.toContain('analyst');
    expect(e.running, '别房 error 同样抹平本方 running').toBe(true);
    console.log(`[REPRO-A] 别房 done 后 running=${s.running} canSend=${canSend(s)} canStop=${canStop(s)}`);
    console.log(`[REPRO-A] 别房 error 后 lastError=${JSON.stringify(e.lastError)} running=${e.running}`);
    console.log(`[REPRO-A] reducer 用到的判别字段：botId/roomId 在 applyLoopEvent 内被读取次数=0（见 §证据）`);
  });

  it('REPRO-A2：别房 user 事件也会被当成「本轮开始」（R9-01 建议的置真腿若不辨来源即锁死面板）', () => {
    // 这条不改动生产语义，只测「若按 R9-01 建议在同一 reducer 里给 user/status 置真」的可乘性：
    // reducer 现在读的是 event.type，不读 event.botId —— 同一形状判别即成立。
    const foreign: AgentLoopEvent = { type: 'user', text: '内部 persona 提示词', botId: 'analyst', roomId: 'room-B' };
    const probe: (ev: AgentLoopEvent) => boolean = (ev) => ev.type === 'user' || ev.type === 'status';
    expect(probe(foreign)).toBe(true);
    // 真 reducer 当前对 user/status 不动 running，因此本轮的可见后果只在 done/error 两型（REPRO-A）。
    const s = applyLoopEvent(runningConnectedState(), foreign);
    expect(s.running).toBe(true);
    console.log(`[REPRO-A2] user/status 判别仅看 type：foreign user 事件通过=${probe(foreign)}（当前 running 不变）`);
  });
});

describe('QD-R20-B 宿主广播 → 面板 socket → 真 reducer 全链', () => {
  it('REPRO-B：聊天室副 bot 的一整轮事件原样送达面板 socket，并被真 reducer 消费', async () => {
    const bus = makeBus();
    const host = makeChannelHost(bus);
    const server = createServer();
    const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;

    // 面板客户端：真 reducer 逐条消费收到的 {type:'event'}
    const client = new Client(port, 'tok');
    await client.open();
    await client.waitForType('state');
    let panel = { ...createInitialState(), connection: 'connected' as const, desktopPageConnected: true, running: true };
    const received: AgentLoopEvent[] = [];

    // 聊天室里 analyst 跑自己的一轮（带 roomId），与面板用户完全无关
    const roomLoop = makeLoop('analyst', stubEngine('甲房的模型回复', 120), (e) => bus.emit(e));
    const sendP = roomLoop.send(`${AGENT_SENTINEL}甲房内部提示词（含其他成员发言）`, { roomId: 'room-B' });

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      for (const m of client.messages.splice(0)) {
        if (m.type !== 'event') continue;
        const ev = m.event as AgentLoopEvent;
        received.push(ev);
        panel = applyLoopEvent(panel, ev);
      }
      if (received.some((e) => e.type === 'done')) break;
      await sleep(20);
    }
    await sendP;

    console.log(`[REPRO-B] 面板收到事件数=${received.length} botId集合=${Array.from(new Set(received.map((e) => String(e.botId)))).join()}`);
    console.log(`[REPRO-B] 面板收到 user 文本=${JSON.stringify(received.find((e) => e.type === 'user')?.text)}`);
    console.log(`[REPRO-B] 面板收到 assistant 文本=${JSON.stringify(received.find((e) => e.type === 'assistant')?.text)}`);
    expect.soft(received.length, '面板不应收到任何别房（botId=analyst / roomId=room-B）事件').toBe(0);
    expect(panel.running, '别房 done 把面板 running 抹平').toBe(true);

    client.close();
    channel.dispose();
    server.close();
  });
});

describe('QD-R20-C 内部流量的 roomId 缺口', () => {
  it('REPRO-C：聊天室摘要器的一整轮事件不带 roomId —— 消费端无法靠 roomId 区分内部流量', async () => {
    const bus = makeBus();
    const seen: AgentLoopEvent[] = [];
    bus.onAgentEvent((e) => seen.push(e));

    // 真 createModelSummarizer：bot 的 loop 用真 AgentLoop（engine 返回摘要文本）
    const loop = makeLoop('main', stubEngine('本轮摘要：三方达成收口共识', 60), (e) => bus.emit(e));
    const registry = {
      get: () => ({ loop, persona: undefined }),
      getState: () => ({ sessionAllowlist: { addPermanent: () => {} } }),
    } as never;
    const summarizer = createModelSummarizer({
      registry,
      onAgentEvent: bus.onAgentEvent,
      summarizerBotId: 'main',
    });

    const summary = await summarizer([
      { id: 'm1', roomId: 'room-A', senderId: 'user', senderType: 'user', content: '用户：甲房的私密发言', createdAt: 1 } as never,
      { id: 'm2', roomId: 'room-A', senderId: 'analyst', senderType: 'sub-bot', content: 'analyst：甲房的回答', createdAt: 2 } as never,
    ]);
    expect(summary).toContain('收口共识');

    const roomIds = Array.from(new Set(seen.map((e) => String(e.roomId))));
    const userEvent = seen.find((e) => e.type === 'user');
    console.log(`[REPRO-C] 摘要器事件数=${seen.length} roomId 取值=[${roomIds.join()}]`);
    console.log(`[REPRO-C] user 事件里携带的房内原文=${JSON.stringify(String(userEvent?.text).slice(0, 90))}`);
    expect.soft(roomIds, '内部流量也应带所属 roomId，否则消费端无从判别').not.toContain('undefined');
    expect(seen.every((e) => e.roomId !== undefined), '摘要器事件全部无 roomId').toBe(true);
    expect(String(userEvent?.text)).toContain('甲房的私密发言');
  });

  it('REPRO-C2：面板侧对照 —— 同一 reducer 对「摘要器流量」与「日常对话流量」给出同一处置', () => {
    // 摘要器 done（botId=main、无 roomId）与日常对话 done 在 reducer 眼里完全同形
    const a = applyLoopEvent(runningConnectedState(), { type: 'done', botId: 'main' });
    const b = applyLoopEvent(runningConnectedState(), { type: 'done', botId: 'main', text: '（来自聊天室摘要器）' });
    expect(a.running === b.running && a.events.length === b.events.length).toBe(true);
    console.log(`[REPRO-C2] 两形 running=${a.running}/${b.running}，roomId 均缺省 ⇒ 消费端无从判别`);
  });
});

describe('QD-R20-D agentSender 兜底分支只能收到别人的回复', () => {
  it('REPRO-D：真 TaskLoop 全程不产 AgentLoopEvent ⇒ finalAnswer 只可能来自别的对话', async () => {
    const bus = makeBus();
    const captured: string[] = [];
    // desktop-host.ts:891-895 逐字复刻的 listener（只判 type/text，不判 botId/roomId）
    let finalAnswer = '';
    const listener = (event: AgentLoopEvent) => {
      if (event.type === 'assistant' && event.text) finalAnswer = event.text;
    };
    bus.onAgentEvent(listener);
    bus.onAgentEvent((e) => captured.push(`${e.botId}:${e.type}`));

    // 腿 1：TaskLoop（agentSender 真用的路径）跑完一整轮
    const history = createMessageHistory();
    const loop = createTaskLoop({ engine: stubEngine('TaskLoop 的正文', 30), history, maxRounds: 2 });
    const r1 = await loop.run(`${AGENT_SENTINEL}普通任务`);
    console.log(`[REPRO-D1] TaskLoop content=${JSON.stringify(r1.content)} 期间总线事件=[${captured.join()}]`);
    expect.soft(captured.length, 'TaskLoop 路径不产任何 AgentLoopEvent').toBe(0);
    expect(finalAnswer).toBe('');

    // 腿 2：并发进行房里的 analyst 回合 —— 兜底文本正是从它那里来的
    captured.length = 0;
    const roomLoop = makeLoop('analyst', stubEngine('【另一房间】analyst 的回复', 80), (e) => bus.emit(e));
    const taskLoop = createTaskLoop({ engine: stubEngine('', 20), history: createMessageHistory(), maxRounds: 1 });
    const [roomP, taskResult] = [roomLoop.send('另一房的提示词', { roomId: 'room-B' }), taskLoop.run('普通任务')];
    await roomP;
    const r2 = await taskResult;
    const returned = r2.content || finalAnswer; // desktop-host.ts:907 原表达式
    console.log(`[REPRO-D2] TaskLoop content="" 期间总线事件=[${captured.join()}]`);
    console.log(`[REPRO-D2] agentSender 实际返回=${JSON.stringify(returned)}（兜底值来源 botId=analyst/roomId=room-B）`);
    expect.soft(r2.content, '本轮内容为空').toBe('');
    expect.soft(returned, '兜底文本不得取自其他对话').not.toContain('另一房间');
    expect(returned, '本轮无正文时应回明确错误，而不是他房文本').toBe('');
  });

  it('REPRO-D3：类型面自检 —— 复刻 listener 未读取的任何字段确实存在于事件上', () => {
    const e: AgentLoopEvent = { type: 'assistant' as AgentEventType, text: 'x', botId: 'analyst', roomId: 'room-B' };
    expect(e.botId).toBe('analyst');
    expect(e.roomId).toBe('room-B');
  });
});

describe('QD-R20-E 曾怀疑：同一 botId 跨房串回复（待证伪）', () => {
  it('REFUTED-E：同 loop 的 active 闸门使并发两轮不可能 ⇒ 宿主侧 botId 过滤已足够', async () => {
    const bus = makeBus();
    const loop = makeLoop('analyst', stubEngine('甲房回复较慢', 200), (e) => bus.emit(e));
    const first = loop.send('甲房提示词', { roomId: 'room-A' });
    await sleep(30);
    const t0 = Date.now();
    let secondError = '';
    try {
      await loop.send('乙房提示词', { roomId: 'room-B' });
    } catch (err) {
      secondError = err instanceof Error ? err.message : String(err);
    }
    const dt = Date.now() - t0;
    await first;
    console.log(`[REFUTED-E] secondError=${JSON.stringify(secondError)} 第二次耗时=${dt}ms`);
    expect(secondError).toBe('agent-busy');
    expect(dt).toBeLessThan(50);
  });
});
