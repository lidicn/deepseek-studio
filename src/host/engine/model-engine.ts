/**
 * 模型引擎抽象（M1）
 *
 * AgentLoop 只面向本接口，不关心底层是网页引擎还是官方 API：
 *   - WebEngine：驱动 chat.deepseek.com 页面当模型（免费，XML 工具标签协议）
 *   - ApiEngine：DeepSeek 官方 API（原生 function calling，M3 落地）
 *
 * 引擎差异（工具调用协议、重试策略）全部隔离在各自实现内；
 * send() 返回的 content 已经是「本轮回复的可见文本」，toolCalls 是本轮发生的工具调用次数。
 */

/** 一次引擎调用期间发生的工具调用记录（供面板展示与审计）。 */
export interface ToolCallRecord {
  readonly tool: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** S2：本轮完成状态自证。 */
export type CompletionStatus = 'complete' | 'truncated' | 'disconnected' | 'unknown';

export interface EngineSendResult {
  /** 本轮模型回复的可见文本（工具标签已被拦截器摘除）。 */
  readonly content: string;
  /** 本轮发生（并已由宿主执行）的工具调用条数。 */
  readonly toolCalls: number;
  /** 看门狗超时被截断的回复（内容可能不完整，调用方决定是否提示用户）。 */
  readonly timedOut?: boolean;
  /**
   * 本轮工具调用的结构化记录（M2-2 additive）。
   * 仅当引擎在创建时传入了 onToolCall 回调时才会填充；
   * 老调用方继续读 toolCalls 数字即可，此字段对老代码完全透明。
   */
  readonly toolCallRecords?: readonly ToolCallRecord[];
  /**
   * S2：本轮完成状态自证。老调用方不读此字段则完全无感知。
   *   complete     — 模型正常输出完毕
   *   truncated    — 看门狗截断（timedOut 的语义化别名）
   *   disconnected — 页端不可达 / dispatch 失败
   *   unknown      — 兜底（用户主动 stop 等）
   */
  readonly completion?: 'complete' | 'truncated' | 'disconnected' | 'unknown';
}

export interface ModelEngine {
  readonly name: 'web' | 'api';
  /** 引擎可用性探测（网页引擎：页面已连接且能读到对话）。 */
  health(): Promise<{ ok: boolean; reason?: string }>;
  /**
   * 发送一条消息并等模型回复结束。
   * 实现负责：注入文本 → 触发发送 → 完成检测（稳定性启发式 + 看门狗）。
   */
  send(text: string): Promise<EngineSendResult>;
  /**
   * 不发消息，只轮询等待下一条回复（由页端 auto-continue 触发）。
   * v0.9：页端 POW auto-continue 是唯一续跑权威，宿主不再发 continueNudge。
   */
  waitForNextReply?(): Promise<EngineSendResult>;
}

/** ApiEngine 占位（M3）：只提供明确的「未实现」语义，避免误用。 */
export function createApiEngineStub(): ModelEngine {
  return {
    name: 'api',
    async health() {
      return { ok: false, reason: 'api-engine-not-implemented (M3)' };
    },
    async send(): Promise<EngineSendResult> {
      throw new Error('api-engine-not-implemented (M3)：请切换到网页引擎');
    },
  };
}
