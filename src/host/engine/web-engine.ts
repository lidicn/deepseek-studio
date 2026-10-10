/**
 * 网页模型引擎（M1）：把 chat.deepseek.com 页面当作无头模型用。
 *
 * 链路：chat-insert（写入文本）→ chat-send（触发发送）→ 轮询 chat-read 做完成检测。
 * 工具调用不走这里——页面内拦截器流式解析工具标签 → ws 反向投递 → hub 执行
 * （完整授权链）→ 结果存入拦截器 pending → 下一次出站请求自动回填。
 * 引擎只负责「发消息 + 等回复 + 报告期间发生了几次工具调用」。
 *
 * 完成检测：快照连续 2 次稳定（间隔 pollIntervalMs）且与发送前基线不同，即认为回复结束；
 * 单步看门狗（默认 120s）兜底，超时把已见文本带 timedOut 标记返回。
 */

import type { ExecuteResult } from '../../capabilities/types';
import type { EngineSendResult, ModelEngine } from './model-engine';

export interface WebEngineOptions {
  /** 页端 DOM 能力调用入口（desktop-host.invokeTool：完整授权链 + 同意闸门）。 */
  dispatch(tool: string, params: Record<string, unknown>): Promise<ExecuteResult>;
  /** 工具调用计数器（由 desktop-host 的 hub.onToolCall 累加）。 */
  toolCallCounter: { current: number };
  /** 完成检测轮询间隔（默认 1500ms）。 */
  pollIntervalMs?: number;
  /** 单步看门狗（默认 120_000ms）。 */
  stepTimeoutMs?: number;
  /** 中止钩子：AgentLoop.stop() 置位后，等待中的 send 尽快返回。 */
  isStopped?(): boolean;
}

export interface WebEngine extends ModelEngine {}

export function createWebEngine(options: WebEngineOptions): WebEngine {
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const stepTimeoutMs = options.stepTimeoutMs ?? 120_000;

  async function readLastMessage(): Promise<{ text: string; count: number } | null> {
    const r = await options.dispatch('chat-read', {});
    if (!r.ok) return null;
    const data = r.data as { count?: number; messages?: { text: string }[] } | undefined;
    const messages = data?.messages ?? [];
    const last = messages.at(-1);
    return { text: last?.text ?? '', count: data?.count ?? 0 };
  }

  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  return {
    name: 'web',
    async health() {
      const r = await options.dispatch('chat-read', {});
      if (r.ok) return { ok: true };
      return { ok: false, reason: r.error ?? 'chat-read-failed' };
    },
    async send(text: string): Promise<EngineSendResult> {
      // 工具调用计数从本轮起点清零
      const counterStart = options.toolCallCounter.current;

      const ins = await options.dispatch('chat-insert', { text });
      if (!ins.ok) return { content: '', toolCalls: 0 };
      const sent = await options.dispatch('chat-send', {});
      if (!sent.ok) return { content: '', toolCalls: 0 };

      const baseline = await readLastMessage();
      const baselineText = baseline?.text ?? '';
      const startedAt = Date.now();

      let prevSnapshot: string | null = null;
      let stableHits = 0;
      let lastText = '';
      let timedOut = false;

      for (;;) {
        if (options.isStopped?.()) break;
        if (Date.now() - startedAt > stepTimeoutMs) {
          timedOut = true;
          break;
        }
        await sleep(pollIntervalMs);
        const snap = await readLastMessage();
        if (!snap) continue; // 单次读取失败：继续轮询，看门狗兜底
        lastText = snap.text;
        if (lastText !== baselineText && lastText.length > 0 && lastText === prevSnapshot) {
          stableHits += 1;
          // 连续两次轮询（间隔 pollIntervalMs）快照一致 → 回复结束
          if (stableHits >= 2) break;
        } else {
          stableHits = 0;
        }
        prevSnapshot = lastText;
      }

      const toolCalls = options.toolCallCounter.current - counterStart;
      return { content: lastText, toolCalls, timedOut: timedOut || undefined };
    },
  };
}
