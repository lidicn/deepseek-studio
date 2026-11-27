// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll } from 'vitest';

// ㊿-c-补⑫ 件④：jsdom 的 window.confirm 未实现，注入层同文护栏会调它落 stderr。
// 全局 stub 为返回 true（确认放行）：不弹真框、不拦截。
beforeAll(() => {
  (window as unknown as Record<string, unknown>).confirm = () => true;
});

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

import { createHash } from 'node:crypto';
import { installMainWorldInterceptor, AUTH_SENSITIVE_KEYS, maskAuthResponseBody } from '../../src/inject/main-world-interceptor';

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

  it('⑩-b：boot-check 本体抛错 ⇒ 恰好 1 行 `[auth] boot-check-failed <reason>`（catch 不再静默）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    // 让 logBootCheck 的 try 块在读 document.cookie 时抛错（jsdom 的 cookie 访问器可被实例级覆写）
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        throw new Error('cookie-denied');
      },
    });
    let handle: { stop: () => void } | undefined;
    try {
      ({ handle } = installHarness(diag)); // 安装即走 readyState=complete 即时路径 ⇒ catch 当场触发
      const failed = diagLines(diag).filter((l) => l.startsWith('[auth] boot-check-failed'));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('cookie-denied');
      // 异常路径不出正常 boot-check 行（两者互斥、各至多一行）
      expect(diagLines(diag).filter((l) => l.startsWith('[auth] boot-check user='))).toHaveLength(0);
    } finally {
      handle?.stop();
      if (original) Object.defineProperty(document, 'cookie', original);
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

describe('㉒ 格1：auth 响应体敏感值掩码（掩码值不删行；非敏感键照常可读）', () => {
  const TOKEN64 = 'a'.repeat(32) + 'b'.repeat(32); // 64 字符假令牌
  const expectedSha16 = createHash('sha256').update(TOKEN64).digest('hex').slice(0, 16).toUpperCase();

  it('XHR users/current 200 体含 64 字符 token ⇒ resp-body 行无原值、含 <len=64 sha16=…>（摘要与 node sha256 互核）、非敏感键 biz_code 可读', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('GET', 'https://chat.deepseek.com/api/v0/users/current');
      x.send('');
      x.respond(200, JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, token: TOKEN64 } }));
      const line = diagLines(diag).find((l) => l.startsWith('[auth] resp-body /api/v0/users/current'));
      expect(line).toBeDefined();
      expect(line).not.toContain(TOKEN64);
      expect(line).toContain(`<len=64 sha16=${expectedSha16}>`);
      expect(line).toContain('biz_code');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('fetch 侧同形：clone().text() 体含 token ⇒ 掩码后落行、摘要同值', async () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const body = JSON.stringify({ code: 0, data: { token: TOKEN64, biz_code: 7 } });
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      clone: () => ({ text: async () => body }),
    }));
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch);
    const { handle } = installHarness(diag);
    try {
      void (globalThis.fetch as unknown as (u: string, i?: unknown) => Promise<unknown>)('https://chat.deepseek.com/api/v0/users/current');
      await vi.advanceTimersByTimeAsync(500);
      const line = diagLines(diag).find((l) => l.startsWith('[auth] resp-body /api/v0/users/current'));
      expect(line).toBeDefined();
      expect(line).not.toContain(TOKEN64);
      expect(line).toContain(`<len=64 sha16=${expectedSha16}>`);
      expect(line).toContain('biz_code');
    } finally {
      handle.stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('格1 边界锁：device_id 等取证键不进掩码表（值照常可读；表恰为卡面 10 枚，防后来人误加）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('GET', 'https://chat.deepseek.com/api/v0/users/current');
      x.send('');
      x.respond(200, JSON.stringify({ code: 0, data: { device_id: 'ENCRYPTED-DEVICE-ID', biz_code: 1 } }));
      const line = diagLines(diag).find((l) => l.startsWith('[auth] resp-body /api/v0/users/current'));
      expect(line).toBeDefined();
      expect(line).toContain('ENCRYPTED-DEVICE-ID'); // 取证键不掩
      expect(AUTH_SENSITIVE_KEYS.has('device_id')).toBe(false);
      expect(AUTH_SENSITIVE_KEYS.size).toBe(10);
      for (const k of ['token', 'access_token', 'refresh_token', 'api_key', 'secret', 'password', 'captcha', 'verify_code', 'authorization', 'cookie']) {
        expect(AUTH_SENSITIVE_KEYS.has(k)).toBe(true);
      }
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('掩码单元自检：已知向量 sha256("abc") 前 16 位＋非 JSON／JSON 原始值整串掩码＋corrupt 返回空串', () => {
    const masked = maskAuthResponseBody(JSON.stringify({ token: 'abc' }));
    expect(masked).toContain('<len=3 sha16=BA7816BF8F01CFEA>');
    // PM 裁定：auth 端点面内非 JSON 整串 <len=N sha16=…>（原值零出现）
    const html = '<html>error page</html>';
    const mHtml = maskAuthResponseBody(html);
    expect(mHtml).toContain('<len=');
    expect(mHtml).not.toContain(html);
    const mPlain = maskAuthResponseBody('plain text body');
    expect(mPlain).not.toContain('plain text body');
    // corrupt（形似 JSON 解析失败）⇒ 空串＝调用点落 <omitted…> 行
    expect(maskAuthResponseBody('{broken json')).toBe('');
    expect(maskAuthResponseBody(JSON.stringify('"bare-string-token"'))).not.toContain('"bare-string-token"');
  });

  it('㉒ 复核补锁①：corrupt JSON（以 { 开头解析失败）⇒ resp-body 行含 omitted、原值零出现（XHR）', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('GET', 'https://chat.deepseek.com/api/v0/users/current');
      x.send('');
      const corrupt = '{"code":0,"data":{"token":"TRUNC";'; // 以 { 开头、解析必失败
      x.respond(200, corrupt);
      const line = diagLines(diag).find((l) => l.startsWith('[auth] resp-body /api/v0/users/current'));
      expect(line).toBeDefined();
      expect(line).toContain('<omitted: mask-failed, body not written>');
      expect(line).not.toContain('TRUNC');
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });

  it('㉒ 复核补锁②：非 JSON 响应体（HTML）⇒ 整串 <len=N sha16=…>、原值零出现（XHR＋fetch 两路）', async () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    // 拦截器安装时捕获 globalThis.fetch——stub 必须先于 installHarness 就位（同族既有 fetch 锁的顺序纪律）
    const html = '<html><body>waf-blocked</body></html>';
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      clone: () => ({ text: async () => html }),
    }));
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch);
    const { FakeXHR, handle } = installHarness(diag);
    try {
      const x = newXhr(FakeXHR);
      x.open('GET', 'https://chat.deepseek.com/api/v0/users/current');
      x.send('');
      x.respond(200, html);
      void (globalThis.fetch as unknown as (u: string) => Promise<unknown>)('https://chat.deepseek.com/api/v0/users/logout');
      await vi.advanceTimersByTimeAsync(500);
      const lines = diagLines(diag);
      const xLine = lines.find((l) => l.startsWith('[auth] resp-body /api/v0/users/current'));
      expect(xLine).toBeDefined();
      expect(xLine).toContain('<len=');
      expect(xLine).not.toContain('waf-blocked');
      const fLine = lines.find((l) => l.startsWith('[auth] resp-body /api/v0/users/logout'));
      expect(fLine).toBeDefined();
      expect(fLine).toContain('<len=');
      expect(fLine).not.toContain('waf-blocked');
    } finally {
      handle.stop();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('㉒ 格2：ls-read-fail 键名射程收窄（UI 态／第三方分析键不得触发）', () => {
  it('`__session_page_size__`／`__tea_session_id_20006317` 读 miss ⇒ 零行；`userToken`（DeepSeek 会话键）miss ⇒ 恰一行', () => {
    vi.useFakeTimers();
    const diag = vi.fn();
    const { handle } = installHarness(diag);
    try {
      localStorage.removeItem('__session_page_size__');
      localStorage.getItem('__session_page_size__'); // UI 态：不得触发
      localStorage.removeItem('__tea_session_id_20006317');
      localStorage.getItem('__tea_session_id_20006317'); // 腾讯分析会话号：不得触发
      expect(diagLines(diag).filter((l) => l.startsWith('[auth] ls-read-fail')).length).toBe(0);
      localStorage.removeItem('userToken');
      localStorage.getItem('userToken'); // 站点真实会话键：触发
      expect(diagLines(diag).filter((l) => l.startsWith('[auth] ls-read-fail userToken'))).toHaveLength(1);
    } finally {
      localStorage.removeItem('__session_page_size__');
      localStorage.removeItem('__tea_session_id_20006317');
      localStorage.removeItem('userToken');
      handle.stop();
      vi.useRealTimers();
    }
  });
});
