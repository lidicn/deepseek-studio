/**
 * Adapter（S16+S19）：把 TaskLoop 包成旧 bot/** 期望的接口形状，并支持流式 delta。
 *
 * 旧 agent-loop.ts 的删除由 PM 协调席2/席3；本层只提供 adapter，不修改 agent-loop.ts。
 */

import type { ModelEngine } from '../engine/model-engine';
import { createMessageHistory, type MessageHistory } from './message-history';
import { createTaskLoop, type TaskLoopRoundResult } from './task-loop';

export interface BotMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface BotReply {
  readonly text: string;
  readonly stopReason?: string;
  readonly round: number;
}

export interface BotAdapter {
  handle(msg: BotMessage): Promise<BotReply>;
  readonly history: MessageHistory;
}

export interface BotAdapterOptions {
  readonly onDelta?: (chunk: string) => void;
}

/** 用 TaskLoop 包一个旧 bot 风格的 handle()，S19 透传流式 delta。 */
export function createBotAdapter(engine: ModelEngine, opts: BotAdapterOptions = {}): BotAdapter {
  const history = createMessageHistory();
  const loop = createTaskLoop({ engine, history, maxRounds: 3, onDelta: opts.onDelta });

  async function handle(msg: BotMessage): Promise<BotReply> {
    const r: TaskLoopRoundResult = await loop.run(msg.content);
    return {
      text: r.content,
      stopReason: r.stopReason,
      round: r.round,
    };
  }

  return { handle, history };
}
