/**
 * 上游后端适配
 *
 * 本文件只提供 fake backend：studio 不持有 API key，真实模型调用走页面会话
 * （chat.deepseek.com 的 web 登录态），本地 8760 API 面是给局域网 agent 接入的 stub。
 *
 * 曾有 createUpstreamOfficialBackend() 经动态 import 读内嵌 dpp 快照的 official-api，
 * 三条证据表明它从未生效，已随快照一并移除（见 docs/dpp/上游快照锚点-UPSTREAM.md）：
 *  - tsconfig 别名与实际说明符拼接后指向 deepseek-pp/src/src/...（不存在）；
 *  - 全仓零调用者，运行时恒用 createFakeOfficialBackend；
 *  - 变量形式的动态 import 躲过静态检查，所以 typecheck 也不报。
 * 若将来要接真实上游客户端，正确路径是把上游 core 发布为可依赖的包（或独立构建产物），
 * 而不是跨仓库 import 源码——该待办登记在项目总路线图 M7（真实 API key 缺项）。
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
