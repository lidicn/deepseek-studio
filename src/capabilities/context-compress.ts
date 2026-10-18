/**
 * context-compress —— 本地、纯函数、离线的 history 超预算压缩（ORD-004）
 *
 * 策略（纯函数，不调模型）：
 * - 始终保留 system 消息原文。
 * - 始终保留最近的若干轮（recentWindow，默认 4 条）原文——含最新 user 与最近 assistant。
 * - 其余更早的消息折叠成一条摘要占位，只保留条数与首条 user 要点，避免关键近期上下文丢失。
 * - 用 content 字符数近似 token 预算。
 *
 * 空输入不崩；失败一律 { ok:false, error }。错误码见 CONTRACTS §6.1。
 */

import type { ExecuteResult } from './types';

export interface HistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface CompressInput {
  history: HistoryMessage[];
  budget?: number; // 字符预算，默认 4000
  recentWindow?: number; // 末尾保留原文条数，默认 4
}

const DEFAULT_BUDGET = 4000;
const DEFAULT_WINDOW = 4;

function ok(data: unknown): ExecuteResult {
  return { ok: true, data };
}
function fail(error: string): ExecuteResult {
  return { ok: false, error };
}

function sizeOf(msgs: HistoryMessage[]): number {
  let n = 0;
  for (const m of msgs) n += (m.content || '').length + m.role.length;
  return n;
}

export async function compressHistory(input: CompressInput): Promise<ExecuteResult> {
  if (!Array.isArray(input.history)) {
    return fail('invalid-argument');
  }
  const budget =
    typeof input.budget === 'number' && input.budget > 0 ? Math.floor(input.budget) : DEFAULT_BUDGET;
  const window =
    typeof input.recentWindow === 'number' && input.recentWindow > 0
      ? Math.floor(input.recentWindow)
      : DEFAULT_WINDOW;

  const history = input.history;
  if (sizeOf(history) <= budget) {
    return ok({
      messages: history,
      dropped: 0,
      compressed: false,
      inputChars: sizeOf(history),
      outputChars: sizeOf(history),
    });
  }

  // system 消息永远前置保留
  const systemMsgs = history.filter((m) => m.role === 'system');
  const nonSystem = history.filter((m) => m.role !== 'system');

  // 末尾窗口：最近 window 条原文
  const recent = nonSystem.slice(-window);
  const older = nonSystem.slice(0, Math.max(0, nonSystem.length - window));

  const olderUserMsgs = older.filter((m) => m.role === 'user');
  const firstUser = olderUserMsgs[0];
  const summary: HistoryMessage = {
    role: 'system',
    content: `[历史摘要] 此前共 ${older.length} 条消息（user ${olderUserMsgs.length} 条）已折叠；` +
      (firstUser ? `最早请求：${firstUser.content.slice(0, 120)}` : ''),
  };

  const messages = [...systemMsgs, summary, ...recent];
  // 若仍超预算，截断最近 assistant 尾部（保底不崩）
  let outputChars = sizeOf(messages);
  if (outputChars > budget) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (outputChars <= budget) break;
      const m = messages[i];
      if (m.role !== 'user' && m.content.length > 200) {
        const keep = Math.max(100, budget - (outputChars - m.content.length));
        outputChars -= m.content.length;
        m.content = m.content.slice(0, keep) + ' …[截断]';
        outputChars += m.content.length;
      }
    }
  }

  return ok({
    messages,
    dropped: older.length,
    compressed: true,
    inputChars: sizeOf(history),
    outputChars,
  });
}
