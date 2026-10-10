/**
 * v0.3.1 工具注册表 + 风险分级 + 站点 allowlist 治理测试
 *
 * 覆盖：
 *   - 注册表纯数据治理：has / get / list / isOriginAllowed（fail-closed）
 *   - 风险等级顺序 read < insert < send
 *   - 端到端：desktop-host 在执行期按 allowlist 拒绝非白名单 origin
 */

import { describe, it, expect } from 'vitest';
import { createToolRegistry, riskRank, ToolRegistryError, type ToolDefinition } from '../../src/host/tool-registry';
import { createDesktopHost } from '../../src/host/desktop-host';
import type { ApiConfig } from '../../src/api/types';

const defs: ToolDefinition[] = [
  { id: 'echo', title: 'Echo', description: 'd', risk: 'read', allowedOrigins: ['https://chat.deepseek.com'] },
  { id: 'chat-send', title: 'Send', description: 'd', risk: 'send', allowedOrigins: ['https://chat.deepseek.com', 'https://chat.deepseek.cn'] },
];

describe('tool registry (governance data layer)', () => {
  it('has / get / list', () => {
    const r = createToolRegistry(defs);
    expect(r.has('echo')).toBe(true);
    expect(r.has('ghost')).toBe(false);
    expect(r.get('echo')?.risk).toBe('read');
    expect(r.list().map((d) => d.id).sort()).toEqual(['chat-send', 'echo']);
  });

  it('isOriginAllowed：注册工具 + 精确命中 → true', () => {
    const r = createToolRegistry(defs);
    expect(r.isOriginAllowed('echo', 'https://chat.deepseek.com')).toBe(true);
  });

  it('isOriginAllowed：大小写不敏感比对', () => {
    const r = createToolRegistry(defs);
    expect(r.isOriginAllowed('echo', 'HTTPS://Chat.DeepSeek.COM')).toBe(true);
  });

  it('isOriginAllowed：未注册工具 → false（fail-closed）', () => {
    const r = createToolRegistry(defs);
    expect(r.isOriginAllowed('ghost', 'https://chat.deepseek.com')).toBe(false);
  });

  it('isOriginAllowed：origin 为空串（未知源）→ false', () => {
    const r = createToolRegistry(defs);
    expect(r.isOriginAllowed('echo', '')).toBe(false);
  });

  it('isOriginAllowed：不在白名单的 origin → false', () => {
    const r = createToolRegistry(defs);
    expect(r.isOriginAllowed('echo', 'https://evil.example.com')).toBe(false);
    expect(r.isOriginAllowed('chat-send', 'https://evil.example.com')).toBe(false);
  });

  it('isOriginAllowed：多白名单命中（含 chat.deepseek.cn）', () => {
    const r = createToolRegistry(defs);
    expect(r.isOriginAllowed('chat-send', 'https://chat.deepseek.cn')).toBe(true);
  });

  it('riskRank：read < insert < send', () => {
    expect(riskRank('read')).toBeLessThan(riskRank('insert'));
    expect(riskRank('insert')).toBeLessThan(riskRank('send'));
  });

  it('register：运行时补充登记后即刻生效', () => {
    const r = createToolRegistry([]);
    expect(r.has('echo')).toBe(false);
    r.register({ id: 'echo', title: 'Echo', description: 'd', risk: 'read', allowedOrigins: ['https://chat.deepseek.com'] });
    expect(r.has('echo')).toBe(true);
    expect(r.isOriginAllowed('echo', 'https://chat.deepseek.com')).toBe(true);
  });

  it('ToolRegistryError 携带 deny code', () => {
    const e = new ToolRegistryError('origin-denied', 'x');
    expect(e.code).toBe('origin-denied');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('v0.3.1 allowlist 端到端闸门（desktop-host）', () => {
  const TOKEN = 'reg-token';
  const SECRET = 'reg-secret';
  let host: ReturnType<typeof createDesktopHost>;

  beforeAll(async () => {
    const config: ApiConfig = { host: '127.0.0.1', port: 0, token: TOKEN };
    host = createDesktopHost({ config, secret: SECRET });
    await host.start();
  });
  afterAll(async () => {
    await host.stop();
  });

  it('白名单 origin（chat.deepseek.com）的 echo 正常执行', async () => {
    const grant = await host.issueGrant({ documentId: 'a', sessionId: 's', requestId: 'r1', scope: 'echo', origin: 'https://chat.deepseek.com' });
    const res = await host.executeTool('echo', { message: 'hi' }, grant);
    expect(res.ok).toBe(true);
    expect(res.snapshot?.total).toBeGreaterThan(0);
  });

  it('非白名单 origin 的 echo 在 allowlist 闸门被拒', async () => {
    const grant = await host.issueGrant({ documentId: 'b', sessionId: 's', requestId: 'r2', scope: 'echo', origin: 'https://evil.example.com' });
    const res = await host.executeTool('echo', {}, grant);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('origin-denied');
  });

  it('grant 未携带 origin（未知源）→ 被拒绝', async () => {
    const grant = await host.issueGrant({ documentId: 'c', sessionId: 's', requestId: 'r3', scope: 'echo' });
    const res = await host.executeTool('echo', {}, grant);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('origin-denied');
  });
});
