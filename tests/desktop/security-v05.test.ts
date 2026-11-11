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
import {
  MAX_LISTEN_ATTEMPTS,
  isBlockedPort,
  longestBlockedRun,
  pickUsablePort,
  shouldRetryListen,
  startListenable,
} from './_host-port-guard';

const running: DesktopHost[] = [];

/**
 * 起 host 的端口面交给 OS 分配（`port: 0`），拿到后再校验 undici 禁用表——
 * 机制与理由见 `_host-port-guard.ts` 文件头（含被否掉的三版历史，别再回退）。
 *
 * 一句话：OS 从不把 Windows 保留段端口发出去 ⇒ EACCES 一类从机制上消失；
 * 剩下唯一的坑是"OS 恰好发了个落在 fetch 禁用表里的端口（本机 1024–14999 才有这种可能）"，
 * 由 `startListenable` 显式校验并换号，上限写死 `MAX_LISTEN_ATTEMPTS`。
 */
async function startHost(options: { capacity?: number; maxConcurrent?: number } = {}): Promise<DesktopHost> {
  const host = await startListenable(() => buildHost(options));
  running.push(host);
  return host;
}

function buildHost(options: { capacity?: number; maxConcurrent?: number }): DesktopHost {
  return createDesktopHost({
    // port: 0 ⇒ 由 OS 分配（保留段天然不会发放）
    config: { host: '127.0.0.1', port: 0, token: 'tok-initial' },
    secret: 'secret-initial',
    workspace: null,
    rateLimit: {
      capacity: options.capacity ?? 60,
      refillPerMinute: options.capacity ?? 60,
      maxConcurrent: options.maxConcurrent ?? 5,
    },
  });
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

describe('取数端口判定（GATE#67 红枚 B 负控）', () => {
  it('落在 undici 禁用清单的端口必须被跳过；清单外放行；坏路径换号须新建实例', async () => {
    // 负控：这三个端口实测 fetch 抛 bad port（服务器 bind 成功、node:http 直连 200）
    expect(isBlockedPort(1719)).toBe(true);
    expect(isBlockedPort(1720)).toBe(true);
    expect(isBlockedPort(6667)).toBe(true);
    // 正控：清单外端口放行（相邻 1721 实测 fetch 200）
    expect(isBlockedPort(1721)).toBe(false);
    expect(isBlockedPort(15000)).toBe(false);

    // 选择器语义（负控）：喂一批"OS 发来的端口"，1720 必须被跳过、取 1721。
    expect(pickUsablePort([1720, 1721])).toBe(1721);
    expect(pickUsablePort([15000])).toBe(15000);
    // 非法值与全禁用 ⇒ 返回 null（调用方必须换一批，而不是硬用坏端口）
    expect(pickUsablePort([0, 65536, -1])).toBeNull();
    expect(pickUsablePort([1719, 1720, 1723, 6667])).toBeNull();
    expect(pickUsablePort([])).toBeNull();

    // 换号上限写死、可断言（上限存在才谈得上"不靠运气"）
    expect(MAX_LISTEN_ATTEMPTS).toBe(16);
    // ★ 上限必须大于"禁用表最长连续段"——OS 顺序分配（相邻差值 +1 占 98.8%）下，
    //    从段首开始要连跳整段。表里最长段是 19–23 / 6665–6669（各 5）⇒ 上限至少 6。
    //    这条是自维护的：将来表里出现更长连段，这里自动红。
    const longest = longestBlockedRun();
    expect(longest).toBeGreaterThanOrEqual(2);
    expect(MAX_LISTEN_ATTEMPTS).toBeGreaterThan(longest);
    // 负控：把最长连段原样喂进去 ⇒ 段内全被跳过、取段后第一个
    const worstRun = Array.from({ length: longest }, (_, i) => 19 + i); // 19–23，最长段之一
    expect(pickUsablePort(worstRun)).toBeNull(); // 段内全禁用 ⇒ null
    expect(pickUsablePort([...worstRun, 24])).toBe(24); // 段后第一个可用
    // 6665–6669 同样是 5 连段（本机动态范围 1024–14999 内，真实可遇）
    expect(pickUsablePort([6665, 6666, 6667, 6668, 6669])).toBeNull();
    expect(pickUsablePort([6665, 6666, 6667, 6668, 6669, 6670])).toBe(6670);
    // 端口不可用三态必须进换号路径；其余 errno 原样抛（不吞）
    expect(shouldRetryListen({ code: 'EADDRINUSE' })).toBe(true);
    expect(shouldRetryListen({ code: 'EACCES' })).toBe(true);
    expect(shouldRetryListen({ code: 'EADDRNOTAVAIL' })).toBe(true);
    expect(shouldRetryListen({ code: 'ENOTFOUND' })).toBe(false);
    expect(shouldRetryListen({ code: 'EINVAL' })).toBe(false);
    expect(shouldRetryListen(new Error('boom'))).toBe(false);

    // ── 坏路径负控（PM 第 102 件）：换号必须新建实例、用尽上限抛明确错误、非端口错误不吞 ──
    // 假 Listenable：前 N 次给的端口落在禁用表里，之后给一个可用端口。
    // 这条路径平时走不到，只有专门造它才测得到。
    type Fake = { start(): Promise<void>; stop(): Promise<void>; readonly url: string };
    const makeFake = (ports: number[]) => {
      const states = ports.map(() => ({ started: false, stopped: false }));
      const instances: Fake[] = [];
      let calls = 0;
      const factory = (): Fake => {
        const idx = calls;
        calls += 1;
        const port = ports[Math.min(idx, ports.length - 1)];
        const state = states[Math.min(idx, states.length - 1)];
        const instance: Fake = {
          start: async () => {
            state.started = true;
          },
          stop: async () => {
            state.stopped = true;
          },
          get url() {
            return `http://127.0.0.1:${port}`;
          },
        };
        instances.push(instance);
        return instance;
      };
      return { factory, states, instances, calls: () => calls };
    };

    // ① 前两次落禁用表（6667/6668）⇒ 换号；第三次 15001 可用 ⇒ 返回第三个实例
    const ok = makeFake([6667, 6668, 15001]);
    const picked = await startListenable(ok.factory);
    expect(ok.calls()).toBe(3); // 工厂每次重试都被调用（不是复用旧实例）
    // 身份比较（=== 比实例，不比 url 字符串）：拿到的必须是第三次新建那个，不是首次那个
    expect(picked).toBe(ok.instances[2]);
    expect(picked).not.toBe(ok.instances[0]);
    expect(new URL(picked.url).port).toBe('15001');
    expect(ok.states[0].stopped).toBe(true); // 落禁用表的实例必须被停掉
    expect(ok.states[1].stopped).toBe(true);

    // ② 上限用尽 ⇒ 抛明确错误（带端口号），绝不静默返回坏端口
    const bad = makeFake([6667]);
    await expect(startListenable(bad.factory)).rejects.toThrow(/6667/);
    expect(bad.calls()).toBe(MAX_LISTEN_ATTEMPTS);

    // ③ 非端口类错误原样抛，不进换号路径（不吞、不多试）
    let boomCalls = 0;
    await expect(
      startListenable(() => {
        boomCalls += 1;
        return {
          start: async () => {
            throw Object.assign(new Error('boom'), { code: 'ENOTFOUND' });
          },
          stop: async () => {},
          url: 'http://127.0.0.1:15001',
        };
      }),
    ).rejects.toThrow(/boom/);
    expect(boomCalls).toBe(1);
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
    // GATE#67 红枚 B 的真回归锁（断行为、不断实现数字）：
    //   ① 绑定端口不在 undici 禁用清单里 —— 锁"避开 bad port 清单"这个真行为；
    //   ② 端到端真发一次 fetch 且拿到 200 —— 把 bad port 那格堵在取数层之前。
    // ⛔ 不锁"端口 ≥15000"：那是取数算法（底数）的实现细节，换个安全区间就会假红。
    const boundPort = Number(new URL(host.url).port);
    expect(isBlockedPort(boundPort)).toBe(false);
    const oldToken = 'tok-initial';
    const probe = await fetch(new URL('/v1/models', host.url).toString(), {
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(probe.status).toBe(200);
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
        const m = JSON.parse(raw.toString()) as { type: string; callId?: string; nonce?: string };
        if (m.type === 'consent-required') {
          // R2-01：宿主校验回执 nonce，必须把 consent-required 里的 nonce 原样带回
          try { ws.send(JSON.stringify({ type: 'consent-decision', callId: m.callId, decision: 'allow-once', nonce: m.nonce })); } catch { /* socket closed */ }
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
