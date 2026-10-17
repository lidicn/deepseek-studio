/**
 * 智能体面板通道（M1）：/agent-ws WebSocket。
 *
 * 面板（独立 Tauri 窗口，加载 http://127.0.0.1:8760/agent）经本通道驱动宿主智能体：
 *   send / stop / set-policy / set-workspace / pick-folder / get-state
 * 宿主 → 面板：AgentLoop 事件流（event）与请求响应（ack）、状态快照（state）。
 *
 * v0.23：多 bot 化。面板消息可带 botId 路由到指定 bot；缺省='main'（向后兼容）。
 * 面板不传 botId → 路由到 main bot → 行为与改造前一致。
 *
 * 鉴权：连接时校验 query 里的 token 与 API 令牌一致，不一致立即关闭（fail-closed）。
 * 页面 HTML 由服务端内嵌令牌下发——威胁模型与 v0.5 一致：本地进程本就能读 config.json。
 */

import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentLoopEvent } from './agent-loop';
import type { ChatRoomEvent } from './bot/types';
import type { PolicyMode } from './policy';
import { PANEL_POLICY_MODES } from './policy';
import { verifyWsQueryToken, type WSQueryTokenSource } from './host-token';

/** 单个 bot 的面板可调用能力面（与改造前 AgentChannelHost.agent 形状一致）。 */
export interface BotHandle {
  sendMessage(text: string): Promise<void>;
  stop(): void;
  readonly running: boolean;
  health(): Promise<{ ok: boolean; reason?: string }>;
}

/** 宿主侧所需的最小能力面（避免反向依赖 DesktopHost 全量类型）。 */
export interface AgentChannelHost {
  /** v0.23：多 bot 访问器。get(botId?) 缺省=main；list() 返回所有 bot 的运行状态。 */
  readonly bots: {
    get(botId?: string): BotHandle;
    list(): { botId: string; running: boolean }[];
  };
  onAgentEvent(cb: (event: AgentLoopEvent) => void): () => void;
  /** v0.28：聊天室结构化事件订阅（ChatRoomEvent → {type:'chat-room-event'} broadcast）。 */
  onChatRoomEvent?: (cb: (event: ChatRoomEvent) => void) => () => void;
  readonly policyMode: PolicyMode;
  setPolicyMode(mode: PolicyMode): void;
  readonly workspaceRoot: string | null;
  setWorkspaceRoot(path: string | null): { ok: boolean; error?: string };
  pickFolder(): Promise<string | null>;
  /**
   * v0.27：聊天室运行时。有此字段时，带 roomId 的 send 走聊天室模式
   *（@路由 + 多 bot 编排）；无此字段或消息不带 roomId 时走原直发路径（向后兼容）。
   */
  readonly chatRoomRuntime?: {
    handleUserMessage(roomId: string, text: string, userId?: string): Promise<unknown>;
    getRoomParticipants(roomId: string): unknown[];
    getMessages(roomId: string): unknown[];
  };
}

export interface AgentChannelOptions {
  server: Server;
  host: AgentChannelHost;
  /**
   * API 令牌：WS 连接鉴权用。
   * QD-R2-12：支持每连接求值的 TokenSource（轮换环），与 page-runtime 共用 helper。
   */
  token: WSQueryTokenSource;
  path?: string;
  onError?: (message: string, error?: unknown) => void;
}

/** 缺省 botId（向后兼容：面板不传 botId 时路由到 main）。 */
const MAIN_BOT_ID = 'main';

type ClientMessage =
  | { type: 'send'; text?: unknown; botId?: string; roomId?: string; reqId?: string }
  | { type: 'stop'; botId?: string; reqId?: string }
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
  const onUpgrade = (req: InstanceType<typeof import('node:http').IncomingMessage>, socket: unknown, head: Buffer): void => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== path) return;
    wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit('connection', ws, req));
  };
  options.server.on('upgrade', onUpgrade as never);
  const sockets = new Set<WebSocket>();

  function safeSend(ws: WebSocket, payload: unknown): void {
    try {
      // ws.send() 内部已处理队列化（CONNECTING 时自动排队）；
      // 仅跳过 CLOSED/CLOSING，避免向已关闭连接发送。
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.send(JSON.stringify(payload));
      }
    } catch (err) {
      options.onError?.(`agent-channel send failed`, err);
    }
  }

  function statePayload(): Record<string, unknown> {
    const botsList = options.host.bots.list();
    const mainBot = botsList.find((b) => b.botId === MAIN_BOT_ID);
    return {
      type: 'state',
      policyMode: options.host.policyMode,
      panelModes: PANEL_POLICY_MODES,
      workspaceRoot: options.host.workspaceRoot,
      // v0.23：running 保持指向 main bot（向后兼容现有面板）
      running: mainBot?.running ?? false,
      // v0.23：多 bot 状态列表（新面板可读此字段展示所有 bot）
      bots: botsList,
    };
  }

  function broadcast(event: AgentLoopEvent): void {
    for (const ws of sockets) safeSend(ws, { type: 'event', event });
  }

  // v0.28：聊天室结构化事件单独广播（与 AgentLoopEvent 的 {type:'event'} 区分）。
  // UI 据此渲染 bot 回复气泡/摘要，按 roomId 过滤当前房间。
  function broadcastChatRoomEvent(event: ChatRoomEvent): void {
    for (const ws of sockets) safeSend(ws, { type: 'chat-room-event', event });
  }

  const unsubscribe = options.host.onAgentEvent(broadcast);
  // onChatRoomEvent 可选（无 chatRooms 配置时 host 不提供）；缺省不订阅。
  const unsubscribeChatRoom = options.host.onChatRoomEvent?.(broadcastChatRoomEvent);

  wss.on('connection', (ws: WebSocket, req) => {
    // 鉴权：query token 必须与当前 accepted 集合之一匹配（QD-R2-12：接轮换环 + 常数时间比较）。
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!verifyWsQueryToken(url.searchParams.get('token'), options.token)) {
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
          const text = msg.text.trim();
          // v0.27：聊天室模式分流。带 roomId 且 host 有 chatRoomRuntime → @路由 + 多 bot 编排；
          // 否则走原直发路径（向后兼容：现有面板单 bot 发消息行为不变）。
          if (msg.roomId && options.host.chatRoomRuntime) {
            ack(true, { roomId: msg.roomId });
            await options.host.chatRoomRuntime.handleUserMessage(msg.roomId, text);
            return;
          }
          const botId = msg.botId ?? MAIN_BOT_ID;
          const bot = options.host.bots.get(botId);
          if (bot.running) {
            ack(false, undefined, 'agent-busy');
            return;
          }
          ack(true, { botId });
          await bot.sendMessage(text);
          return;
        }
        case 'stop': {
          const botId = msg.botId ?? MAIN_BOT_ID;
          options.host.bots.get(botId).stop();
          ack(true, { botId });
          return;
        }
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
      unsubscribeChatRoom?.();
      // F-L1：移除 upgrade 监听器，避免泄漏
      (options.server as unknown as { removeListener: (e: string, fn: unknown) => void })
        .removeListener('upgrade', onUpgrade as never);
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
