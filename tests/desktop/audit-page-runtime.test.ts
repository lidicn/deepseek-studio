/**
 * 审计修复回归：R2-03（ws upgrade 校验 Origin）、R2-02（pickClient 只派发 hello-ready 连接）。
 */
import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { createDesktopHost } from '../../src/host/desktop-host';

function portOf(host: { url: string }): number {
  return Number(new URL(host.url).port);
}

describe('R2-03 ws upgrade Origin 闸门', () => {
  it('公网恶意 Origin → 握手被拒，无可用页端', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(host)}/studio`, {
        headers: { Origin: 'https://evil.example.com' },
      });
      const closed = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code));
        ws.on('error', () => resolve(-1));
      });
      const code = await closed;
      expect(code).not.toBe(1000); // 非正常完成握手
      // 恶意页未成为派发目标：任何页端工具都 fail-closed
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
    } finally {
      await host.stop();
    }
  });
});

describe('R2-02 pickClient 只派发 hello-ready 连接', () => {
  it('已连接但从不发 hello 的进程 → 不派发（no-page-runtime）', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(host)}/studio`);
      await new Promise<void>((resolve) => ws.on('open', () => resolve()));
      // 故意不发 hello：pickClient 跳过未握手连接，fail-closed
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('no-page');
      ws.close();
    } finally {
      await host.stop();
    }
  });

  it('握手 Origin 与 hello 自报 origin 不一致 → 判 untrusted，不派发', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(host)}/studio`, {
        headers: { Origin: 'https://chat.deepseek.com' },
      });
      await new Promise<void>((resolve) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'hello', origin: 'https://evil.example.com', sessionId: 'x' }));
          resolve();
        });
      });
      await new Promise((r) => setTimeout(r, 100));
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).toContain('no-page');
      ws.close();
    } finally {
      await host.stop();
    }
  });
});

describe('R2-04 / R2-05 无页回退与内部 origin', () => {
  it('R2-04：无页时 DOM 能力 chat-read 明确失败（no-page-for-dom-capability），不假成功', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const res = await host.invokeTool('chat-read', {});
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('no-page-for-dom-capability');
    } finally {
      await host.stop();
    }
  });

  it('R2-05：宿主内部调用（HOST_INTERNAL_ORIGIN）不被 origin 闸门拒绝，echo 回退成功', async () => {
    const host = createDesktopHost({ config: { host: '127.0.0.1', port: 0, token: 't' }, secret: 's' });
    await host.start();
    try {
      const res = await host.invokeTool('echo', { text: 'hi' });
      expect(res.ok).toBe(true);
    } finally {
      await host.stop();
    }
  });
});
