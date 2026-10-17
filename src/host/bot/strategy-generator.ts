/**
 * 会议策略生成器（v0.29 · Claude 主开发）
 *
 * 会议开始时，主 bot 依据「用户给的会议主题 + 房间成员」生成结构化 MeetingStrategy
 * （自动总结阈值 + 议题 + 摘要风格），持久化后注入各 bot 人设指令。
 *
 * 复用 createModelSummarizer（chat-room-runtime.ts:220-258）的 agentSender 模式：
 *   拼 prompt → bot.loop.send(AGENT_SENTINEL + prompt) → 临时 listener 按 botId
 *   过滤捕获 assistant 文本 → JSON.parse + 宽松校验 → 返回 MeetingStrategy。
 *
 * fail-soft 是硬约束：主 bot 不可用 / 超时 / 返回非 JSON / 字段非法 —— 一律回落到
 * defaultMeetingStrategy(topic)，绝不阻塞会议开启。策略是优化项不是门控项。
 *
 * 边界：不 import desktop-host，不触碰 CB 的 instructions.ts / room-summary.ts。
 * 衔接面见 plan buzzing-puzzling-deer.md（v0.29 会议生命周期）。
 */

import type { AgentLoopEvent } from '../agent-loop';
import { AGENT_SENTINEL } from '../agent-loop';
import type { BotRegistryInternal } from './registry';
import type { MeetingStrategy, RoomConfig } from './types';
import { defaultMeetingStrategy, parseMeetingStrategy } from './meeting-state';

/** 事件订阅器形状（接 desktop-host 的 agentListeners，同 createModelSummarizer）。 */
type AgentEventBus = (cb: (event: AgentLoopEvent) => void) => () => void;

export interface StrategyGeneratorDeps {
  readonly registry: BotRegistryInternal;
  readonly onAgentEvent: AgentEventBus;
  /** 产策略的 botId，缺省 'main'（主 bot 掌控摘要时机）。 */
  readonly botId?: string;
  /** 超时毫秒；缺省 20s（主 bot 慢但不能无限等）。 */
  readonly timeoutMs?: number;
}

export type StrategyGenerator = (topic: string, room: RoomConfig) => Promise<MeetingStrategy>;

/**
 * 产策略生成器。返回的函数纯异步、可重入；每次调用独立 listener + 超时。
 *
 * 用法：`const gen = createStrategyGenerator({ registry, onAgentEvent });`
 *       `const strategy = await gen('后端接口契约', room);`
 */
export function createStrategyGenerator(deps: StrategyGeneratorDeps): StrategyGenerator {
  const { registry, onAgentEvent } = deps;
  const botId = deps.botId ?? 'main';
  const timeoutMs = deps.timeoutMs ?? 20000;

  return async (topic: string, room: RoomConfig): Promise<MeetingStrategy> => {
    const cleanTopic = (topic ?? '').trim();

    const bot = registry.get(botId);
    if (!bot) return defaultMeetingStrategy(cleanTopic);

    const memberNames = room.memberPersonas.join('、') || '（无其他成员）';
    const prompt = buildStrategyPrompt(cleanTopic, room.roomName, memberNames);

    let raw = '';
    const listener = (event: AgentLoopEvent): void => {
      if (event.botId === botId && event.type === 'assistant' && event.text) {
        raw = event.text;
      }
    };
    const unsub = onAgentEvent(listener);

    // 超时：主 bot 卡住或 web engine 无回复时，到点回落默认，不卡死会议开启。
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
    });

    try {
      // 与 createModelSummarizer 同：放行 chat-insert/chat-send，loop.send 触发主 bot 回复。
      const state = registry.getState(botId);
      state?.sessionAllowlist.addPermanent('chat-insert');
      state?.sessionAllowlist.addPermanent('chat-send');

      const sendP = bot.loop.send(`${AGENT_SENTINEL}${prompt}`);
      const raced = await Promise.race([sendP, timeout]);
      if (raced === '__timeout__') {
        return defaultMeetingStrategy(cleanTopic);
      }

      if (!raw) return defaultMeetingStrategy(cleanTopic);
      return parseStrategyOutput(raw, cleanTopic);
    } catch {
      // loop.send 抛错 / 任何意外 → 兜底，不阻塞会议。
      return defaultMeetingStrategy(cleanTopic);
    } finally {
      unsub();
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * 拼「让主 bot 产结构化策略」的 prompt。
 * 要求严格 JSON 输出 + 字段说明 + 主题/成员上下文。
 */
function buildStrategyPrompt(topic: string, roomName: string, memberNames: string): string {
  const topicLine = topic ? `本次会议主题：${topic}` : '本次会议无明确主题，请据讨论方向自行归纳 1-3 个议题';
  return [
    '你是聊天室主持人。请为本次会议制定结构化总结策略，用于决定何时自动总结。',
    topicLine,
    `房间：${roomName}`,
    `参与成员：${memberNames}`,
    '',
    '请只输出一个 JSON 对象（不要 markdown 代码块、不要多余文字），字段如下：',
    '  "focusTopics": string[]   —— 本次会议重点跟踪的议题（1-3 个，简短）',
    '  "minRoundsBeforeAutoSummary": number —— 累计多少轮「有 bot 回复」的讨论后自动触发一次摘要',
    '                                          （建议 2-5：短讨论取 2，深度设计取 5；不低于 1）',
    '  "summaryStyle": string    —— 摘要风格提示（可选，如"分议题罗列结论与待定项"）',
    '',
    '示例：{"focusTopics":["接口契约","错误码"],"minRoundsBeforeAutoSummary":3,"summaryStyle":"分议题罗列"}',
  ].join('\n');
}

/**
 * 从主 bot 原始输出解析 MeetingStrategy。
 * 宽松：剥离 markdown 代码围栏 → JSON.parse → parseMeetingStrategy 宽松校验 → 兜底。
 */
function parseStrategyOutput(raw: string, fallbackTopic: string): MeetingStrategy {
  const text = stripCodeFence(raw).trim();
  if (!text) return defaultMeetingStrategy(fallbackTopic);

  // 模型可能前后带说明文字，尝试定位首个 { 到末尾 } 的子串。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return defaultMeetingStrategy(fallbackTopic);

  const slice = text.slice(start, end + 1);
  try {
    const obj = JSON.parse(slice);
    return parseMeetingStrategy(obj, fallbackTopic);
  } catch {
    return defaultMeetingStrategy(fallbackTopic);
  }
}

/** 剥离 ```json ... ``` / ``` ... ``` 围栏（模型常见行为）。 */
function stripCodeFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1] : text;
}
