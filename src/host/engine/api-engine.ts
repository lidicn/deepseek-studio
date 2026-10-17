/**
 * ApiEngine（S10）：OpenAI 兼容 /v1/chat/completions 的最小实现。
 * 不引第三方 SDK，只用原生 fetch。
 */

import type { CompletionStatus, EngineSendResult, ModelEngine } from './model-engine';

export interface ApiEngineConfig {
  baseURL: string;      // e.g. https://api.deepseek.com
  apiKey: string;
  model: string;        // e.g. deepseek-chat
  provider?: 'deepseek' | 'openai' | 'anthropic' | 'ollama';
  /** S25：请求超时 ms（默认 120000）。 */
  timeoutMs?: number;
}

export interface ApiEngineOptions {
  config: ApiEngineConfig;
  /** 测试注入 mock fetch。 */
  fetchImpl?: typeof fetch;
  /** S20：流式 delta 回调。 */
  onDelta?: (text: string) => void;
}

/** S20：纯函数——解析 SSE 文本，提取所有 delta content。 */
export function parseSSEStream(raw: string): string[] {
  const deltas: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) deltas.push(delta);
    } catch {
      // skip malformed lines
    }
  }
  return deltas;
}

export function createApiEngine(options: ApiEngineOptions): ModelEngine {
  const cfg = options.config;
  const doFetch = options.fetchImpl ?? fetch;

  function finishReasonToCompletion(reason: string | null | undefined): CompletionStatus {
    // S14：各家 finish_reason 语义归一化
    switch (reason) {
      case 'stop':
      case 'end_turn':      // Anthropic
      case 'stop_sequence':  // Anthropic
        return 'complete';
      case 'length':
      case 'max_tokens':     // Anthropic
        return 'truncated';
      case 'tool_calls':     // 工具调用结束，视为 complete（工具结果由外部回填）
        return 'complete';
      default:
        return 'unknown';
    }
  }

  return {
    name: 'api',
    async health(): Promise<{ ok: boolean; reason?: string }> {
      try {
        const r = await doFetch(`${cfg.baseURL}/models`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
        if (r.ok) return { ok: true };
        return { ok: false, reason: `HTTP ${r.status}` };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    },
    async send(text: string): Promise<EngineSendResult> {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 120_000);
        const r = await doFetch(`${cfg.baseURL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'user', content: text }],
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!r.ok) {
          return { content: '', toolCalls: 0, completion: 'disconnected' };
        }
        const data = await r.json() as {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
        };
        const choice = data.choices?.[0];
        const content = choice?.message?.content ?? '';
        return {
          content,
          toolCalls: 0,
          completion: finishReasonToCompletion(choice?.finish_reason),
        };
      } catch (e) {
        return { content: '', toolCalls: 0, completion: 'disconnected', timedOut: true };
      }
    },
  };
}
