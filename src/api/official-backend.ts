/**
 * 上游后端适配
 *
 * 真实实现经动态 import 接入 deepseek-pp/src/core/deepseek/official-api.ts（OpenAI 兼容客户端），
 * 把其流式 delta 转成 ChatCompletionChunk。测试注入 fake backend，不加载上游。
 */

import type { ChatCompletionChunk, ChatCompletionRequest } from './types';

export interface OfficialBackend {
  chatCompletion(req: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<ChatCompletionChunk>;
  models(): Promise<string[]>;
}

export function createFakeOfficialBackend(opts: { chunks?: ChatCompletionChunk[]; models?: string[] } = {}): OfficialBackend {
  const chunks = opts.chunks ?? [
    chunk('m', 'Hello'),
    chunk('m', ' world'),
  ];
  return {
    async *chatCompletion() {
      for (const c of chunks) yield c;
    },
    async models() {
      return opts.models ?? ['deepseek-chat'];
    },
  };
}

export function chunk(model: string, content: string, reasoning?: string): ChatCompletionChunk {
  return {
    id: 'fake',
    object: 'chat.completion.chunk',
    model,
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }],
  };
}

export async function createUpstreamOfficialBackend(): Promise<OfficialBackend> {
  const spec = 'deepseek-pp/src/core/deepseek/official-api';
  const mod = (await import(spec)) as unknown as {
    createOfficialApiClient: (...args: unknown[]) => {
      chatCompletion: (req: ChatCompletionRequest, signal?: AbortSignal) => AsyncIterable<ChatCompletionChunk>;
      models: () => Promise<string[]>;
    };
  };
  const client = mod.createOfficialApiClient();
  return {
    chatCompletion: (req, signal) => client.chatCompletion(req, signal),
    models: () => client.models(),
  };
}
