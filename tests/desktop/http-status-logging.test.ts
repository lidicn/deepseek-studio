// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * ⑩ 取证盲区补齐回归锁（2026-11-15 PM 卡⑩，扩面后＝登录态全量取证）：
 * 背景：出资人反复掉登录态，本机侧全排除后，取证盲区＝「服务端何时作废会话」在日志里不可见。
 *
 * 判据（PM 卡）：
 *   ① 401 响应 ⇒ 日志含 `[auth] HTTP 401 on …/api/…` 独立行（每请求至多一行）；
 *   ② 非 API 域（第三方域）200 ⇒ 不新增任何日志行；
 *   ③ 不回归锁：既有 `xhr resp[N]` 的 N＝字节数语义不变（首个方括号仍为字节数）；
 *   ④ fetch 路径同形（chat 端点 401 ⇒ fetch resp[HTTP 401]＋[auth] 行）；
 *   格2：users/* 请求参数脱敏留痕（键名＋device_id 有无＋*type 值，不落明文密码）＋响应码＋响应体首 200 字；
 *   格3：set-cookie ⇒ `[auth] set-cookie <name> expires=…`（不记值；XHR 头拿不到 ⇒ auth 端点记 unavailable、不假装）；
 *   格4：boot-check 每次安装恰好一行（user/cookie_count/did）；
 *   格5：会话键读失败 ⇒ `[auth] ls-read-fail <key>` 一行（去重不刷屏；非会话键零行）。
 * 负控：摘掉 [auth] 接线分支 ⇒ ① 红，字节备份还原 SHA 全等。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'http-status-stub' })),
}));

import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function makeFakeXhrClass() {
  class FakeXHR {
    static instances: FakeXHR[] = [];
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: Handler = null;
    method = '';
    url = '';
    headers: Record<string, string> = {};
    body: string | null = null;
    /** ⑩ 格3：set-cookie 头（默认拿不到＝多数 WebView 真实现；逐用例可覆写）。 */
    getResponseHeader: (name: string) => string | null = () => null;
    private loadendCbs: Array<() => void> = [];
    constructor() {
      FakeXHR.instances.push(this);
    }
    open(m: string, u: string | URL) {
      this.method = m;
      this.url = String(u);
      this.readyState = 1;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(body?: string | null) {
      this.body = typeof body === 'string' ? body : null;
    }
    addEventListener(type: string, cb: () => void) {
      if (type === 'loadend') this.loadendCbs.push(cb);
    }
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
      for (const cb of [...this.loadendCbs]) cb();
    }
    abort() {
      this.status = 0;
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  }
  return FakeXHR;
}
/** 结构型实例视图（构造器 cast 用，避开 TS2749 value/type 冲突）。 */
type FakeXHRInstance = {
  open: (m: string, u: string | URL) => void;
  onreadystatechange: Handler | null;
  send: (b?: string | null) => void;
  respond: (s: number, t: string) => void;
  readyState: number;
  status: number;
  addEventListener: (t: string, cb: () => void) => void;
  getResponseHeader: (n: string) => string | null;
};
function newXhr(FakeXHR: unknown): FakeXHRInstance {
  return new (FakeXHR as unknown as new () => FakeXHRInstance)();
}

type Diag = ReturnType<typeof vi.fn>;

function installHarness(diag: Diag) {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'ok', exitCode: 0 } }));
  const chatUI = {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    hasOpenAssistantBubble: vi.fn(() => false),
    appendToAssistantMessage: vi.fn(),
    appendReasoning: vi.fn(),
    finishAssistantMessage: vi.fn(),
    appendError: vi.fn(),
    setBusy: vi.fn(),
    setContextNotice: vi.fn(),
    startToolCard: vi.fn(() => true),
    finishToolCard: vi.fn(),
  };
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: diag as never,
  });
  return { FakeXHR, handle };
}

function diagLines(diag: Diag): string[] {
  return diag.mock.calls.map((c) => String(c[0]));
}

describe('⑩ XHR 路径：401/403 ⇒ [auth] 独立行（每请求至多一行）', () => {
  it('chat 端点 401 ⇒ `[auth] HTTP 401` 一行且带 /api/ 路径（rs=3/4 两次回调不刷屏）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('POST', CHAT_URL);
      x.onreadystatechange = () => {};
      x.send(JSON.stringify({ prompt: 'hi', chat_session_id: 'auth-401' }));
      x.respond(401, '{"code":401,"msg":"session expired"}');
      const auth = diagLines(diag).filter((l) => l.startsWith('[auth] HTTP 401'));
      expect(auth.length).toBe(1);
      expect(auth[0]).toContain('/api/v0/chat/completion');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('chat 端点 403 ⇒ `[auth] HTTP 403` 一行（同分支覆盖）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('POST', CHAT_URL);
      x.onreadystatechange = () => {};
      x.send(JSON.stringify({ prompt: 'hi', chat_session_id: 'auth-403' }));
      x.respond(403, '{"code":403}');
      expect(diagLines(diag).filter((l) => l.startsWith('[auth] HTTP 403'))).toHaveLength(1);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑩ 范围门：非 API 域零新增行', () => {
  it('第三方域（gator.volces.com）200 ⇒ 无 [auth] 行、无 xhr resp 行', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('GET', 'https://gator.volces.com/api/track');
      x.send('ping');
      x.respond(200, '{"ok":true}');
      const lines = diagLines(diag);
      // boot-check 是安装级（格4 自己的锁管它）；这里只断言「请求级」[auth] 行为零。
      const requestAuth = lines.filter((l) => l.startsWith('[auth]') && !l.startsWith('[auth] boot-check'));
      expect(requestAuth.length).toBe(0);
      expect(lines.some((l) => l.startsWith('xhr resp['))).toBe(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑩ 不回归锁：既有 resp[N] 字节数语义不变', () => {
  it('chat 200：`xhr resp[N]` 首个方括号仍为字节数（N 旧语义），状态码为旁挂字段', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('POST', CHAT_URL);
      x.onreadystatechange = () => {};
      x.send(JSON.stringify({ prompt: 'hi', chat_session_id: 'resp-bytes' }));
      const body = 'data: {"v":"hi"}\n\n';
      x.respond(200, body);
      const respLines = diagLines(diag).filter((l) => l.startsWith('xhr resp['));
      expect(respLines.length).toBeGreaterThanOrEqual(1);
      // 不回归锁：行首方括号＝本次增量字节数（旧语义逐字保留），状态码是行内旁挂。
      // （toMatch 传字符串是 includes 语义——必须传 RegExp 才是正则匹配，这里正是踩坑点。）
      expect(respLines[0]).toMatch(new RegExp(`^xhr resp\\[${body.length}\\]:`));
      expect(respLines[0]).toContain('(HTTP 200)');
      // 200 不挂 [auth] 状态行（boot-check 是安装级，排除在外）
      expect(diagLines(diag).some((l) => l.startsWith('[auth]') && !l.startsWith('[auth] boot-check'))).toBe(false);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑩ fetch 路径：chat 端点 401 ⇒ 状态行＋[auth] 行', () => {
  it('fetch 401 ⇒ `fetch resp[HTTP 401]`＋`[auth] HTTP 401`（非 chat 域经 L1744 原样放行、零新增行）', async () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    // 拦截器安装时捕获 globalThis.fetch——stub 必须在 install 之前就位。
    const fetchStub = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: null,
    }));
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch);
    const { handle } = installHarness(diag);
    try {
      void (globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<unknown>)(
        CHAT_URL,
        { method: 'POST', body: JSON.stringify({ prompt: 'hi', chat_session_id: 'f-401' }) },
      );
      await vi.advanceTimersByTimeAsync(500);
      const lines = diagLines(diag);
      expect(lines).toContain('fetch resp[HTTP 401]');
      expect(lines.filter((l) => l.startsWith('[auth] HTTP 401')).length).toBe(1);
      // 格3（fetch 侧）：getSetCookie 方法缺失 ⇒ 记一次 unavailable（不假装拿到）。
      expect(lines.some((l) => l.includes('[auth] set-cookie unavailable'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('⑩ 格2：auth 面接口全量留痕（users/*，脱敏）', () => {
  it('users/login XHR ⇒ 请求行（键名＋device_id 有无＋*type 值，不落明文密码/加密值）＋响应码＋响应体首 200 字', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('POST', 'https://chat.deepseek.com/api/v0/users/login');
      x.send(JSON.stringify({ device_id: 'ENCRYPTED-VALUE', mobile: '13800000000', password: 'SECRET-PW', verify_type: 'sms' }));
      x.respond(200, '{"code":0,"data":{"biz_code":2,"biz_msg":"PASSWORD_OR_USER_NAME_IS_WRONG"}}');
      const lines = diagLines(diag);
      const reqLine = lines.find((l) => l.startsWith('[auth] req POST /api/v0/users/login'));
      expect(reqLine).toBeDefined();
      expect(reqLine).toContain('device_id=present');
      expect(reqLine).toContain('verify_type=sms'); // 验证码类型落
      expect(reqLine).not.toContain('SECRET-PW'); // 明文密码不落
      expect(reqLine).not.toContain('ENCRYPTED-VALUE'); // device_id 值不落
      expect(lines.some((l) => l.startsWith('[auth] resp POST /api/v0/users/login HTTP 200'))).toBe(true);
      expect(lines.some((l) => l.startsWith('[auth] resp-body /api/v0/users/login'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑩ 格3：set-cookie 变动事件（不记值；拿不到就记 unavailable，不假装拿到）', () => {
  it('chat XHR 200＋Set-Cookie 头 ⇒ `[auth] set-cookie <name> expires=…` 一行（值不记）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.getResponseHeader = (n) =>
        n.toLowerCase() === 'set-cookie' ? 'sid=abc123; Expires=Thu, 01 Jan 2027 00:00:00 GMT; Path=/' : null;
      x.open('POST', CHAT_URL);
      x.send(JSON.stringify({ prompt: 'hi', chat_session_id: 'sc-1' }));
      x.respond(200, 'data: {"v":"ok"}\n\n');
      const sc = diagLines(diag).filter((l) => l.startsWith('[auth] set-cookie sid'));
      expect(sc).toHaveLength(1);
      expect(sc[0]).toContain('expires=Thu, 01 Jan 2027'); // Expires 里的逗号不被切碎
      expect(sc[0]).not.toContain('abc123'); // 值不记
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('users/* XHR 且 set-cookie 头拿不到 ⇒ `[auth] set-cookie unavailable`（auth 端点记、不假装拿到）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('GET', 'https://chat.deepseek.com/api/v0/users/current');
      x.send('');
      x.respond(200, '{}');
      expect(diagLines(diag).some((l) => l.startsWith('[auth] set-cookie unavailable on /api/v0/users/current'))).toBe(true);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑩ 格4：页面载入登录态自检（每次安装恰好一行）', () => {
  it('install ⇒ 恰好 1 行 `[auth] boot-check`（user/cookie_count/did 三字段齐）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { handle } = installHarness(diag);
    try {
      const lines = diagLines(diag).filter((l) => l.startsWith('[auth] boot-check'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[auth\] boot-check user=(存在|缺失) cookie_count=\d+ did=.+$/);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('⑩ 格5：本地存储读失败探针（只读、零写入）', () => {
  it('会话键读 miss ⇒ 一行 `[auth] ls-read-fail <key>`（同键去重不刷屏；非会话键零行）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { handle } = installHarness(diag);
    try {
      localStorage.removeItem('studio_probe_token');
      localStorage.getItem('studio_probe_token'); // miss #1 ⇒ 一行
      localStorage.getItem('studio_probe_token'); // miss #2 ⇒ 不再新增
      expect(diagLines(diag).filter((l) => l.startsWith('[auth] ls-read-fail studio_probe_token'))).toHaveLength(1);
      localStorage.removeItem('plain_key_zz');
      localStorage.getItem('plain_key_zz'); // 非会话键：零行
      expect(diagLines(diag).some((l) => l.includes('ls-read-fail plain_key_zz'))).toBe(false);
    } finally {
      localStorage.removeItem('studio_probe_token');
      localStorage.removeItem('plain_key_zz');
      handle.stop();
      vi.useRealTimers();
    }
  });
});
