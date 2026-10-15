/**
 * AgentLoop 状态机（M1）
 *
 * 编排「发消息 → 等回复 → 是否发生工具调用 → 续跑」的多步循环。
 * 关键决策：本模块**不解析工具标签**——工具执行完全走已验证的 v0.6 链路
 * （页面拦截器 → hub → 完整授权链），这里只依据引擎返回的 toolCalls 计数决策续跑。
 * 这消除了「宿主与拦截器双重解析/双重执行」的风险。
 *
 * 护栏：
 *   - max_steps：一个用户消息最多续跑 N 步（默认 15），防模型死循环
 *   - stop()：随时中断（上下文保留在聊天页，可再次发送继续）
 *   - 格式纠偏：回复里出现未被解析器消费的原始工具标签 → 发一次纠偏提示（每步最多一次）
 *
 * 所有事件经 onEvent 推给面板（user/assistant/tool/status/error/done）。
 */

import type { EngineSendResult, ModelEngine } from './engine/model-engine';
import { waitBetweenRequests } from '../inject/step-control';

export const AGENT_SENTINEL = '【Studio Agent】';

export const DEFAULT_CONTINUE_NUDGE =
  `${AGENT_SENTINEL}工具已执行完毕，结果已回填。请根据工具结果继续完成任务；` +
  '若任务已完成，直接给出最终回答，不要再调用工具。';

export const FORMAT_CORRECTION_NUDGE =
  `${AGENT_SENTINEL}刚才的回复里包含未能解析的工具调用（JSON 可能不合法）。` +
  '请严格按以下格式重新发起一次工具调用，标签体必须是合法 JSON（键用双引号）：\n' +
  '<local_file_read>{"path":"绝对路径"}</local_file_read>\n' +
  '<local_file_write>{"path":"绝对路径","content":"文本"}</local_file_write>\n' +
  '<shell_exec>{"command":"命令行"}</shell_exec>';

/** 未被解析器消费的原始工具标签（出现即说明 JSON 解析失败，需要纠偏）。
 *  用非贪婪 [\s\S]*? 替代 [^<]*，允许标签体内含 <（如写 HTML、命令重定向）。 */
const RAW_TOOL_TAG_RE = /<(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>[\s\S]*?<\/(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>/;

export type AgentEventType = 'user' | 'assistant' | 'tool' | 'status' | 'error' | 'done';

export interface AgentLoopEvent {
  type: AgentEventType;
  /** 文本内容（user/assistant/error）或状态说明（status/tool）。 */
  text?: string;
  /** 当前步数（从 1 开始）。 */
  step?: number;
  /** 本轮发生的工具调用次数（tool 事件）。 */
  toolCalls?: number;
  /** v0.23：事件来源 bot 标识。缺省=主 bot（向后兼容现有面板）。 */
  botId?: string;
  /** v0.28：聊天室房间标识。聊天室驱动的 send 带上；日常对话不带（undefined）。
   *  供 UI 按 roomId 过滤当前房间事件（多房间隔离）。 */
  roomId?: string;
}

export interface AgentLoopOptions {
  engine: ModelEngine;
  /** 事件出口（面板经 WS 订阅）。 */
  onEvent(event: AgentLoopEvent): void;
  /** 单个用户消息的最大续跑步数（默认 25）。 */
  maxSteps?: number;
  /** v1.6：单个用户消息的全局看门狗（默认 15 分钟），超时强制结束 send，防永久卡死。 */
  watchdogMs?: number;
  continueNudge?: string;
  /**
   * 共享停止旗标：WebEngine.isStopped 读它实现等待中断；
   * 由宿主装配方创建并传给引擎与 loop 两处。
   */
  stopFlag: { stopped: boolean };
  /** P0：两次工具续跑之间是否随机延迟 2.5-6.5s（防风控）。测试传 false 跳过。 */
  throttleBetweenSteps?: boolean;
  /** v0.23：本 loop 所属 bot 标识。戳到每条事件的 botId 上，缺省=主 bot。 */
  botId?: string;
}

export interface AgentLoop {
  /** 处理一条用户消息；完成（或中断）后 resolve。同一时间只允许一个活跃回合。
   *  v0.28：opts.roomId 聊天室驱动的 send 带上，戳到每条事件供 UI 按 roomId 过滤。 */
  send(text: string, opts?: { roomId?: string }): Promise<void>;
  stop(): void;
  readonly running: boolean;
}

export function createAgentLoop(options: AgentLoopOptions): AgentLoop {
  const maxSteps = options.maxSteps ?? 25;
  const watchdogMs = options.watchdogMs ?? 15 * 60 * 1000;
  const continueNudge = options.continueNudge ?? DEFAULT_CONTINUE_NUDGE;
  const botId = options.botId;
  let active = false;
  // v0.28：本轮 send 的 roomId（聊天室驱动时设置，日常对话为 undefined）。
  // emit 把它戳到每条事件上，供 UI 按 roomId 过滤（多房间隔离）。
  let currentRoomId: string | undefined;

  const emit = (event: AgentLoopEvent): void => {
    const stamped: AgentLoopEvent = botId ? { ...event, botId } : { ...event };
    if (currentRoomId !== undefined) stamped.roomId = currentRoomId;
    options.onEvent(stamped);
  };

  return {
    get running() {
      return active;
    },
    stop() {
      options.stopFlag.stopped = true;
    },
    async send(text: string, opts?: { roomId?: string }): Promise<void> {
      if (active) throw new Error('agent-busy');
      active = true;
      currentRoomId = opts?.roomId;
      options.stopFlag.stopped = false;
      // v1.6：全局看门狗——任意 send 挂起超过 watchdogMs 强制复位 active，防永久 agent-busy
      const watchdog = setTimeout(() => {
        if (active) {
          options.stopFlag.stopped = true;
          emit({ type: 'error', text: `全局看门狗触发（${Math.round(watchdogMs / 60000)} 分钟），强制结束本次循环` });
          emit({ type: 'done' });
          active = false;
          options.stopFlag.stopped = false;
        }
      }, watchdogMs);
      emit({ type: 'user', text });

      // v1.6：纠偏次数计数 —— 连续纠偏仍见原始工具标签说明页端解析失效，停止避免死循环
      let correctionAttempts = 0;
      const MAX_CORRECTION_ATTEMPTS = 3;

      try {
        emit({ type: 'status', text: '已发送，等待模型回复…', step: 1 });
        let result: EngineSendResult = await options.engine.send(text);
        let hitLimit = false;

        for (let step = 1; step <= maxSteps; step++) {
          if (options.stopFlag.stopped) {
            emit({ type: 'status', text: '已被用户停止（上下文保留，可继续）', step });
            break;
          }
          if (result.timedOut) {
            emit({ type: 'error', text: `模型回复等待超时（看门狗兜底），已返回的部分内容可能不完整`, step });
          }

          // 原始工具标签泄漏 → JSON 解析失败，纠偏一次（计一步）
          if (result.toolCalls === 0 && RAW_TOOL_TAG_RE.test(result.content)) {
            correctionAttempts += 1;
            if (correctionAttempts > MAX_CORRECTION_ATTEMPTS) {
              // 连续纠偏失败：页端拦截器未解析工具标签，继续纠偏只会死循环
              emit({ type: 'error', text: `连续 ${MAX_CORRECTION_ATTEMPTS} 次纠偏后模型仍输出未解析工具标签。页端拦截器可能未正确加载（尝试刷新 DeepSeek 页面）。停止循环。`, step });
              break;
            }
            emit({ type: 'status', text: `检测到未解析的工具调用，发送格式纠偏（第 ${correctionAttempts} 次）…`, step });
            result = await options.engine.send(FORMAT_CORRECTION_NUDGE);
            continue;
          }

          if (result.toolCalls > 0) {
            emit({ type: 'tool', text: `工具执行完成（${result.toolCalls} 次调用）`, step, toolCalls: result.toolCalls });
            if (step === maxSteps) {
              emit({ type: 'error', text: `已达最大步数（${maxSteps}）上限，自动停止。可发送「继续」让模型接着做`, step });
              hitLimit = true;
              break;
            }
            // v0.9：页端 POW auto-continue 是唯一续跑权威，宿主只等待结果，不再发 continueNudge
            emit({ type: 'status', text: '工具结果已回填，等待页端续跑…', step: step + 1 });
            // P0：两次请求之间随机 2.5-6.5s 节流，避免触发风控（测试可关）
            if (options.throttleBetweenSteps !== false) {
              await waitBetweenRequests(new AbortController().signal);
            }
            if (options.engine.waitForNextReply) {
              result = await options.engine.waitForNextReply();
            } else {
              // 降级：引擎不支持 waitForNextReply 时，发一个最小 nudge 触发回复
              result = await options.engine.send(continueNudge);
            }
            continue;
          }

          // 无工具调用 → 最终回答
          emit({ type: 'assistant', text: result.content, step });
          break;
        }

        if ((!result.content || result.content.length === 0) && !hitLimit && !options.stopFlag.stopped) {
          // 循环走完仍没有可见文本（如首步就被超时且无内容）
          emit({ type: 'error', text: '本轮未取得模型回复（页面未连接或回复为空）' });
        }
        emit({ type: 'done' });
      } catch (err) {
        emit({ type: 'error', text: err instanceof Error ? err.message : String(err) });
        emit({ type: 'done' });
      } finally {
        clearTimeout(watchdog);
        active = false;
        currentRoomId = undefined;
        options.stopFlag.stopped = false;
      }
    },
  };
}
