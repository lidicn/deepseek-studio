/**
 * 兼容性转换：上游 delta ↔ OpenAI SSE 形状
 *
 * 关键映射（需求稿 D）：推理内容只出现在 reasoning_content 字段，不混入 content；
 * 收工以 finish_reason='stop' 的空 delta 块结束。non-stream 时合并为单条 chat.completion。
 */

import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from './types';

export function formatSSE(chunk: ChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const SSE_DONE = `data: [DONE]\n\n`;

export function emptyDelta(model: string, id = 'cmpl'): ChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    model,
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };
}

export function chunksToResponse(chunks: ChatCompletionChunk[], req: ChatCompletionRequest): ChatCompletionResponse {
  let content = '';
  let reasoning = '';
  const model = chunks[0]?.model ?? req.model;
  for (const c of chunks) {
    const d = c.choices[0]?.delta;
    if (d?.content) content += d.content;
    if (d?.reasoning_content) reasoning += d.reasoning_content;
  }
  return {
    id: 'cmpl-local',
    object: 'chat.completion',
    model,
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
      },
    ],
  };
}

/** 判断是否为「未实现」路由（返回 501）。 */
export function isUnimplementedPath(pathname: string): boolean {
  return pathname === '/v1/embeddings' || pathname === '/v1/audio';
}
