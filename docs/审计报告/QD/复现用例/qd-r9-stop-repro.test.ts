/**
 * QD-R9：stop / abort 全链路复现件（跑在 E:/NAS/tmp 副本树，不写被审工作树）。
 *
 * REPRO-A：宿主在 send 开始后只广播 {type:'event'}，从不广播 {type:'state'}；
 *          客户端 reducer 只在 done/error 置 running=false，从不置 true
 *          ⇒ canStop(state)=false（#btn-stop 常隐）/ canSend(state)=true（可重复点发送）。
 * CONTROL：显式 broadcastState() 能送出 running=true ⇒ 尺子本身会响，REPRO 的 0 不是假 0。
 *
 * REPRO-B：上轮（尤其被停止的回合）遗留的 lastAutoReply.fresh 在新一轮 send() 开始时
 *          不被清空，waitForNextReply() 会立即把旧轮结论当成本轮续跑结果返回。
 * CONTROL：fresh=false 时同一个 waitForNextReply() 不会返回旧文本。
 */
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import {
  createAgentChannel,
  type AgentChannelHost,
  type BotHandle,
} from '../../src/host/agent-channel';
import {
  applyLoopEvent,
  applySocketOpen,
  applyState,
  canSend,
  canStop,
  createInitialState,
  type WorkbenchState,
} from '../../src/ui/workbench/workbench-state';
import type { StatePayload } from '../../src/ui/workbench/workbench-types';
import type { AgentLoopEvent } from '../../src/shared/agent-loop-event';
import { createWebEngine } from '../../src/host/engine/web-engine';

type Msg = Record<string, unknown>;

class PanelConnection {
  ws: WebSocket;
  private queue: Msg[] = [];
  private waiters: Array<{ type: string; resolve: (m: Msg) => void }> = [];

  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/agent-ws?token=${token}`);
    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Msg;
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

  open(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.on('open', () => resolve());
      setTimeout(() => resolve(), 3000);
    });
  }

  next(type: string, timeoutMs = 1500): Promise<Msg> {
    const qi = this.queue.findIndex((m) => m.type === type);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((resolve) => {
      this.waiters.push({ type, resolve });
      setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.type === type);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          resolve({ type: 'timeout' });
        }
      }, timeoutMs);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

interface PanelFixture {
  panel: PanelConnection;
  channel: ReturnType<typeof createAgentChannel>;
  server: ReturnType<typeof createServer>;
  bot: BotHandle & { release(): void };
  emit(event: AgentLoopEvent): void;
  stopCalls: () => number;
}

async function startPanel(): Promise<PanelFixture> {
  let running = false;
  let emit: (event: AgentLoopEvent) => void = () => {};
  let release: () => void = () => {};
  let stopCalls = 0;

  const bot: BotHandle & { release(): void } = {
    sendMessage: () => {
      running = true;
      emit({ type: 'user', text: '任务' });
      emit({ type: 'status', text: '已发送，等待模型回复…', step: 1 });
      return new Promise<void>((resolve) => { release = resolve; });
    },
    stop: () => { stopCalls += 1; },
    get running() { return running; },
    health: () => Promise.resolve({ ok: true }),
    release: () => { running = false; release(); },
  };

  const host: AgentChannelHost = {
    bots: {
      get: () => bot,
      list: () => [{ botId: 'main', running }],
    },
    onAgentEvent: (cb) => { emit = cb; return () => {}; },
    get policyMode() { return 'auto' as never; },
    setPolicyMode: () => {},
    get workspaceRoot() { return null; },
    setWorkspaceRoot: () => ({ ok: true }),
    pickFolder: () => Promise.resolve(null),
    desktopPageConnected: () => true,
  };

  const server = createServer();
  const channel = createAgentChannel({ server, host, token: 'tok', path: '/agent-ws' });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const panel = new PanelConnection(port, 'tok');
  await panel.open();

  return { panel, channel, server, bot, emit: (e) => emit(e), stopCalls: () => stopCalls };
}

describe('QD-R9-A · 远程端 running 广播', () => {
  it('CONTROL：broadcastState() 能把 running=true 送到客户端，canStop 变 true', async () => {
    const f = await startPanel();
    const initial = await f.panel.next('state');
    let state: WorkbenchState = applyState(applySocketOpen(createInitialState()), initial as unknown as StatePayload);
    expect(state.running).toBe(false);

    try {
      // 面板发起任务（bot 进入 running，但宿主不会自动广播 state）
      f.panel.send({ type: 'send', text: '任务', reqId: 'r1' });
      await f.panel.next('ack');

      // 唯一能更新 running 的通道：显式 broadcastState
      f.channel.broadcastState();
      const pushed = await f.panel.next('state');
      state = applyState(state, pushed as unknown as StatePayload);
    } finally {
      f.bot.release();
      f.panel.close();
      f.channel.dispose();
      f.server.close();
    }

    expect(state.running).toBe(true);
    expect(canStop(state)).toBe(true);
  });

  it('REPRO-A：任务进行中只收到 event，没有 state ⇒ canStop=false 且 canSend=true', async () => {
    const f = await startPanel();
    const initial = await f.panel.next('state');
    let state: WorkbenchState = applyState(applySocketOpen(createInitialState()), initial as unknown as StatePayload);
    let strayStateType = '';
    let readings = { running: false, canStop: false, canSend: false };
    let busy: Msg = {};

    try {
      f.panel.send({ type: 'send', text: '任务', reqId: 'r1' });
      const ack = await f.panel.next('ack');
      console.log('[R9-A] send ack =', JSON.stringify(ack));

      // 宿主在整轮里只会广播 event（见 agent-channel.broadcast）
      await new Promise((r) => setTimeout(r, 120));
      const strayState = await f.panel.next('state', 250);
      strayStateType = String(strayState.type); // 期望 'state'；实测 'timeout' = 没有广播

      const event = await f.panel.next('event');
      state = applyLoopEvent(state, event.event as AgentLoopEvent);

      readings = {
        running: state.running,
        canStop: canStop(state),
        canSend: canSend(state),
      };
      console.log('[R9-A] state after send =', JSON.stringify(readings), 'strayState =', strayStateType);

      // 客户端闸门失效的连带后果：第二次 send 只能由宿主以 agent-busy 拒绝
      f.panel.send({ type: 'send', text: '第二条', reqId: 'r2' });
      busy = await f.panel.next('ack');
      console.log('[R9-A] second ack =', JSON.stringify(busy));
    } finally {
      f.bot.release();
      f.panel.close();
      f.channel.dispose();
      f.server.close();
    }

    expect(strayStateType).toBe('state'); // 期望：任务开始后广播 running=true
    expect(readings.running).toBe(true); // 期望：任务已开始
    expect(readings.canStop).toBe(true); // 期望：停止键可用
    expect(readings.canSend).toBe(false); // 期望：发送闸门关闭
    expect(busy).toMatchObject({ ok: false, error: 'agent-busy' });
  });
});

describe('QD-R9-B · 停止后旧轮 auto-reply 残留', () => {
  function makeEngine(buffer: { text: string; loop: number; updatedAt: number; fresh: boolean }) {
    let counter = 0;
    const engine = createWebEngine({
      dispatch: async (tool) => {
        if (tool === 'chat-insert' || tool === 'chat-send') return { ok: true };
        if (tool === 'chat-read') {
          return { ok: true, data: { count: 1, messages: [{ text: '新轮基线' }] } };
        }
        return { ok: true };
      },
      toolCallCounter: { get current() { return counter; }, set current(v: number) { counter = v; } } as { current: number },
      getAutoReply: () => ({ ...buffer }),
      consumeAutoReply: () => {
        const r = { ...buffer };
        buffer.fresh = false;
        return r;
      },
      pollIntervalMs: 20,
      stepTimeoutMs: 250,
      maxSendRetries: 0,
    });
    return engine;
  }

  it('CONTROL：缓冲非 fresh 时 waitForNextReply 拿不到旧文本', async () => {
    const buffer = { text: '旧轮结论', loop: 3, updatedAt: Date.now() - 60_000, fresh: false };
    const engine = makeEngine(buffer);
    await engine.send('新任务');
    const r = await engine.waitForNextReply();
    console.log('[R9-B/CONTROL] wait content =', JSON.stringify(r.content), 'timedOut=', r.timedOut);
    expect(r.content).not.toBe('旧轮结论');
  });

  it('REPRO-B：停止后遗留的 fresh 回复会被下一轮续跑等待直接吞掉', async () => {
    // 场景：上一轮被停止，页端 auto-continue 仍完成并推送最终答复 → fresh=true。
    const buffer = { text: '旧轮结论', loop: 3, updatedAt: Date.now() - 60_000, fresh: true };
    const engine = makeEngine(buffer);

    // 新一轮 send 不会清空 lastAutoReply（见 desktop-host send 装配 + web-engine.send）
    await engine.send('新任务');
    const r = await engine.waitForNextReply();
    console.log('[R9-B/REPRO] wait content =', JSON.stringify(r.content), 'toolCalls=', r.toolCalls, 'timedOut=', r.timedOut);

    expect(r.content).not.toBe('旧轮结论');
    expect(buffer.fresh).toBe(true); // 期望：新轮开始时旧缓冲已失效
  });
});
