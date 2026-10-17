/**
 * src/shared/agent-loop-event.ts — agent loop 结构化事件类型（跨层共享）。
 *
 * 上移至此的原因：src/shared/harness-metrics 要消费该事件做指标聚合，
 * 而 shared 不许反向 import host（边界规则 R3）。定义下沉到 shared，
 * host/agent-loop 再 re-export，既有 import 路径不受影响。
 */

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
