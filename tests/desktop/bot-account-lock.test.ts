/**
 * v0.31 账号身份锁测试（page-runtime hub 同账号去重 fail-closed）
 *
 * 直接起 createPageRuntimeHub（裸 http server + noServer ws），连两个假注入页，
 * 各在 hello 里自报 accountFingerprint，验证：
 *   - 同指纹 → 第二个窗口被推 account-duplicate-block + 标 untrusted（trustedPages 不含）
 *   - 不同指纹 → 都登记、都 trusted
 *   - 指纹 undefined（旧注入/未登录）→ 不触发去重（向后兼容）
 *
 * connectFakePage 等 hello-ack 才 resolve（宿主已登记指纹），消除去重竞态；
 * 监听器在连接前注册；server 绑 127.0.0.1（Windows 默认绑 IPv6 的坑见记忆）。
 */

import { describe, expect, it, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { createPageRuntimeHub } from '../../src/host/page-runtime';
import type { HostToPageMessage } from '../../src/host/protocol';

async function connectFakePage(opts: {
  port: number;
  botId?: string;
  accountFingerprint?: string;
}): Promise<{ ws: WebSocket; inbox: HostToPageMessage[] }> {
  const { port, botId, accountFingerprint } = opts;
  const inbox: HostToPageMessage[] = [];
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        origin: 'https://chat.deepseek.com',
        sessionId: crypto.randomUUID(),
        ...(botId !== undefined ? { botId } : {}),
        ...(accountFingerprint !== undefined ? { accountFingerprint } : {}),
      }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as HostToPageMessage;
        inbox.push(msg);
        if (msg.type === 'hello-ack') resolve({ ws, inbox });
      } catch {
        /* ignore */
      }
    });
  });
}

describe('page-runtime —— v0.31 账号身份锁', () => {
  let server: ReturnType<typeof createServer>;
  let hub: ReturnType<typeof createPageRuntimeHub>;
  let port: number;

  async function startHub(onDuplicateAccount?: (info: { duplicateId: string; duplicateBotId: string | undefined; existingId: string; existingBotId: string | undefined; fingerprint: string }) => void) {
    server = createServer();
    hub = createPageRuntimeHub({ server, onDuplicateAccount });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  }

  afterEach(async () => {
    try { hub?.dispose(); } catch { /* ignore */ }
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it('同 accountFingerprint → 第二个窗口收到 account-duplicate-block 且 untrusted', async () => {
    await startHub();
    const a = await connectFakePage({ port, botId: 'bot-a', accountFingerprint: 'fp-AAA' });
    const b = await connectFakePage({ port, botId: 'bot-b', accountFingerprint: 'fp-AAA' });

    // 第二个窗口应在 hello-ack 之后收到 account-duplicate-block
    const block = b.inbox.find((m) => m.type === 'account-duplicate-block');
    expect(block).toBeDefined();
    expect((block as { reason?: string }).reason).toContain('bot-a');
    // 第一个窗口不应收到 block
    expect(a.inbox.find((m) => m.type === 'account-duplicate-block')).toBeUndefined();

    // trustedPages 应只含 bot-a，bot-a 是唯一 trusted 页。
    const trusted = hub.trustedPages;
    expect(trusted.length).toBe(1);
    expect(trusted[0].botId).toBe('bot-a');
    expect(trusted.find((p) => p.botId === 'bot-b')).toBeUndefined();

    a.ws.close();
    b.ws.close();
  });

  it('不同 accountFingerprint → 都登记、都 trusted（正常多账号）', async () => {
    await startHub();
    const a = await connectFakePage({ port, botId: 'bot-a', accountFingerprint: 'fp-AAA' });
    const b = await connectFakePage({ port, botId: 'bot-b', accountFingerprint: 'fp-BBB' });

    expect(a.inbox.find((m) => m.type === 'account-duplicate-block')).toBeUndefined();
    expect(b.inbox.find((m) => m.type === 'account-duplicate-block')).toBeUndefined();
    expect(hub.trustedPages.length).toBe(2);

    a.ws.close();
    b.ws.close();
  });

  it('accountFingerprint undefined（旧注入/未登录）→ 不触发去重（向后兼容）', async () => {
    await startHub();
    // 两个窗口都不带指纹（旧注入脚本行为）
    const a = await connectFakePage({ port, botId: 'bot-a' });
    const b = await connectFakePage({ port, botId: 'bot-b' });

    expect(a.inbox.find((m) => m.type === 'account-duplicate-block')).toBeUndefined();
    expect(b.inbox.find((m) => m.type === 'account-duplicate-block')).toBeUndefined();
    expect(hub.trustedPages.length).toBe(2);

    a.ws.close();
    b.ws.close();
  });

  it('一个带指纹一个不带 → 不误报（undefined 不参与去重）', async () => {
    await startHub();
    const a = await connectFakePage({ port, botId: 'bot-a', accountFingerprint: 'fp-AAA' });
    const b = await connectFakePage({ port, botId: 'bot-b' }); // 无指纹

    expect(b.inbox.find((m) => m.type === 'account-duplicate-block')).toBeUndefined();
    expect(hub.trustedPages.length).toBe(2);

    a.ws.close();
    b.ws.close();
  });

  it('onDuplicateAccount 回调携带重复双方 botId + 指纹', async () => {
    const calls: { duplicateBotId?: string; existingBotId?: string; fingerprint: string }[] = [];
    await startHub((info) => {
      calls.push({
        duplicateBotId: info.duplicateBotId,
        existingBotId: info.existingBotId,
        fingerprint: info.fingerprint,
      });
    });
    const a = await connectFakePage({ port, botId: 'bot-a', accountFingerprint: 'fp-XYZ' });
    const b = await connectFakePage({ port, botId: 'bot-b', accountFingerprint: 'fp-XYZ' });

    expect(calls.length).toBe(1);
    expect(calls[0].duplicateBotId).toBe('bot-b');
    expect(calls[0].existingBotId).toBe('bot-a');
    expect(calls[0].fingerprint).toBe('fp-XYZ');

    a.ws.close();
    b.ws.close();
  });
});
