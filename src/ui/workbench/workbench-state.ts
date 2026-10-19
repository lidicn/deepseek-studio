/**
 * WorkbenchState（严格 §10.8，字段不得自行增加）+ 纯 reducer。
 *
 * 规则（§10.8）：
 * - connection 只由 WS 事件驱动（open / close / 1008）。
 * - running 只由 state / done / error 驱动，UI 不自行猜。
 * - 断线后禁用发送/停止，显示「连接断开，重试中」。
 * - 1008 鉴权失败显示「鉴权失败，请重启应用」，不自动重连。
 */
import { TERMINAL_PHASES, type ToolRunEvent } from '../../shared/tool-run-event';
import type { AgentLoopEvent } from '../../shared/agent-loop-event';
import type { PolicyMode } from '../../shared/policy-contract';
import { DEFAULT_POLICY_MODE } from '../../shared/policy-contract';
import type {
  ConnectionState,
  StatePayload,
  BotDescriptor,
} from './workbench-types';

export interface WorkbenchState {
  connection: ConnectionState;
  running: boolean;
  workspaceRoot: string | null;
  policyMode: PolicyMode;
  bots: BotDescriptor[];
  events: AgentLoopEvent[];
  toolRuns: ToolRunEvent[];
  lastError: string | null;
}

export function createInitialState(): WorkbenchState {
  return {
    connection: 'connecting',
    running: false,
    workspaceRoot: null,
    policyMode: DEFAULT_POLICY_MODE,
    bots: [],
    events: [],
    toolRuns: [],
    lastError: null,
  };
}

/** WS open → connected。 */
export function applySocketOpen(state: WorkbenchState): WorkbenchState {
  return { ...state, connection: 'connected' };
}

/**
 * WS close。1008 = 鉴权失败 → auth-failed（调用方不得自动重连）；
 * 其余关闭 → disconnected；无论哪种都 running=false。
 */
export function applySocketClose(state: WorkbenchState, code: number): WorkbenchState {
  if (code === 1008) {
    return {
      ...state,
      connection: 'auth-failed',
      running: false,
      lastError: '鉴权失败，请重启应用',
    };
  }
  return {
    ...state,
    connection: 'disconnected',
    running: false,
    lastError: '连接断开，重试中',
  };
}

/** {type:'state'}：更新 workspace/policy/bots/running（running 由服务端 state 驱动）。 */
export function applyState(state: WorkbenchState, payload: StatePayload): WorkbenchState {
  return {
    ...state,
    workspaceRoot: payload.workspaceRoot,
    policyMode: payload.policyMode,
    running: payload.running,
    bots: payload.bots ?? [],
  };
}

/** {type:'event'}：追加到 events；done/error 把 running 置 false，error 写 lastError。 */
export function applyLoopEvent(state: WorkbenchState, event: AgentLoopEvent): WorkbenchState {
  const next: WorkbenchState = { ...state, events: [...state.events, event] };
  if (event.type === 'done') {
    next.running = false;
  } else if (event.type === 'error') {
    next.running = false;
    next.lastError = event.text ?? '执行出错';
  }
  return next;
}

/**
 * {type:'tool-run'}：终态每个 runId 只保留一条（TERMINAL_PHASES 去重）。
 * started 阶段允许刷新同 runId 的进行中记录。
 */
export function applyToolRun(state: WorkbenchState, event: ToolRunEvent): WorkbenchState {
  const isTerminal = TERMINAL_PHASES.has(event.phase);
  const existingIdx = state.toolRuns.findIndex((r) => r.runId === event.runId);

  if (existingIdx >= 0) {
    const existing = state.toolRuns[existingIdx];
    // 已有终态，不被后续非终态覆盖。
    if (TERMINAL_PHASES.has(existing.phase) && !isTerminal) return state;
    const toolRuns = state.toolRuns.slice();
    toolRuns[existingIdx] = event;
    return { ...state, toolRuns };
  }

  // 非终态也记录（started），便于右栏显示进行中。
  void isTerminal;
  return { ...state, toolRuns: [...state.toolRuns, event] };
}

/** 是否允许发送：必须已连接且未在运行。 */
export function canSend(state: WorkbenchState): boolean {
  return state.connection === 'connected' && !state.running;
}

/** 是否允许停止：仅在运行中。 */
export function canStop(state: WorkbenchState): boolean {
  return state.running;
}

/** 1008 鉴权失败不自动重连；其余断开可重连。 */
export function shouldReconnect(code: number): boolean {
  return code !== 1008;
}
