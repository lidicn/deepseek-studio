/**
 * 本地 HTTP API · 类型
 *
 * 暴露 OpenAI 兼容的 /v1/chat/completions（支持 SSE 流式）与 /v1/models，供桌面宿主内
 * 的 agent loop / 第三方客户端通过 http://127.0.0.1:8760 调用（端口从 8756 改 8760，避开豆包沙箱）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning_content?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  model: string;
  created: number;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  model: string;
  created: number;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string; reasoning_content?: string };
    finish_reason?: string | null;
  }>;
}

export interface ApiConfig {
  port: number;
  host: string;
  token: string;
}

export interface QueueStatus {
  queued: number;
  active: number;
  /** v0.5 5.3 可观测性扩展（保留 queued/active 以兼容既有消费者）。 */
  maxConcurrent: number;
  /** 当前排队深度。 */
  depth: number;
  /** 近期平均等待毫秒。 */
  avgWaitMs: number;
  /** 最近若干次执行的等待与结果。 */
  recent: Array<{ startedAt: number; endedAt?: number; ok?: boolean; waitMs: number }>;
}
