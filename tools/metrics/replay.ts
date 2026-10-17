/**
 * tools/metrics/replay.ts — JSONL 回放 mock 引擎（S10）
 *
 * 输入 JSONL 日志，输出一个实现 ModelEngine 接口的 mock 引擎，
 * 按日志顺序返回 content / toolCalls / toolCallRecords。
 */

import type { ModelEngine, EngineSendResult, ToolCallRecord } from '../../src/host/engine/model-engine';

/** 从 JSONL 行解析出的一条 send 响应。 */
interface ReplayTurn {
  content: string;
  toolCalls: number;
  toolCallRecords?: readonly ToolCallRecord[];
  timedOut?: boolean;
}

/**
 * 从事件行数组构造 mock 引擎。
 * 约定：loop type:'tool' 开始一轮，后续 bus after-call 计入本轮，
 * type:'assistant' 结束本轮并产出一条响应。
 */
export function createReplayEngine(lines: string[]): ModelEngine {
  const turns: ReplayTurn[] = [];
  let currentToolCalls = 0;
  let currentRecords: ToolCallRecord[] = [];
  let currentContent = '';

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let obj: { kind?: string; event?: string; type?: string; text?: string };
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }

    if (obj.kind === 'bus' && obj.event === 'after-call') {
      currentToolCalls++;
    } else if (obj.kind === 'loop' && obj.type === 'assistant') {
      turns.push({
        content: currentContent || '(replay)',
        toolCalls: currentToolCalls,
        ...(currentRecords.length > 0 ? { toolCallRecords: currentRecords } : {}),
      });
      currentToolCalls = 0;
      currentRecords = [];
      currentContent = '';
    }
  }

  let idx = 0;

  async function doSend(): Promise<EngineSendResult> {
    const turn = turns[idx] ?? { content: '', toolCalls: 0 };
    idx++;
    return { content: turn.content, toolCalls: turn.toolCalls, ...(turn.toolCallRecords ? { toolCallRecords: turn.toolCallRecords } : {}), ...(turn.timedOut ? { timedOut: true } : {}) };
  }

  return {
    name: 'web',
    async health() { return { ok: true }; },
    send: doSend,
    waitForNextReply: doSend,
  };
}
