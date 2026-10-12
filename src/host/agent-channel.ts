/**
 * 智能体面板通道（M1）：/agent-ws WebSocket。
 *
 * 面板（独立 Tauri 窗口，加载 http://127.0.0.1:8760/agent）经本通道驱动宿主智能体：
 *   send / stop / set-policy / set-workspace / pick-folder / get-state
 * 宿主 → 面板：AgentLoop 事件流（event）与请求响应（ack）、状态快照（state）。
 *
 * 鉴权：连接时校验 query 里的 token 与 API 令牌一致，不一致立即关闭（fail-closed）。
 * 页面 HTML 由服务端内嵌令牌下发——威胁模型与 v0.5 一致：本地进程本就能读 config.json。
 */

import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentLoopEvent } from './agent-loop';
import type { PolicyMode } from './policy';
import { PANEL_POLICY_MODES } from './policy';

/** 宿主侧所需的最小能力面（避免反向依赖 DesktopHost 全量类型）。 */
export interface AgentChannelHost {
  readonly agent: {
    sendMessage(text: string): Promise<void>;
    stop(): void;
    readonly running: boolean;
    health(): Promise<{ ok: boolean; reason?: string }>;
  };
  onAgentEvent(cb: (event: AgentLoopEvent) => void): () => void;
  readonly policyMode: PolicyMode;
  setPolicyMode(mode: PolicyMode): void;
  readonly workspaceRoot: string | null;
  setWorkspaceRoot(path: string | null): { ok: boolean; error?: string };
  pickFolder(): Promise<string | null>;
}

export interface AgentChannelOptions {
  server: Server;
  host: AgentChannelHost;
  /** API 令牌：WS 连接鉴权用。 */
  token: string;
  path?: string;
  onError?: (message: string, error?: unknown) => void;
}

type ClientMessage =
  | { type: 'send'; text?: unknown; reqId?: string }
  | { type: 'stop'; reqId?: string }
  | { type: 'get-state'; reqId?: string }
  | { type: 'set-policy'; mode?: unknown; reqId?: string }
  | { type: 'set-workspace'; path?: unknown; reqId?: string }
  | { type: 'pick-folder'; reqId?: string }
  | { type: 'ping'; reqId?: string };

export interface AgentChannel {
  dispose(): void;
  /** 当前连接的面板数（测试/诊断用）。 */
  readonly clientCount: number;
}

export function createAgentChannel(options: AgentChannelOptions): AgentChannel {
  const path = options.path ?? '/agent-ws';
  // 同 page-runtime：noServer + 路径守卫，避免多个 WebSocketServer 互踩 upgrade。
  const wss = new WebSocketServer({ noServer: true });
  options.server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const sockets = new Set<WebSocket>();

  function safeSend(ws: WebSocket, payload: unknown): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    } catch (err) {
      options.onError?.(`agent-channel send failed`, err);
    }
  }

  function statePayload(): Record<string, unknown> {
    return {
      type: 'state',
      policyMode: options.host.policyMode,
      panelModes: PANEL_POLICY_MODES,
      workspaceRoot: options.host.workspaceRoot,
      running: options.host.agent.running,
    };
  }

  function broadcast(event: AgentLoopEvent): void {
    for (const ws of sockets) safeSend(ws, { type: 'event', event });
  }

  const unsubscribe = options.host.onAgentEvent(broadcast);

  wss.on('connection', (ws: WebSocket, req) => {
    // 鉴权：query token 必须与 API 令牌一致
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.get('token') !== options.token) {
      try {
        ws.close(1008, 'unauthorized');
      } catch {
        /* ignore */
      }
      return;
    }
    sockets.add(ws);
    safeSend(ws, statePayload());

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      void handle(msg, ws);
    });
    ws.on('close', () => sockets.delete(ws));
    ws.on('error', () => sockets.delete(ws));
  });

  async function handle(msg: ClientMessage, ws: WebSocket): Promise<void> {
    const ack = (ok: boolean, data?: unknown, error?: string): void => {
      safeSend(ws, { type: 'ack', reqId: msg.reqId, ok, data, error });
    };
    try {
      switch (msg.type) {
        case 'ping':
          ack(true, { pong: Date.now() });
          return;
        case 'get-state':
          safeSend(ws, statePayload());
          ack(true);
          return;
        case 'send': {
          if (typeof msg.text !== 'string' || msg.text.trim().length === 0) {
            ack(false, undefined, 'missing-text');
            return;
          }
          if (options.host.agent.running) {
            ack(false, undefined, 'agent-busy');
            return;
          }
          ack(true);
          await options.host.agent.sendMessage(msg.text.trim());
          return;
        }
        case 'stop':
          options.host.agent.stop();
          ack(true);
          return;
        case 'set-policy': {
          const mode = msg.mode as PolicyMode;
          if (!(PANEL_POLICY_MODES as readonly string[]).includes(mode)) {
            ack(false, undefined, `invalid policy mode: ${String(mode)}`);
            return;
          }
          options.host.setPolicyMode(mode);
          safeSend(ws, statePayload());
          ack(true);
          return;
        }
        case 'set-workspace': {
          const p = typeof msg.path === 'string' && msg.path.trim().length > 0 ? msg.path.trim() : null;
          const r = options.host.setWorkspaceRoot(p);
          safeSend(ws, statePayload());
          ack(r.ok, r.ok ? { workspaceRoot: options.host.workspaceRoot } : undefined, r.error);
          return;
        }
        case 'pick-folder': {
          const dir = await options.host.pickFolder();
          ack(true, { path: dir });
          return;
        }
        default:
          return;
      }
    } catch (err) {
      ack(false, undefined, err instanceof Error ? err.message : String(err));
    }
  }

  return {
    dispose() {
      unsubscribe();
      wss.close();
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
    },
    get clientCount() {
      return sockets.size;
    },
  };
}
