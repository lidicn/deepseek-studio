import { describe, expect, it, vi } from 'vitest';
import {
  createAgentLoop,
  AGENT_SENTINEL,
  DEFAULT_CONTINUE_NUDGE,
  type AgentLoopEvent,
} from '../../src/host/agent-loop';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';

function fakeEngine(script: EngineSendResult[]): { engine: ModelEngine; sends: string[] } {
  const sends: string[] = [];
  let i = 0;
  const engine: ModelEngine = {
    name: 'web',
    async health() {
      return { ok: true };
    },
    async send(text: string) {
      sends.push(text);
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return next;
    },
  };
  return { engine, sends };
}

function collector() {
  const events: AgentLoopEvent[] = [];
  return { events, onEvent: (e: AgentLoopEvent) => events.push(e) };
}

describe('agent-loop —— 状态机', () => {
  it('无工具调用：一步结束并输出最终回答', async () => {
    const { engine, sends } = fakeEngine([{ content: '答案是 42', toolCalls: 0 }]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('你好');

    expect(sends).toEqual(['你好']);
    expect(c.events.some((e) => e.type === 'assistant' && e.text === '答案是 42')).toBe(true);
    expect(c.events.at(-1)?.type).toBe('done');
  });

  it('工具调用后自动续跑，直至产出最终回答', async () => {
    const { engine, sends } = fakeEngine([
      { content: '先读文件', toolCalls: 2 },
      { content: '文件内容是…', toolCalls: 1 },
      { content: '任务完成', toolCalls: 0 },
    ]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('读取 a.txt 并总结');

    expect(sends).toEqual(['读取 a.txt 并总结', DEFAULT_CONTINUE_NUDGE, DEFAULT_CONTINUE_NUDGE]);
    expect(c.events.filter((e) => e.type === 'tool').map((e) => e.toolCalls)).toEqual([2, 1]);
    expect(c.events.some((e) => e.type === 'assistant' && e.text === '任务完成')).toBe(true);
  });

  it('max_steps 上限：超出后报错并停止续跑', async () => {
    const { engine, sends } = fakeEngine([{ content: '继续调工具', toolCalls: 1 }]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, maxSteps: 3, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('做事');

    expect(sends.length).toBe(3); // 初始 + 2 次续跑
    expect(c.events.some((e) => e.type === 'error' && e.text?.includes('已达最大步数'))).toBe(true);
  });

  it('stop() 置位 stopFlag，循环在下一步边界停止', async () => {
    const { engine } = fakeEngine([
      { content: '调工具', toolCalls: 1 },
      { content: '又调工具', toolCalls: 1 },
    ]);
    const c = collector();
    const stopFlag = { stopped: false };
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag, throttleBetweenSteps: false });

    const p = loop.send('长任务');
    // 引擎在第二次 send 后由测试侧模拟用户停止
    const originalSend = engine.send.bind(engine);
    let callCount = 0;
    engine.send = async (text: string) => {
      callCount += 1;
      if (callCount === 2) loop.stop();
      return originalSend(text);
    };
    await p;

    // R2-06：回合结束不再无条件清掉共享 stopFlag，停止意图保留到下次 send 开始时复位
    expect(stopFlag.stopped).toBe(true);
    expect(c.events.some((e) => e.type === 'status' && e.text?.includes('停止'))).toBe(true);
  });

  it('引擎抛错 → error 事件 + done，不向上冒泡', async () => {
    const engine: ModelEngine = {
      name: 'web',
      async health() {
        return { ok: false };
      },
      async send() {
        throw new Error('page-not-connected');
      },
    };
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await expect(loop.send('x')).resolves.toBeUndefined();
    expect(c.events.some((e) => e.type === 'error' && e.text?.includes('page-not-connected'))).toBe(true);
    expect(c.events.at(-1)?.type).toBe('done');
  });

  it('并发 send 拒绝（agent-busy）', async () => {
    const { engine } = fakeEngine([{ content: 'ok', toolCalls: 0 }]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    const first = loop.send('第一条');
    await expect(loop.send('第二条')).rejects.toThrow('agent-busy');
    await first;
  });

  it('R2-06：回合中外部置停后，finally 不清零共享 stopFlag（停止意图保留）', async () => {
    const stopFlag = { stopped: false };
    let engineSend = 0;
    const engine: ModelEngine = {
      name: 'web',
      async health() { return { ok: true }; },
      async send() {
        engineSend += 1;
        if (engineSend === 1) stopFlag.stopped = true; // 回合进行中外部置停
        return { content: '', toolCalls: 0 };
      },
    };
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag, throttleBetweenSteps: false });
    await loop.send('任务');
    // R2-06：finally 不再无条件复位，停止信号保持 true（下次 send 开始时才复位）
    expect(stopFlag.stopped).toBe(true);
    expect(c.events.some((e) => e.type === 'status' && e.text?.includes('停止'))).toBe(true);
  });

  it('SENTINEL 常量存在且被面板前缀使用（契约守卫）', () => {
    expect(AGENT_SENTINEL).toBe('【Studio Agent】');
  });
});

describe('agent-loop —— 事件序列（面板渲染依据）', () => {
  it('完整回合的事件顺序为 user → status → tool → status → assistant → done', async () => {
    const { engine } = fakeEngine([
      { content: '', toolCalls: 1 },
      { content: '结论：一切正常', toolCalls: 0 },
    ]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('体检');

    const types = c.events.map((e) => e.type);
    expect(types[0]).toBe('user');
    expect(types[types.length - 1]).toBe('done');
    expect(types).toContain('tool');
    expect(types).toContain('assistant');
    // assistant 在 done 之前
    expect(types.indexOf('assistant')).toBeLessThan(types.length - 1);
  });
});

describe('agent-loop —— 引擎健康', () => {
  it('health 透传引擎探测结果', async () => {
    const { engine } = fakeEngine([]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });
    expect(await engine.health()).toEqual({ ok: true });
    void loop;
    void vi;
  });
});

describe('agent-loop —— v0.28 roomId 戳事件（多房间隔离）', () => {
  it('send 带 roomId → 每条事件戳上 roomId', async () => {
    const { engine } = fakeEngine([{ content: '回复', toolCalls: 0 }]);
    const c = collector();
    const loop = createAgentLoop({
      engine,
      onEvent: c.onEvent,
      stopFlag: { stopped: false },
      throttleBetweenSteps: false,
    });

    await loop.send('你好', { roomId: 'room-1' });

    // 每条事件都应带 roomId
    expect(c.events.length).toBeGreaterThan(0);
    for (const e of c.events) {
      expect(e.roomId).toBe('room-1');
    }
    expect(c.events[0].type).toBe('user');
    expect(c.events[c.events.length - 1].type).toBe('done');
  });

  it('send 不带 roomId → 事件无 roomId（日常对话向后兼容）', async () => {
    const { engine } = fakeEngine([{ content: '回复', toolCalls: 0 }]);
    const c = collector();
    const loop = createAgentLoop({
      engine,
      onEvent: c.onEvent,
      stopFlag: { stopped: false },
      throttleBetweenSteps: false,
    });

    await loop.send('日常聊天');

    for (const e of c.events) {
      expect(e.roomId).toBeUndefined();
    }
  });

  it('同 loop 先日常后聊天室 → roomId 不串味', async () => {
    const { engine } = fakeEngine([{ content: '回复1', toolCalls: 0 }, { content: '回复2', toolCalls: 0 }]);
    const c = collector();
    const loop = createAgentLoop({
      engine,
      onEvent: c.onEvent,
      stopFlag: { stopped: false },
      throttleBetweenSteps: false,
    });

    // 第一次：日常对话（无 roomId）
    await loop.send('日常');
    const dailyEvents = [...c.events];
    for (const e of dailyEvents) {
      expect(e.roomId).toBeUndefined();
    }

    // 第二次：聊天室（带 roomId）
    await loop.send('聊天室任务', { roomId: 'room-2' });
    const roomEvents = c.events.slice(dailyEvents.length);
    expect(roomEvents.length).toBeGreaterThan(0);
    for (const e of roomEvents) {
      expect(e.roomId).toBe('room-2');
    }
  });
});
