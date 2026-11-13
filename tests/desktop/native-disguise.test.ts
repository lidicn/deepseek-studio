import { describe, expect, it, vi } from 'vitest';
import { installMainWorldInterceptor } from '../../src/inject/main-world-interceptor';

// @vitest-environment jsdom

/**
 * 判据 4 回归锁（修复「注入环境下站点 SDK 拒发 device_id」的持久锁，不依赖真机）。
 *
 * 最小致因（真机二分成因）：XMLHttpRequest.prototype.send 包装被站点 SDK 探测为非原生
 * （加载早期缓存「篡改」判定），登录时拒发 device_id ⇒ 422 body.device_id。
 * 修复形态：保留原型 patch（工具回注依赖 send 拦截出口），替身补 [native code] 原生外观
 * （src/inject/native-disguise.ts：Function.prototype.toString 对替身返回 [native code] 形态，
 * 含 .call(fn) 旁路与 probe-of-probe 一致性；非伪装函数逐字节委托原实现）。
 */

const NATIVE_FORM = /^\s*function \w+\(\)\s*\{\s*\[native code\]\s*\}\s*$/;

function makeChatUI() {
  return {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    appendToAssistantMessage: vi.fn(),
    appendReasoning: vi.fn(),
    finishAssistantMessage: vi.fn(),
    appendError: vi.fn(),
    setBusy: vi.fn(),
    setContextNotice: vi.fn(),
    startToolCard: vi.fn(() => true),
    finishToolCard: vi.fn(),
  };
}

function installDefault() {
  return installMainWorldInterceptor({
    sender: vi.fn(async () => ({ ok: true })),
    chatUI: makeChatUI() as never,
    diag: () => {},
  });
}

describe('判据 4 ①：注入后被 patch 的原型方法在 [native code] 形态（toString 三条路全通）', () => {
  it('fetch / XHR 四方法：String()、fn.toString()、Function.prototype.toString.call(fn) 全为 [native code] 形态', () => {
    const handle = installDefault();
    try {
      const fts = Function.prototype.toString;
      const fns: Array<[string, Function]> = [
        ['fetch', window.fetch],
        ['send', XMLHttpRequest.prototype.send],
        ['open', XMLHttpRequest.prototype.open],
        ['setRequestHeader', XMLHttpRequest.prototype.setRequestHeader],
        ['abort', XMLHttpRequest.prototype.abort],
      ];
      for (const [name, fn] of fns) {
        expect(String(fn), `${name}: String()`).toMatch(NATIVE_FORM);
        expect(fn.toString(), `${name}: fn.toString()`).toMatch(NATIVE_FORM);
        expect(fts.call(fn), `${name}: Function.prototype.toString.call()`).toMatch(NATIVE_FORM);
      }
      // probe-of-probe 一致性：探探测器的探测器
      expect(fts.call(fts)).toMatch(NATIVE_FORM);
      // 非伪装函数逐字节委托原实现（行为零变化）
      const f = function hello() {
        return 1;
      };
      expect(fts.call(f)).toContain('function hello');
      expect(fts.call(f)).toContain('return 1');
      expect(String(f)).toContain('function hello');
    } finally {
      handle.stop();
    }
  });

  it('停装后（stop 复原原生）：原生方法本来就不在伪装集，输出不受影响', () => {
    const jsdomSend = XMLHttpRequest.prototype.send;
    const handle = installDefault();
    handle.stop();
    // stop 后原型回到 jsdom 原生；原生函数不在 DISGUISED 集合，toString 输出其自身（jsdom 实现），
    // 断言「stop 后引用复原」这一关键卫生属性（不锁 jsdom 原生源码内容）。
    expect(XMLHttpRequest.prototype.send).toBe(jsdomSend);
  });
});

describe('判据 4 ②：非 chat 端点 body/headers 逐字节透传（默认全开形态下）', () => {
  it('send 交给原生层的 body 是同一引用；setRequestHeader 的 name/value 原样透传', () => {
    const jsdomSend = XMLHttpRequest.prototype.send;
    const jsdomSRH = XMLHttpRequest.prototype.setRequestHeader;
    const sendSpy = vi.fn(jsdomSend);
    const srhSpy = vi.fn(jsdomSRH);
    XMLHttpRequest.prototype.send = sendSpy;
    XMLHttpRequest.prototype.setRequestHeader = srhSpy;
    const handle = installDefault();
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://127.0.0.1:9/definitely-not-chat');
      xhr.setRequestHeader('X-Custom', 'v1');
      expect(srhSpy.mock.calls.length).toBe(1);
      expect(srhSpy.mock.calls[0]).toEqual(['X-Custom', 'v1']); // 非 chat：不记录、原样透传
      const body = JSON.stringify({ device_id: null, password: 'ProbePass123!' });
      xhr.send(body);
      expect(sendSpy.mock.calls.length).toBe(1);
      expect(sendSpy.mock.calls[0][0]).toBe(body); // 同一引用 ⇒ 逐字节
    } finally {
      handle.stop();
      XMLHttpRequest.prototype.send = jsdomSend;
      XMLHttpRequest.prototype.setRequestHeader = jsdomSRH;
    }
  });
});

describe('零实例痕迹锁：注入层不得给 XHR 实例添加自有属性（站点 SDK 实例属性基线差分 ⇒ 拒发 device_id）', () => {
  it('非 chat 实例经 open+send 后，自有属性集合与全新实例一致（零添加）', () => {
    const handle = installDefault();
    try {
      const baseline = new XMLHttpRequest();
      const baselineNames = Object.getOwnPropertyNames(baseline);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://127.0.0.1:9/definitely-not-chat');
      xhr.setRequestHeader('X-Custom', 'v1');
      xhr.send('body');
      // 站点 SDK 的检测面：实例「多出的自有属性」。注入层（WeakMap 形态）必须零添加。
      // （onreadystatechange 等标准属性赋值不算「多出」；__ds* 自有属性才触发差分。）
      expect(Object.getOwnPropertyNames(xhr).sort()).toEqual([...baselineNames].sort());
    } finally {
      handle.stop();
    }
  });

  it('chat 实例：流式解析器状态不落在实例自有属性上', () => {
    const jsdomSend = XMLHttpRequest.prototype.send;
    const sendSpy = vi.fn(jsdomSend);
    XMLHttpRequest.prototype.send = sendSpy;
    const handle = installDefault();
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion');
      const before = Object.getOwnPropertyNames(xhr).length;
      xhr.send(JSON.stringify({ prompt: 'hi' }));
      // 即便 chat 分支（会挂流解析器），实例也不得新增自有属性（解析器存模块级 WeakMap）。
      // sendSpy 拦截了真正的网络层，onreadystatechange 回调不会触发——断言面是「send 后实例零添加」。
      const after = Object.getOwnPropertyNames(xhr);
      expect(after.filter((n) => n.startsWith('__ds'))).toEqual([]);
      expect(after.length).toBeLessThanOrEqual(before + 1); // 至多标准属性变化，无 __ds*
    } finally {
      handle.stop();
      XMLHttpRequest.prototype.send = jsdomSend;
    }
  });
});
