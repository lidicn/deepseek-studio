/**
 * v0.2 端到端最小闭环：发消息 → 签 grant → 跑工具。
 *
 * 覆盖范围：
 *   - 常驻宿主签发一次性 grant
 *   - 持 grant 执行 echo 能力（资源 > 0，证明 start/stop 资源所有权不变量）
 *   - 一次性消费：replay 同一 grant 被拒
 *   - 未授权 / 未知能力 fail-closed 拒绝
 *   - 本地 HTTP API：/healthz 免鉴权、/v1/chat/completions（fake backend）通过
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDesktopHost } from '../../src/host/desktop-host';
import { getEchoLastExecutedAt } from '../../src/capabilities/echo';
import type { ApiConfig } from '../../src/api/types';

const TOKEN = 'e2e-token';
const SECRET = 'e2e-secret';

describe('v0.2 最小闭环', () => {
  let host: ReturnType<typeof createDesktopHost>;
  let base = '';

  beforeAll(async () => {
    const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
    host = createDesktopHost({ config, secret: SECRET });
    await host.start();
    base = host.url;
  });
  afterAll(async () => {
    await host.stop();
  });

  it('宿主签发 grant', async () => {
    const grant = await host.issueGrant({ documentId: 'd1', sessionId: 's1', requestId: 'r1', scope: 'echo', origin: 'https://chat.deepseek.com' });
    expect(typeof grant).toBe('string');
    expect(grant.length).toBeGreaterThan(0);
  });

  it('持 grant 执行 echo：资源 > 0，且 replay 被拒', async () => {
    const grant = await host.issueGrant({ documentId: 'd2', sessionId: 's2', requestId: 'r2', scope: 'echo', origin: 'https://chat.deepseek.com' });
    const res = await host.executeTool('echo', { message: 'hi' }, grant);
    expect(res.ok).toBe(true);
    expect(res.snapshot?.total).toBeGreaterThan(0);
    expect(getEchoLastExecutedAt()).toBeGreaterThan(0);

    const replay = await host.executeTool('echo', {}, grant);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('consumed');
  });

  it('未授权（错误 grant）执行被拒', async () => {
    const res = await host.executeTool('echo', {}, 'garbage.grant');
    expect(res.ok).toBe(false);
  });

  it('未知能力执行被拒', async () => {
    const grant = await host.issueGrant({ documentId: 'd3', sessionId: 's3', requestId: 'r3', scope: 'nope' });
    const res = await host.executeTool('does-not-exist', {}, grant);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unknown-capability');
  });

  it('v0.3.1 站点 allowlist：非白名单 origin 的 grant 执行被拒', async () => {
    const grant = await host.issueGrant({ documentId: 'd4', sessionId: 's4', requestId: 'r4', scope: 'echo', origin: 'https://evil.example.com' });
    const res = await host.executeTool('echo', {}, grant);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('origin-denied');
  });

  it('GET /healthz 免鉴权', async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
  });

  it('POST /v1/chat/completions (fake) 通过', async () => {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    const json = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0].message.content.length).toBeGreaterThan(0);
  });
});
