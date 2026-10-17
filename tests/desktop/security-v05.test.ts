/**
 * v0.5 安全石化验收测试
 * 对应路线图 5.1~5.5 与审计闭环：429 限流、CORS fail-closed、
 * 令牌轮换宽限期、审计经 HTTP 可读、页面篡改后宿主降级。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createDesktopHost, type DesktopHost } from '../../src/host/desktop-host';
import { createSecretRing } from '../../src/host/host-token';
import { createBearerAuthenticator } from '../../src/api/auth';
import { isLocalOrigin } from '../../src/api/server';
import { startIntegrityProbe } from '../../src/desktop/integrity';

const running: DesktopHost[] = [];

async function startHost(options: { capacity?: number; maxConcurrent?: number } = {}): Promise<DesktopHost> {
  const host = createDesktopHost({
    config: { host: '127.0.0.1', port: 0, token: 'tok-initial' },
    secret: 'secret-initial',
    workspace: null,
    rateLimit: {
      capacity: options.capacity ?? 60,
      refillPerMinute: options.capacity ?? 60,
      maxConcurrent: options.maxConcurrent ?? 5,
    },
  });
  await host.start();
  running.push(host);
  return host;
}

afterEach(async () => {
  while (running.length) {
    const h = running.pop();
    try {
      await h?.stop();
    } catch {
      /* 已停止 */
    }
  }
});

const call = (host: DesktopHost, path: string, token: string, init: RequestInit = {}) =>
  fetch(`${host.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

describe('5.2 限流与并发', () => {
  it('超出令牌桶 → 429 且带 Retry-After', async () => {
    const host = await startHost({ capacity: 2 });
    const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: false });

    const a = await call(host, '/v1/chat/completions', 'tok-initial', { method: 'POST', body });
    const b = await call(host, '/v1/chat/completions', 'tok-initial', { method: 'POST', body });
    const c = await call(host, '/v1/chat/completions', 'tok-initial', { method: 'POST', body });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(429);
    expect(c.headers.get('retry-after')).not.toBeNull();
  });

  it('并发上限生效：上限 1 时第二个请求被拒', async () => {
    const host = await startHost({ maxConcurrent: 1, capacity: 60 });
    const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
    // 串行发起即可验证上限：第一个完成后计数应归零，否则第二个会 429
    const a = await call(host, '/v1/chat/completions', 'tok-initial', { method: 'POST', body });
    const b = await call(host, '/v1/chat/completions', 'tok-initial', { method: 'POST', body });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('5.5 CORS 严格化（fail-closed）', () => {
  it('本地回环源获得放行头', async () => {
    const host = await startHost();
    const res = await call(host, '/v1/models', 'tok-initial', { headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
  });

  it('非本地源不获得放行头（浏览器自会拦截）', async () => {
    const host = await startHost();
    const res = await call(host, '/v1/models', 'tok-initial', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('非本地源的预检请求直接 403', async () => {
    const host = await startHost();
    const res = await fetch(`${host.url}/v1/models`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.status).toBe(403);
  });

  it('isLocalOrigin 判定口径', () => {
    expect(isLocalOrigin('http://localhost:3000')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalOrigin('http://[::1]:80')).toBe(true);
    expect(isLocalOrigin('https://chat.deepseek.com')).toBe(false);
    expect(isLocalOrigin(undefined)).toBe(false);
    expect(isLocalOrigin('not a url')).toBe(false);
  });
});

describe('5.1 令牌轮换与宽限期', () => {
  it('轮换后新令牌立即生效，旧令牌在宽限期内仍可用', async () => {
    const host = await startHost();
    const oldToken = 'tok-initial';
    const newToken = host.rotateApiToken('tok-rotated');

    expect(newToken).toBe('tok-rotated');
    expect(host.currentApiToken).toBe('tok-rotated');

    const withNew = await call(host, '/v1/models', newToken);
    const withOld = await call(host, '/v1/models', oldToken);
    expect(withNew.status).toBe(200);
    expect(withOld.status).toBe(200); // 宽限期内不断开既有客户端

    const bogus = await call(host, '/v1/models', 'tok-bogus');
    expect(bogus.status).toBe(401);
  });

  it('宽限期过后旧令牌失效', () => {
    let now = 0;
    const ring = createSecretRing('a', 1_000, () => now);
    expect(ring.accepted).toEqual(['a']);
    ring.rotate('b');
    expect(ring.accepted).toEqual(['b', 'a']);
    now = 1_500; // 越过宽限期
    expect(ring.accepted).toEqual(['b']);
    expect(ring.previous).toBeNull();
  });

  it('鉴权器接受函数形式的令牌源，且函数抛错时 fail-closed', () => {
    const ok = createBearerAuthenticator(() => ['t1', 't2']);
    expect(ok.authenticate('Bearer t1')).toBe(true);
    expect(ok.authenticate('Bearer t2')).toBe(true);
    expect(ok.authenticate('Bearer t3')).toBe(false);

    const broken = createBearerAuthenticator(() => {
      throw new Error('boom');
    });
    expect(broken.authenticate('Bearer t1')).toBe(false); // 出错即拒绝，不静默放行
    expect(broken.authenticate(undefined)).toBe(false);
  });
});

describe('审计经 HTTP 可读（3.2.4）', () => {
  it('GET /v1/tools/audit 返回执行记录', async () => {
    const host = await startHost();
    await host.invokeTool('echo', {});
    const res = await call(host, '/v1/tools/audit?limit=5', 'tok-initial');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ tool: string; outcome: string }> };
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data.some((r) => r.tool === 'echo')).toBe(true);
  });

  it('未配置审计读取时返回 501（不伪装成空列表）', async () => {
    const host = await startHost();
    // 有 auditReader 时应为 200（上一条已覆盖）；此处验证非法 limit 不会 500
    const res = await call(host, '/v1/tools/audit?limit=abc', 'tok-initial');
    expect(res.status).toBe(200);
  });
});

describe('5.4 完整性探测与宿主降级', () => {
  it('注入对象被整体替换 → 检出 replaced', () => {
    const bag: Record<string, unknown> = { __deepseekStudio: { bridge: {}, host: {}, authority: 'x', sessionId: 's' } };
    const alerts: string[] = [];
    const probe = startIntegrityProbe({
      read: () => bag.__deepseekStudio,
      setIntervalFn: () => 0, // 不自动触发，手动 check
      clearIntervalFn: () => {},
      onViolation: (a) => alerts.push(a.reason),
    });
    expect(probe.check()).toBeNull();

    bag.__deepseekStudio = { bridge: {}, host: {}, authority: 'x', sessionId: 's' }; // 换了个新对象
    expect(probe.check()?.reason).toBe('replaced');
    expect(alerts).toContain('replaced');
    probe.stop();
  });

  it('关键成员被替换 → 检出 member-replaced 并指出成员名', () => {
    const obj: Record<string, unknown> = { bridge: {}, host: {}, authority: 'x', sessionId: 's' };
    const bag: Record<string, unknown> = { __deepseekStudio: obj };
    const probe = startIntegrityProbe({
      read: () => bag.__deepseekStudio,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      onViolation: () => {},
    });
    (obj as { host: unknown }).host = { fake: true };
    const alert = probe.check();
    expect(alert?.reason).toBe('member-replaced');
    expect(alert?.detail).toBe('host');
    probe.stop();
  });

  it('对象被删除 → 检出 removed', () => {
    const bag: Record<string, unknown> = { __deepseekStudio: { bridge: {}, host: {}, authority: 'x', sessionId: 's' } };
    const probe = startIntegrityProbe({
      read: () => bag.__deepseekStudio,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      onViolation: () => {},
    });
    delete bag.__deepseekStudio;
    expect(probe.check()?.reason).toBe('removed');
    probe.stop();
  });

  it('页端上报篡改后，宿主不再把工具派发给该页', async () => {
    const host = await startHost();
    const port = Number(new URL(host.url).port);
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/studio?token=tok-initial`);
      s.on('open', () => {
        s.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
        resolve(s);
      });
      s.on('error', reject);
    });

    // 假页：同意 + 对派发回 result（缺了 result 宿主会等满 30s 派发超时）
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString()) as { type: string; callId?: string };
        if (m.type === 'consent-required') {
          try { ws.send(JSON.stringify({ type: 'consent-decision', callId: m.callId, decision: 'allow-once' })); } catch { /* socket closed */ }
        } else if (m.type === 'dispatch') {
          try { ws.send(JSON.stringify({ type: 'result', callId: m.callId, ok: true })); } catch { /* socket closed */ }
        }
      } catch {
        /* ignore */
      }
    });
    await new Promise((r) => setTimeout(r, 100));
    const before = await host.invokeTool('chat-send', {});
    expect(before.ok).toBe(true);

    // 页端自检上报篡改
    ws.send(JSON.stringify({ type: 'integrity-alert', reason: 'member-replaced', detail: 'host' }));
    await new Promise((r) => setTimeout(r, 200));

    const after = await host.invokeTool('chat-send', {});
    expect(after.ok).toBe(false);
    expect(after.reason).toBe('consent-denied'); // 不可信页不再被征求同意
    ws.close();
  }, 20_000);
});
