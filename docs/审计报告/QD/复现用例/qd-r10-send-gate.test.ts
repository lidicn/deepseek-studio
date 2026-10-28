/**
 * QD-R10：发送闸门与 busy 状态机复现件（跑在 E:/NAS/tmp 副本树）。
 *
 * 面：HEAD dcedede + 盘面（agent-loop / task-loop / web-engine / desktop-host 均与盘面同 sha1）。
 *
 * CONTROL-A：AgentLoop 的 active 闸门对第二次 send 生效（面板路径的 busy 依据）。
 * REPRO-A：TaskLoop（/v1/agent/send 与自动化 prompt 任务的实际执行器）在同一 engine 上跑时，
 *          AgentLoop.running 仍为 false ⇒ 面板发送不被拒绝，两个 send 并发进入同一引擎。
 * REPRO-B：两个 TaskLoop 共享 desktop-host 的同一个 kernelHistory ⇒ 第二个任务的提示词
 *          里混入第一个任务的用户消息（上下文串台）。
 * REPRO-C：WebEngine 没有 in-flight 锁，两个 send 并发时共用页面唯一输入框 ⇒
 *          先插入的文本被后插入的覆盖，先发的消息从未送出，且两条都读到同一条回复。
 */
import { describe, expect, it } from 'vitest';
import { createAgentLoop } from '../../src/host/agent-loop';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createWebEngine } from '../../src/host/engine/web-engine';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 可门控引擎：send 挂起直到 releaseAll()，用于观察并发度。 */
function makeGatedEngine() {
  let concurrent = 0;
  let maxConcurrent = 0;
  const received: string[] = [];
  const releases: Array<() => void> = [];
  const engine: ModelEngine = {
    name: 'web',
    async health() {
      return { ok: true };
    },
    async send(text: string): Promise<EngineSendResult> {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      received.push(text);
      await new Promise<void>((resolve) => releases.push(resolve));
      concurrent -= 1;
      return { content: '完成', toolCalls: 0, completion: 'complete' };
    },
    async waitForNextReply(): Promise<EngineSendResult> {
      return { content: '', toolCalls: 0, completion: 'complete' };
    },
  };
  return {
    engine,
    received,
    get maxConcurrent() {
      return maxConcurrent;
    },
    releaseAll() {
      while (releases.length > 0) releases.shift()!();
    },
  };
}

function makeImmediateEngine() {
  const received: string[] = [];
  const engine: ModelEngine = {
    name: 'web',
    async health() {
      return { ok: true };
    },
    async send(text: string): Promise<EngineSendResult> {
      received.push(text);
      return { content: '完成', toolCalls: 0, completion: 'complete' };
    },
  };
  return { engine, received };
}

function makeAgentLoop(engine: ModelEngine) {
  return createAgentLoop({
    engine,
    stopFlag: { stopped: false },
    botId: 'main',
    onEvent: () => {},
    throttleBetweenSteps: false,
    watchdogMs: 10_000,
  });
}

describe('QD-R10-A · 面板闸门只覆盖 AgentLoop', () => {
  it('CONTROL：AgentLoop 在飞时第二次 send 被 agent-busy 拒绝', async () => {
    const g = makeGatedEngine();
    const loop = makeAgentLoop(g.engine);
    const first = loop.send('第一条');
    await waitFor(() => g.received.length === 1);

    const runningDuring = loop.running;
    let busyErr = '';
    try {
      await loop.send('第二条');
    } catch (e) {
      busyErr = e instanceof Error ? e.message : String(e);
    }
    g.releaseAll();
    await first;
    console.log('[R10-A/CONTROL] runningDuring=', runningDuring, 'secondErr=', JSON.stringify(busyErr));

    expect(runningDuring).toBe(true);
    expect(busyErr).toBe('agent-busy');
  });

  it('REPRO-A：TaskLoop 在飞时 loop.running 仍为 false，面板 send 直接并发进入引擎', async () => {
    const g = makeGatedEngine();
    const loop = makeAgentLoop(g.engine);
    const history = createMessageHistory();
    const task = createTaskLoop({ engine: g.engine, history, maxRounds: 1 });

    const taskRun = task.run('自动化任务');
    await waitFor(() => g.received.length === 1);

    // 面板侧此刻看到的 running（桌面面板 send 前检查的就是它）
    const runningWhileTask = loop.running;
    let panelErr = '';
    const panelRun = loop.send('面板消息').catch((e) => {
      panelErr = e instanceof Error ? e.message : String(e);
    });
    await waitFor(() => g.received.length === 2);
    const max = g.maxConcurrent;

    g.releaseAll();
    await Promise.allSettled([taskRun, panelRun]);

    console.log(
      '[R10-A/REPRO] runningWhileTask=', runningWhileTask,
      'panelErr=', JSON.stringify(panelErr),
      'maxConcurrent=', max,
    );

    expect(runningWhileTask).toBe(true); // 期望：TaskLoop 在飞应计入 busy
    expect(panelErr).toBe('agent-busy'); // 期望：面板 send 被闸门拒绝
    expect(max).toBe(1); // 期望：同一 engine 同时只有一条 send
  });
});

describe('QD-R10-B · 共享 kernelHistory 的并发上下文串台', () => {
  it('CONTROL：各自独立 history 时两个任务的提示词互不包含', async () => {
    const e = makeImmediateEngine();
    const h1 = createMessageHistory();
    const h2 = createMessageHistory();
    await Promise.all([
      createTaskLoop({ engine: e.engine, history: h1, maxRounds: 1 }).run('任务甲'),
      createTaskLoop({ engine: e.engine, history: h2, maxRounds: 1 }).run('任务乙'),
    ]);
    console.log('[R10-B/CONTROL] secondPrompt=', e.received[1]?.slice(0, 120));
    expect(e.received[1]).not.toContain('任务甲');
  });

  it('REPRO-B：共享 history 时第二个任务的提示词混入第一个任务的用户消息', async () => {
    const e = makeImmediateEngine();
    const shared = createMessageHistory();
    await Promise.all([
      createTaskLoop({ engine: e.engine, history: shared, maxRounds: 1 }).run('任务甲'),
      createTaskLoop({ engine: e.engine, history: shared, maxRounds: 1 }).run('任务乙'),
    ]);
    console.log('[R10-B/REPRO] prompts=', JSON.stringify(e.received.map((p) => p.slice(0, 120))));
    expect(e.received[1]).not.toContain('任务甲');
  });
});

describe('QD-R10-D · 发送失败的终态被调用方当成成功', () => {
  it('CONTROL：正常引擎返回内容时 TaskLoop 带内容收尾', async () => {
    const e = makeImmediateEngine();
    const result = await createTaskLoop({ engine: e.engine, history: createMessageHistory(), maxRounds: 1 }).run('任务');
    console.log('[R10-D/CONTROL] result=', JSON.stringify(result));
    expect(result.content).toBe('完成');
  });

  it('REPRO-D：页面离线时 TaskLoop 正常 resolve 空内容（agentSender 据此回 200 ok:true）', async () => {
    const engine = createWebEngine({
      dispatch: async (tool) => (tool === 'chat-insert' ? { ok: false, error: 'page-offline' } : { ok: true }),
      toolCallCounter: { current: 0 },
      pollIntervalMs: 10,
      stepTimeoutMs: 200,
      maxSendRetries: 0,
    });
    const result = await createTaskLoop({ engine, history: createMessageHistory(), maxRounds: 1 }).run('任务');
    console.log('[R10-D/REPRO] result=', JSON.stringify(result));

    // agentSender: `return result.content || finalAnswer;` → ''
    // server.ts:466-468 → sendJson(200, { ok: true, answer })
    expect(result.content.length).toBeGreaterThan(0); // 期望：离线不应以空内容正常收尾
  });
});

describe('QD-R10-C · WebEngine 并发 send 共用页面唯一输入框', () => {
  function makePage() {
    const page = { input: '', sent: [] as string[], last: '基线' };
    const dispatch = async (tool: string, params: Record<string, unknown>) => {
      if (tool === 'chat-insert') {
        page.input = String(params.text ?? '');
        return { ok: true };
      }
      if (tool === 'chat-send') {
        const text = page.input;
        if (text.length > 0) {
          page.sent.push(text);
          page.input = '';
          setTimeout(() => {
            page.last = `答复:${text}`;
          }, 5);
        }
        return { ok: true };
      }
      if (tool === 'chat-read') {
        return { ok: true, data: { count: page.sent.length + 1, messages: [{ text: page.last }] } };
      }
      return { ok: true };
    };
    return { page, dispatch };
  }

  it('CONTROL：串行 send 各自送出、各自读到自己的答复', async () => {
    const { page, dispatch } = makePage();
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 10,
      stepTimeoutMs: 500,
      maxSendRetries: 0,
    });
    const r1 = await engine.send('会甲');
    const r2 = await engine.send('会乙');
    console.log('[R10-C/CONTROL] sent=', JSON.stringify(page.sent), 'r1=', JSON.stringify(r1.content), 'r2=', JSON.stringify(r2.content));
    expect(page.sent).toEqual(['会甲', '会乙']);
    expect(r1.content).toBe('答复:会甲');
    expect(r2.content).toBe('答复:会乙');
  });

  it('REPRO-C：并发 send 时先插入的文本被覆盖，先发消息从未送出且读到对方答复', async () => {
    const { page, dispatch } = makePage();
    const engine = createWebEngine({
      dispatch,
      toolCallCounter: { current: 0 },
      pollIntervalMs: 10,
      stepTimeoutMs: 500,
      maxSendRetries: 0,
    });
    const [ra, rb] = await Promise.all([engine.send('会甲'), engine.send('会乙')]);
    console.log(
      '[R10-C/REPRO] sent=', JSON.stringify(page.sent),
      'ra=', JSON.stringify(ra.content),
      'rb=', JSON.stringify(rb.content),
    );
    expect(page.sent).toEqual(['会甲', '会乙']);
    expect(ra.content).toBe('答复:会甲');
  });
});
