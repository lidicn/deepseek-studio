/**
 * Workbench 类型契约（§10.2 / §10.8 / §10.9）
 *
 * 不重复定义 PolicyMode / AgentLoopEvent / ToolRunEvent，一律从 shared 真源 re-export。
 */
import type { PolicyMode } from '../../shared/policy-contract';
import type { AgentLoopEvent } from '../../shared/agent-loop-event';
import type { ToolRunEvent } from '../../shared/tool-run-event';

export type { PolicyMode, AgentLoopEvent, ToolRunEvent };

/** §10.8 connection 四态，只由 WS 事件驱动。 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'auth-failed';

/** §10.7 响应式断点区间。 */
export type WorkbenchLayout = 'wide' | 'medium' | 'compact' | 'desktop-only';

export interface BotDescriptor {
  botId: string;
  running: boolean;
}

/** §10.9 客户端可发的请求类型（走 /agent-ws 的 set-policy，不调 callHostTool）。 */
export type WorkbenchRequest =
  | { type: 'send'; text: string; reqId: string }
  | { type: 'stop'; reqId: string }
  | { type: 'set-policy'; mode: PolicyMode; reqId: string }
  | { type: 'set-workspace'; path: string; reqId: string }
  | { type: 'pick-folder'; reqId: string }
  | { type: 'get-state'; reqId: string };

/** 服务端 {type:'state'} 载荷（§10.9）。 */
export interface StatePayload {
  type: 'state';
  policyMode: PolicyMode;
  panelModes: readonly PolicyMode[];
  workspaceRoot: string | null;
  running: boolean;
  bots?: BotDescriptor[];
}

/** 服务端 {type:'ack'} 结果。 */
export interface AckPayload {
  type: 'ack';
  reqId?: string;
  ok: boolean;
  data?: { path?: string | null };
  error?: string;
}
