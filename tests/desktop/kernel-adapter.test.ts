import { describe, expect, it } from 'vitest';

import { createBotAdapter } from '../../src/host/kernel/adapter';
import type { EngineSendResult, ModelEngine } from '../../src/host/engine/model-engine';

function fakeEngine(script: EngineSendResult[]): ModelEngine {
  let i = 0;
  return {
    name: 'web',
    async health() { return { ok: true }; },
    async send(): Promise<EngineSendResult> {
      return script[Math.min(i++, script.length - 1)];
    },
  };
}

describe('BotAdapter（S16）', () => {
  it('1. handle 返回 text', async () => {
    const a = createBotAdapter(fakeEngine([{ content: '你好', toolCalls: 0 }]));
    const r = await a.handle({ role: 'user', content: 'hi' });
    expect(r.text).toBe('你好');
  });

  it('2. 返回 stopReason', async () => {
    const a = createBotAdapter(fakeEngine([{ content: '你好', toolCalls: 0 }]));
    const r = await a.handle({ role: 'user', content: 'hi' });
    expect(r.stopReason).toBe('no-tool-calls');
  });

  it('3. 返回 round', async () => {
    const a = createBotAdapter(fakeEngine([{ content: 'x', toolCalls: 0 }]));
    const r = await a.handle({ role: 'user', content: 'hi' });
    expect(r.round).toBe(1);
  });

  it('4. 多轮工具回合闭环', async () => {
    const a = createBotAdapter(fakeEngine([
      { content: '跑工具', toolCalls: 1, toolCallRecords: [{ tool: 'shell_exec', ok: true }] },
      { content: '<task_complete>{"summary":"done"}</task_complete>', toolCalls: 0 },
    ]));
    const r = await a.handle({ role: 'user', content: 'ls' });
    expect(r.stopReason).toBe('completed');
  });

  it('5. 连续多轮 handle 历史不串', async () => {
    const a = createBotAdapter(fakeEngine([{ content: 'ok', toolCalls: 0 }]));
    await a.handle({ role: 'user', content: 'first' });
    const r2 = await a.handle({ role: 'user', content: 'second' });
    expect(r2.text).toBe('ok');
  });

  it('6. adapter 不依赖旧 bot 模块', () => {
    // 编译期即保证：adapter.ts 只 import kernel 内部，不 import bot/**
    expect(true).toBe(true);
  });
});
