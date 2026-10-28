/**
 * QD-R17 复现件 · TaskLoop 主路的 stopFlag 复位 × 进程级 kernelHistory × 并发 run 串轮
 *
 * 真用：createTaskLoop、createMessageHistory、createWebEngine、createBotRegistry
 *      （真 AgentLoop 只为拿到与生产同形的 state.stopFlag / toolCallCounter 接线）。
 * 假用：dispatch（一扇可控的"网页"：chat-insert / chat-send / chat-read）。
 * 与生产逐条对齐：
 *   - 引擎装配 = desktop-host.ts:814-826（dispatch / toolCallCounter=state.toolCallCounter /
 *     isStopped=()=>state.stopFlag.stopped）。
 *   - TaskLoop 装配 = desktop-host.ts:866-870 与 901-905（engine=mainBot.engine、
 *     history=进程级 kernelHistory、maxRounds:25、⛔ signal、⛔ store）。
 *   - 「停止」入口 = desktop-host.ts:876 `stop: () => mainBot?.loop.stop()`。
 * 面：src/host/kernel/*、src/host/engine/* 全在 HEAD `dcedede` 干净
 *      （task-loop=505588f5 / web-engine=a7b0f5d4 / message-history=906d551a）⇒ 两面同读。
 */
import { describe, expect, it } from 'vitest';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createWebEngine } from '../../src/host/engine/web-engine';
import { createBotRegistry, type BotRegistryInternal } from '../../src/host/bot/registry';
import type { ExecuteResult } from '../../src/capabilities/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 可控页面：release() 之前 chat-read 一直返回 baseline ⇒ send() 永不判完成（用于把两个 run 停在同一窗口）。
 * 每次 chat-send 把 current 复位成 baseline，因此后发的那条 send 会把先发的 run 的视野一起改掉——
 * 这正是"两个 run 共用一扇页面"的真实形状，不是桩的发明。
 */
function makeGatedPage() {
  const inserts: string[] = [];
  let sends = 0;
  let current = '（页面初始内容）';
  let pending = '';
  const dispatch = async (tool: string, params: Record<string, unknown>): Promise<ExecuteResult> => {
    if (tool === 'chat-insert') {
      inserts.push(String(params.text ?? ''));
      return { ok: true, data: { inserted: true } };
    }
    if (tool === 'chat-send') {
      sends += 1;
      current = '（页面初始内容）';
      pending = '';
      return { ok: true, data: { sent: true } };
    }
    if (tool === 'chat-read') {
      if (pending) current = pending;
      return { ok: true, data: { count: 1, messages: [{ text: current }] } };
    }
    return { ok: false, error: `unexpected tool ${tool}` };
  };
  return { dispatch, inserts, sendCount: () => sends, release: (text: string) => { pending = text; } };
}

/** 引擎接线 = desktop-host.ts:814-826；pollInterval 10ms / stepTimeout 400ms 让腿跑得快。 */
function makeRegistry(dispatch: (t: string, p: Record<string, unknown>) => Promise<ExecuteResult>): BotRegistryInternal {
  return createBotRegistry({
    createEngine: ({ state }) =>
      createWebEngine({
        dispatch,
        toolCallCounter: state.toolCallCounter,
        isStopped: () => state.stopFlag.stopped,
        pollIntervalMs: 10,
        stepTimeoutMs: 400,
      }),
    onEvent: () => { /* noop */ },
    loopOptions: { throttleBetweenSteps: false },
  });
}

async function readyMain(registry: BotRegistryInternal) {
  await registry.create({ botId: 'main', slotId: 'main' });
  return registry.get('main')!;
}

describe('QD-R17 · TaskLoop 主路（面板 b70d5d8 之后的真身）', () => {
  it('CONTROL：未停过的引擎 + 单条消息 ⇒ TaskLoop 一轮拿到非空回复，只发一次', async () => {
    const page = makeGatedPage();
    const registry = makeRegistry(page.dispatch);
    const main = await readyMain(registry);
    const history = createMessageHistory();

    const loop = createTaskLoop({ engine: main.engine, history, maxRounds: 25 });
    const running = loop.run('第一条提问');
    await sleep(15);
    page.release('模型回复甲');
    const res = await running;

    console.log(`[CONTROL] stopReason=${res.stopReason} content=${JSON.stringify(res.content)} 历史=${history.size()} 发出次数=${page.sendCount()} insert数=${page.inserts.length}`);
    expect(res.content).toBe('模型回复甲');
    expect(page.sendCount()).toBe(1);
    expect(history.size()).toBe(2);
  });

  it('REPRO-A：按过一次「停止」⇒ 此后每条消息秒回空，且空 assistant 永久留在共享历史里', async () => {
    const page = makeGatedPage();
    const registry = makeRegistry(page.dispatch);
    const main = await readyMain(registry);
    const state = registry.getState('main')!;
    const kernelHistory = createMessageHistory(); // 生产：desktop-host.ts:832 进程级一次

    main.loop.stop(); // = agent.stop()（desktop-host.ts:876）
    console.log(`[REPRO-A] stop 后 stopFlag=${state.stopFlag.stopped}`);

    const t0 = Date.now();
    const r1 = await createTaskLoop({ engine: main.engine, history: kernelHistory, maxRounds: 25 }).run('停止之后的第一条');
    const cost1 = Date.now() - t0;
    const r2 = await createTaskLoop({ engine: main.engine, history: kernelHistory, maxRounds: 25 }).run('停止之后的第二条');

    console.log(
      `[REPRO-A] r1 stopReason=${r1.stopReason} content=${JSON.stringify(r1.content)} 用时=${cost1}ms ｜ `
      + `r2 stopReason=${r2.stopReason} content=${JSON.stringify(r2.content)} ｜ stopFlag 仍=${state.stopFlag.stopped}`,
    );
    console.log(`[REPRO-A] 历史=${JSON.stringify(kernelHistory.all().map((m) => `${m.role}:${m.content || '<空>'}`))}`);
    expect.soft(r1.content, '停止后第一条消息拿到了回复').not.toBe('');
    expect.soft(r2.content, '停止后第二条消息拿到了回复（⛔ 重启不恢复）').not.toBe('');
    expect.soft(state.stopFlag.stopped, 'send 起点复位了 stopFlag（agent-loop.ts:89 的等价动作）').toBe(false);
    expect(
      kernelHistory.all().some((m) => m.role === 'assistant' && m.content === ''),
      '空 assistant 被写进了跨会话共享历史',
    ).toBe(false);
  });

  it('REPRO-B：kernelHistory 无清空点 ⇒ 新对话的输入框里带着上一段对话的全文', async () => {
    const page = makeGatedPage();
    const registry = makeRegistry(page.dispatch);
    const main = await readyMain(registry);
    const kernelHistory = createMessageHistory();

    let seq = 0;
    const runA = createTaskLoop({ engine: main.engine, history: kernelHistory, maxRounds: 25 }).run('会话一的机密提问');
    await sleep(15);
    page.release(`回复${++seq}`);
    await runA;

    // 用户在 UI 上点「新对话」——宿主侧没有任何 clear/reset 调用点（见报告 grep 证据）
    const runB = createTaskLoop({ engine: main.engine, history: kernelHistory, maxRounds: 25 }).run('会话二的第一个问题');
    await sleep(15);
    page.release('回复2');
    const r2 = await runB;

    const prompt2 = page.inserts[1] ?? '';
    console.log(`[REPRO-B] 第二次 send 的 prompt=${prompt2.slice(0, 300)}`);
    console.log(`[REPRO-B] 历史条数=${kernelHistory.size()} r2 content=${JSON.stringify(r2.content)}`);
    expect.soft(prompt2, '新对话的 prompt 里不含上一段的提问').not.toContain('会话一的机密提问');
    expect.soft(prompt2, '新对话的 prompt 里不含上一段的回复').not.toContain('回复1');
    expect(r2.content).toBe('回复2'); // send 本身正常，排除「整件都跑不通」
  });

  it('REPRO-C：两个 run 并发共用同一引擎 ⇒ 后发的会话读到前一条的回复，还继承它的工具计数', async () => {
    const page = makeGatedPage();
    const registry = makeRegistry(page.dispatch);
    const main = await readyMain(registry);
    const state = registry.getState('main')!;
    const kernelHistory = createMessageHistory();

    // 会话甲：已发出、正在轮询（release 之前永远不会完成）
    const a = createTaskLoop({ engine: main.engine, history: kernelHistory, maxRounds: 2 }).run('甲的提问');
    await sleep(15);
    // 会话乙：面板闸门此刻拦不住（running 见 REPRO-D），所以生产可达
    const b = createTaskLoop({ engine: main.engine, history: kernelHistory, maxRounds: 2 }).run('乙的提问');
    await sleep(15);
    // hub 在这一刻把甲的 3 次工具执行记进共享计数器
    state.toolCallCounter.current += 3;
    page.release('甲的回复');

    const [ra, rb] = await Promise.all([a, b]);
    console.log(
      `[REPRO-C] 甲 stopReason=${ra.stopReason} content=${JSON.stringify(ra.content)} toolCalls=${ra.toolCalls} round=${ra.round}`,
    );
    console.log(
      `[REPRO-C] 乙 stopReason=${rb.stopReason} content=${JSON.stringify(rb.content)} toolCalls=${rb.toolCalls} round=${rb.round}`,
    );
    console.log(`[REPRO-C] insert 数=${page.inserts.length} 发出次数=${page.sendCount()} 共享计数器=${state.toolCallCounter.current}`);
    expect.soft(rb.content, '乙读到的是甲的那一条回复（串轮）').not.toBe('甲的回复');
    expect.soft(rb.toolCalls, '乙的工具计数⛔ 继承甲的 3 次').toBe(0);
    expect(page.inserts.length, '用户发两条，页面被写入的次数').toBeLessThanOrEqual(2);
  });

  it('REPRO-D：TaskLoop 在飞时 main.loop.running 恒 false ⇒ busy 闸门结构性失效', async () => {
    const page = makeGatedPage();
    const registry = makeRegistry(page.dispatch);
    const main = await readyMain(registry);
    const kernelHistory = createMessageHistory();

    const a = createTaskLoop({ engine: main.engine, history: kernelHistory, maxRounds: 25 }).run('正在跑的提问');
    await sleep(15);
    const runningDuringTaskLoop = main.loop.running;
    const insertDone = page.inserts.length;
    page.release('回复丁');
    await a;

    console.log(`[REPRO-D] TaskLoop 在飞时（已 insert ${insertDone} 条）loop.running=${runningDuringTaskLoop}（agent.running 同源：desktop-host.ts:877-879）`);
    expect(runningDuringTaskLoop, '有一条 TaskLoop 正在跑，running 应当为 true').toBe(true);
  });
});
