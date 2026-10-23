/**
 * 信封传输：注入侧（WebView）↔ 宿主侧（Node / Rust）
 *
 * - createWebviewPostMessageTransport：浏览器注入侧用 window.postMessage 投出信封。
 *   在 Tauri v0.7 中，WebView 的 postMessage 由 Rust 侧桥接转发到宿主；v0.2 Node 原型下
 *   该跨进程通道尚未打通，本函数仅提供规范一致的注入侧 Transport（单测用 fake window 验证）。
 * - createNodeWsEnvelopeReceiver：Node 宿主侧 ws 服务，接收注入侧投来的信封。
 *   这是 v0.2 的宿主侧信封入口；v0.7 会替换为 Tauri bridge_invoke IPC。
 */

import { createWindowMessageTransport, type Transport } from './transport';
import { decodeRuntimeMessageEnvelope, type RuntimeMessageEnvelope } from './envelope';

export function createWebviewPostMessageTransport(
  targetWindow: { postMessage(message: unknown, targetOrigin: string): void },
  channel = 'deepseek-studio:runtime',
  selfWindow: {
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    location?: { origin?: string };
  } = globalThis as never,
  targetOrigin: string = selfWindow.location?.origin ?? '*',
): Transport {
  return createWindowMessageTransport(targetWindow, channel, selfWindow, 30_000, targetOrigin);
}

export interface NodeWsEnvelopeReceiver {
  readonly port: number;
  close(): Promise<void>;
}

export async function createNodeWsEnvelopeReceiver(
  port: number,
  onEnvelope: (envelope: RuntimeMessageEnvelope) => void,
): Promise<NodeWsEnvelopeReceiver> {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try {
        const raw = JSON.parse(data.toString());
        const env = decodeRuntimeMessageEnvelope(raw);
        if (env) onEnvelope(env);
      } catch {
        // 忽略非法信封（fail-open：单条坏消息不影响其余）
      }
    });
  });

  return new Promise<NodeWsEnvelopeReceiver>((resolve, reject) => {
    // F-M4：监听 error（如端口占用 EADDRINUSE），否则 Promise 永久挂起
    wss.on('error', (err) => reject(err));
    wss.on('listening', () => {
      const addr = wss.address();
      const actualPort = typeof addr === 'object' && addr ? (addr as { port: number }).port : port;
      resolve({
        port: actualPort,
        close: () => new Promise<void>((res) => wss.close(() => res())),
      });
    });
  });
}
