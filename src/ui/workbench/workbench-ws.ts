/**
 * Workbench WebSocket 通道（§10.9）：/agent-ws 连接、1008 不自动重连、消息分发到 state。
 *
 * 处理：state / event / tool-run / ack / chat-room-event（本期只记录不渲染假聊天室）。
 * 请求：send / stop / set-policy / set-workspace / pick-folder / get-state。
 * 权限切换走 set-policy，不调 callHostTool('policy.set')。
 */
import {
  applySocketOpen,
  applySocketClose,
  applyState,
  applyLoopEvent,
  applyToolRun,
  shouldReconnect,
  type WorkbenchState,
} from './workbench-state';
import type { AckPayload, StatePayload, WorkbenchRequest } from './workbench-types';
import type { AgentLoopEvent } from '../../shared/agent-loop-event';
import type { ToolRunEvent } from '../../shared/tool-run-event';

export interface WorkbenchSocketHandlers {
  onState(state: WorkbenchState): void;
  onAck(ack: AckPayload): void;
  /** 可选：原始 loop 事件副作用（步骤流渲染等），state 已先经 applyLoopEvent 更新。 */
  onLoopEvent?(event: AgentLoopEvent): void;
  /** 可选：原始 tool-run 副作用（右栏卡片渲染等），state 已先经 applyToolRun 更新。 */
  onToolRun?(event: ToolRunEvent): void;
}

export interface WorkbenchSocket {
  send(req: WorkbenchRequest): void;
  close(): void;
  /** 手动重连（1008 鉴权失败仍不会自动重连）。 */
  reconnect(): void;
  readonly state: WorkbenchState;
}

export interface WorkbenchSocketOptions {
  url: string;
  initial: WorkbenchState;
  handlers: WorkbenchSocketHandlers;
  reconnectDelayMs?: number;
}

export function createWorkbenchSocket(options: WorkbenchSocketOptions): WorkbenchSocket {
  let state = options.initial;
  let ws: WebSocket | null = null;
  let timer: number | null = null;
  let closedByUser = false;

  const emit = (next: WorkbenchState) => {
    state = next;
    options.handlers.onState(next);
  };

  function clearTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function connect(): void {
    clearTimer();
    ws = new WebSocket(options.url);

    ws.onopen = () => emit(applySocketOpen(state));

    ws.onclose = (ev: CloseEvent) => {
      emit(applySocketClose(state, ev.code));
      if (!closedByUser && shouldReconnect(ev.code)) {
        const delay = options.reconnectDelayMs ?? 2000;
        timer = window.setTimeout(() => connect(), delay);
      }
    };

    ws.onerror = () => ws?.close();

    ws.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'state':
          emit(applyState(state, msg as unknown as StatePayload));
          break;
        case 'event': {
          const loopEvent = msg.event as AgentLoopEvent;
          emit(applyLoopEvent(state, loopEvent));
          options.handlers.onLoopEvent?.(loopEvent);
          break;
        }
        case 'tool-run': {
          const toolEvent = msg.event as ToolRunEvent;
          emit(applyToolRun(state, toolEvent));
          options.handlers.onToolRun?.(toolEvent);
          break;
        }
        case 'ack':
          options.handlers.onAck(msg as unknown as AckPayload);
          break;
        case 'chat-room-event':
          // 本期只记录，不渲染假聊天室。
          break;
        default:
          break;
      }
    };
  }

  connect();

  return {
    get state() {
      return state;
    },
    send(req: WorkbenchRequest) {
      ws?.send(JSON.stringify(req));
    },
    close() {
      closedByUser = true;
      clearTimer();
      ws?.close();
      ws = null;
    },
    reconnect() {
      closedByUser = false;
      connect();
    },
  };
}
