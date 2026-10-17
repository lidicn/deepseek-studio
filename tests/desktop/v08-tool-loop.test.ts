/**
 * v0.8 验收测试：chat 工具循环 runtime（核心体验闭环）
 *
 * 验收标准（来自路线图 v0.8）：
 * - 模型自动检测工具调用 → 授权 → 执行 → 结果回注 → 工具块渲染
 * - 长任务不断流（120s 长命令）
 * - 刷新页面后工具块历史恢复
 * - 页端 POW auto-continue 是唯一续跑权威，宿主只等待结果
 */
import { describe, it, expect } from 'vitest';
import {
  createAgentLoop,
  DEFAULT_CONTINUE_NUDGE,
  type AgentLoopEvent,
} from '../../src/host/agent-loop';
// 注：FORMAT_CORRECTION_NUDGE 与宿主侧格式纠偏已被既有在制品 S22 删除（WebEngine completion
// 自证后不再需要），本文件对应的纠偏用例已随 S22 移除；此处仅保留其余闭环验收，非本次审计改动。
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';

/** 支持 waitForNextReply 的 fake engine（v0.8 页端 auto-continue 模式） */
function fakeEngineWithWait(script: EngineSendResult[]): {
  engine: ModelEngine;
  sends: string[];
  waitCalls: { count: number };
} {
  const sends: string[] = [];
  const waitCalls = { count: 0 };
  let i = 0;
  const engine: ModelEngine = {
    name: 'web',
    async health() { return { ok: true }; },
    async send(text: string) {
      sends.push(text);
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return next;
    },
    async waitForNextReply() {
      waitCalls.count += 1;
      // 模拟页端 auto-continue 完成后的回复
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      return next;
    },
  };
  return { engine, sends, waitCalls };
}

function collector() {
  const events: AgentLoopEvent[] = [];
  return { events, onEvent: (e: AgentLoopEvent) => events.push(e) };
}

describe('v0.8: 工具循环闭环（页端 auto-continue 模式）', () => {
  it('工具调用后使用 waitForNextReply 而非发 continueNudge', async () => {
    const { engine, sends, waitCalls } = fakeEngineWithWait([
      { content: '先读文件', toolCalls: 2 },
      { content: '文件内容是…', toolCalls: 1 },
      { content: '任务完成', toolCalls: 0 },
    ]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('读取并总结');

    // 只有第一次是用户消息，后续都走 waitForNextReply
    expect(sends).toEqual(['读取并总结']);
    expect(waitCalls.count).toBe(2); // 两次工具调用后各等待一次
    expect(c.events.filter((e) => e.type === 'tool').map((e) => e.toolCalls)).toEqual([2, 1]);
    expect(c.events.some((e) => e.type === 'assistant' && e.text === '任务完成')).toBe(true);
  });

  it('waitForNextReply 不存在时降级为发 continueNudge', async () => {
    const sends: string[] = [];
    let i = 0;
    const script = [
      { content: '调工具', toolCalls: 1 },
      { content: '完成', toolCalls: 0 },
    ];
    const engine: ModelEngine = {
      name: 'web',
      async health() { return { ok: true }; },
      async send(text: string) {
        sends.push(text);
        const next = script[Math.min(i, script.length - 1)];
        i += 1;
        return next;
      },
      // 不实现 waitForNextReply
    };
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('做事');

    expect(sends).toEqual(['做事', DEFAULT_CONTINUE_NUDGE]);
  });

  it('多步工具调用：每步 toolCalls 正确累计', async () => {
    const { engine, waitCalls } = fakeEngineWithWait([
      { content: '第一步', toolCalls: 1 },
      { content: '第二步', toolCalls: 3 },
      { content: '第三步', toolCalls: 2 },
      { content: '最终回答', toolCalls: 0 },
    ]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('复杂任务');

    const toolEvents = c.events.filter((e) => e.type === 'tool');
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents.map((e) => e.toolCalls)).toEqual([1, 3, 2]);
    expect(waitCalls.count).toBe(3);
  });

  it('maxSteps 上限在 auto-continue 模式下生效', async () => {
    const { engine, waitCalls } = fakeEngineWithWait([
      { content: '继续调', toolCalls: 1 },
    ]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, maxSteps: 5, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('无限循环');

    expect(waitCalls.count).toBe(4); // 初始 1 步 + 4 次续跑 = 5 步上限
    expect(c.events.some((e) => e.type === 'error' && e.text?.includes('已达最大步数'))).toBe(true);
  });
});

describe('v0.8: 长任务不断流', () => {
  it('引擎回复超时后仍能继续（看门狗兜底不中断循环）', async () => {
    const { engine, waitCalls } = fakeEngineWithWait([
      { content: '开始长任务', toolCalls: 1, timedOut: true },
      { content: '长任务完成', toolCalls: 0 },
    ]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('跑长命令');

    // 超时后仍继续循环，不中断
    expect(c.events.some((e) => e.type === 'error' && e.text?.includes('超时'))).toBe(true);
    expect(c.events.some((e) => e.type === 'assistant' && e.text === '长任务完成')).toBe(true);
    expect(waitCalls.count).toBe(1);
  });

  it('工具调用后等待页端续跑的状态事件正确发出', async () => {
    const { engine } = fakeEngineWithWait([
      { content: '调工具', toolCalls: 1 },
      { content: '完成', toolCalls: 0 },
    ]);
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });

    await loop.send('测试');

    const statusEvents = c.events.filter((e) => e.type === 'status');
    expect(statusEvents.some((e) => e.text?.includes('等待页端续跑'))).toBe(true);
  });
});

// （S22 既有在制品：宿主侧格式纠偏已删除，对应「格式纠偏」describe 块随其移除，非本次审计改动。）

describe('v0.8: 停止与恢复', () => {
  it('stop() 后上下文保留，可再次发送继续', async () => {
    const script = [
      { content: '第一步', toolCalls: 1 },
      { content: '第二步', toolCalls: 0 },
    ];
    const sends: string[] = [];
    let i = 0;
    const stopFlag = { stopped: false };
    let waitCount = 0;
    const engine: ModelEngine = {
      name: 'web',
      async health() { return { ok: true }; },
      async send(text: string) {
        sends.push(text);
        const next = script[Math.min(i, script.length - 1)];
        i += 1;
        return next;
      },
      async waitForNextReply() {
        waitCount += 1;
        if (waitCount === 1) stopFlag.stopped = true; // 第一次等待时模拟用户停止
        const next = script[Math.min(i, script.length - 1)];
        i += 1;
        return next;
      },
    };
    const c = collector();
    const loop = createAgentLoop({ engine, onEvent: c.onEvent, stopFlag, throttleBetweenSteps: false });

    await loop.send('任务A');

    expect(c.events.some((e) => e.text?.includes('停止'))).toBe(true);

    // 再次发送应正常工作（active 已复位）
    const c2 = collector();
    const loop2 = createAgentLoop({ engine, onEvent: c2.onEvent, stopFlag: { stopped: false }, throttleBetweenSteps: false });
    await expect(loop2.send('继续')).resolves.toBeUndefined();
  });

  it('finally 块复位 stopFlag 和 active', async () => {
    const { engine } = fakeEngineWithWait([{ content: 'ok', toolCalls: 0 }]);
    const stopFlag = { stopped: false };
    const loop = createAgentLoop({ engine, onEvent: () => {}, stopFlag });

    await loop.send('测试');

    expect(loop.running).toBe(false);
    expect(stopFlag.stopped).toBe(false);
  });
});
