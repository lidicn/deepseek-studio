/**
 * M2-2：EngineSendResult.toolCallRecords 结构化工具调用记录测试。
 *
 * 验证 additive 方案：老字段 toolCalls(number) 不变，新字段 toolCallRecords 可选。
 * 不传 onToolCall → undefined；传了 → 本轮累积数组。
 */

import { describe, it, expect, vi } from 'vitest';
import { createWebEngine, type WebEngine } from '../../src/host/engine/web-engine';
import type { ToolCallRecord } from '../../src/host/engine/model-engine';
import type { ExecuteResult } from '../../src/capabilities/types';

/**
 * 构造一个 mock dispatch，模拟 chat.deepseek.com 的读取-稳定检测流程。
 * - chat-insert / chat-send 直接返回 ok
 * - chat-read 第一次返回 baseline（旧消息），之后统一返回 "reply"，
 *   连续 3 次 "reply" 触发稳定检测退出循环。
 * - onChatReadSecond 参数：在第二次 chat-read（首次看到新回复）时执行副作用，
 *   用于模拟工具调用发生。
 */
function makeMockEngine(opts: {
  withOnToolCall?: boolean;
  pollIntervalMs?: number;
  onSecondChatRead?: () => void;
}): { engine: WebEngine; toolCallCounter: { current: number } } {
  const toolCallCounter = { current: 0 };
  let engine!: WebEngine;
  let chatReadCount = 0;

  const dispatch = async (tool: string): Promise<ExecuteResult> => {
    if (tool === 'chat-insert' || tool === 'chat-send') {
      return { ok: true } as ExecuteResult;
    }
    if (tool === 'chat-read') {
      chatReadCount++;
      if (chatReadCount === 1) {
        // baseline：发送前的旧消息
        return { ok: true, data: { count: 1, messages: [{ text: 'old' }] } } as ExecuteResult;
      }
      if (chatReadCount === 2 && opts.onSecondChatRead) {
        opts.onSecondChatRead();
      }
      return { ok: true, data: { count: 2, messages: [{ text: 'reply' }] } } as ExecuteResult;
    }
    return { ok: false, error: `unknown-tool: ${tool}` } as ExecuteResult;
  };

  const onToolCall = opts.withOnToolCall ? vi.fn() : undefined;

  engine = createWebEngine({
    dispatch,
    toolCallCounter,
    pollIntervalMs: opts.pollIntervalMs ?? 5,
    stepTimeoutMs: 5_000,
    ...(onToolCall ? { onToolCall } : {}),
  });

  return { engine, toolCallCounter };
}

describe('M2-2 toolCallRecords 结构化字段', () => {
  it('1. 不传 onToolCall → toolCallRecords 为 undefined（向后兼容）', async () => {
    const { engine } = makeMockEngine({});
    const result = await engine.send('hello');
    expect(result.toolCalls).toBe(0);
    expect(result.toolCallRecords).toBeUndefined();
  });

  it('2. 传 onToolCall 且无工具调用 → toolCallRecords 为 []', async () => {
    const { engine } = makeMockEngine({ withOnToolCall: true });
    const result = await engine.send('hello');
    expect(result.toolCalls).toBe(0);
    expect(result.toolCallRecords).toBeDefined();
    expect(result.toolCallRecords).toEqual([]);
  });

  it('3. 一次工具调用 → records.length === 1 且 toolCalls === 1', async () => {
    const { engine, toolCallCounter } = makeMockEngine({
      withOnToolCall: true,
      onSecondChatRead: () => {
        toolCallCounter.current++;
        engine.recordToolCall({ tool: 'search', ok: true });
      },
    });
    const result = await engine.send('hello');
    expect(result.toolCalls).toBe(1);
    expect(result.toolCallRecords).toHaveLength(1);
  });

  it('4. 三次工具调用 → records.length === 3 且 toolCalls === 3', async () => {
    const { engine, toolCallCounter } = makeMockEngine({
      withOnToolCall: true,
      onSecondChatRead: () => {
        for (let i = 0; i < 3; i++) {
          toolCallCounter.current++;
          engine.recordToolCall({ tool: `tool-${i}`, ok: i !== 1, error: i === 1 ? 'fail' : undefined });
        }
      },
    });
    const result = await engine.send('hello');
    expect(result.toolCalls).toBe(3);
    expect(result.toolCallRecords).toHaveLength(3);
  });

  it('5. records 里每条含 tool/ok 字段', async () => {
    const { engine, toolCallCounter } = makeMockEngine({
      withOnToolCall: true,
      onSecondChatRead: () => {
        toolCallCounter.current++;
        toolCallCounter.current++;
        engine.recordToolCall({ tool: 'read_file', ok: true });
        engine.recordToolCall({ tool: 'write_file', ok: false, error: 'permission-denied' });
      },
    });
    const result = await engine.send('hello');
    const records = result.toolCallRecords!;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ tool: 'read_file', ok: true });
    expect(records[1]).toMatchObject({ tool: 'write_file', ok: false, error: 'permission-denied' });
  });

  it('6. 连续两次 send，第二次的 records 不包含第一次的（每轮清空）', async () => {
    const { engine, toolCallCounter } = makeMockEngine({ withOnToolCall: true });

    // 第一轮：注入 1 条记录
    // 重新构造一个支持多次注入的 mock
    let engine2!: WebEngine;
    let chatReadCount = 0;
    const dispatch2 = async (tool: string): Promise<ExecuteResult> => {
      if (tool === 'chat-insert' || tool === 'chat-send') {
        return { ok: true } as ExecuteResult;
      }
      if (tool === 'chat-read') {
        chatReadCount++;
        // 每轮的第一次 chat-read 是 baseline
        // 简化处理：用全局计数无法区分轮次，改为根据返回值判断
        // 这里用一个外部标志：第一轮注入 1 次，第二轮注入 2 次
        const round = Math.floor(chatReadCount / 4); // 每轮 4 次 chat-read（1 baseline + 3 stable）
        const positionInRound = chatReadCount % 4;
        if (positionInRound === 2) {
          // 首次看到新回复时注入
          const injectCount = round === 0 ? 1 : 2;
          for (let i = 0; i < injectCount; i++) {
            toolCallCounter.current++;
            engine2.recordToolCall({ tool: `round-${round}-tool-${i}`, ok: true });
          }
        }
        if (positionInRound === 1) {
          return { ok: true, data: { count: 1, messages: [{ text: 'old' }] } } as ExecuteResult;
        }
        return { ok: true, data: { count: 2, messages: [{ text: 'reply' }] } } as ExecuteResult;
      }
      return { ok: false, error: 'unknown' } as ExecuteResult;
    };

    engine2 = createWebEngine({
      dispatch: dispatch2,
      toolCallCounter,
      pollIntervalMs: 5,
      stepTimeoutMs: 5_000,
      onToolCall: () => {},
    });

    void engine; // 不用上面的 engine

    const r1 = await engine2.send('first');
    expect(r1.toolCallRecords).toHaveLength(1);
    expect(r1.toolCallRecords![0].tool).toBe('round-0-tool-0');

    const r2 = await engine2.send('second');
    expect(r2.toolCallRecords).toHaveLength(2);
    expect(r2.toolCallRecords![0].tool).toBe('round-1-tool-0');
    expect(r2.toolCallRecords![1].tool).toBe('round-1-tool-1');
    // 确保第二轮不包含第一轮的记录
    expect(r2.toolCallRecords!.some((r: ToolCallRecord) => r.tool === 'round-0-tool-0')).toBe(false);
  });
});
