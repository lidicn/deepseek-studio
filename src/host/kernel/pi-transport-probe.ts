/**
 * pi-transport-probe.ts — M1-3 最小探针
 *
 * 目的：不接真模型、不接 web-engine，构造一个假的 StreamFn（脚本化 delta 序列），
 * 喂给 pi-agent-core 的 Agent，看一个 turn 能不能跑通。
 *
 * 硬约束（见 goal 卡 §3.2）：
 *   - 不 import web-engine.ts / agent-loop.ts
 *   - 不发任何网络请求
 *   - 只 import pi 的类型
 */

import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';

// ---------------------------------------------------------------- fakes

const FAKE_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeModel(): Model<any> {
  return {
    id: 'probe-fake',
    name: 'Probe Fake',
    api: 'openai-completions',
    provider: 'probe',
    baseUrl: 'http://localhost',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function makeAssistantMessage(text: string): Extract<AgentMessage, { role: 'assistant' }> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'probe',
    model: 'probe-fake',
    usage: FAKE_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/**
 * 脚本化 StreamFn：返回一个立刻产出 "probe: ok" 然后 done 的事件流。
 * 不发任何网络请求。
 */
export function scriptedStreamFn(text = 'probe: ok'): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    const partial = makeAssistantMessage('');
    stream.push({ type: 'start', partial: { ...partial, content: [] } });
    stream.push({ type: 'text_start', contentIndex: 0, partial: { ...partial, content: [{ type: 'text', text: '' }] } });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: { ...partial, content: [{ type: 'text', text }] } });
    stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: { ...partial, content: [{ type: 'text', text }] } });
    const finalMsg = makeAssistantMessage(text);
    stream.push({ type: 'done', reason: 'stop', message: finalMsg });
    stream.end(finalMsg);
    return stream;
  };
}

/** 一个 stub 工具，证明 AgentTool 形状能被构造出来。 */
export function stubTool(): AgentTool {
  return {
    name: 'probe.echo',
    description: 'probe-only echo',
    parameters: { type: 'object', properties: {} } as never,
    label: 'Probe Echo',
    async execute(_id, _params) {
      return {
        content: [{ type: 'text', text: 'echoed' }],
        details: {},
        isError: false,
      };
    },
  };
}

export interface ProbeRunResult {
  events: string[];
  finalText: string;
  ok: boolean;
}

/**
 * 跑一个 turn：prompt("hello") → 等 agent_end。
 * 返回事件类型序列和最终文本。
 */
export async function runProbeTurn(): Promise<ProbeRunResult> {
  const events: string[] = [];
  const streamFn = scriptedStreamFn();

  const agent = new Agent({
    streamFn,
    initialState: {
      systemPrompt: 'probe',
      model: fakeModel(),
      tools: [stubTool()],
    },
    convertToLlm: (msgs: AgentMessage[]) => msgs as never,
  });

  agent.subscribe((event) => {
    events.push(event.type);
  });

  await agent.prompt('hello');
  await agent.waitForIdle();

  const lastAssistant = [...agent.state.messages].reverse().find(
    (m) => m.role === 'assistant',
  );
  const text = lastAssistant
    ? (lastAssistant.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
    : '';

  return { events, finalText: text, ok: events.includes('agent_end') };
}
