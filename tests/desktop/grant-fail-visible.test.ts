// @vitest-environment jsdom
/**
 * 裁定五十七 缺陷③（P0，v0.14.8 真机）页面侧那条腿：
 * 取券闭包在 **IPC 层**抛错（含 `Command … not allowed by ACL`）必须 fail-visible ——
 * 面板出可见横幅（带**真实原因**，不只写「不可用」）+ 页端留**可 grep 痕迹**
 * （宿主侧结构上拿不到这次失败：ACL 拒绝发生在 Rust 函数执行前，宿主日志全被绕过）。
 *
 * 负控（PM 原话）：模拟闭包抛 `Command … not allowed by ACL` → 必须出横幅；静默判红。
 * `host-down` 停止不重试的语义不变（本测试只验「停止必须可见」）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireGrant,
  GRANT_FALLBACK_BARE_URL_CAUSE,
  GRANT_REPLY_SHAPE_VIOLATION_CAUSE,
  type RequestGrantFn,
} from '../../src/desktop/grant-acquire';
import { createGrantBanner, surfaceGrantFailure, installStudio } from '../../src/desktop/entry';

describe('裁定五十七 缺陷③ · 取券闭包抛错 → 页端 fail-visible', () => {
  beforeEach(() => {
    // 防止 entry.ts 顶层 auto-init（jsdom 无 WebSocket 时本就不触发，这里再钉一道）。
    (globalThis as { __deepseekStudio?: unknown }).__deepseekStudio = {};
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __studioGrantStatus?: unknown }).__studioGrantStatus;
    document.body.replaceChildren();
  });

  it('负控（端到端链）：闭包抛 ACL → acquireGrant 捕获 cause → surfaceGrantFailure 出横幅（含真实原因）+ 页端可 grep 痕迹', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing: RequestGrantFn = async () => {
      throw new Error('Command studio_request_grant not allowed by ACL');
    };
    vi.stubGlobal('__studioRequestGrant', throwing);

    const result = await acquireGrant({ aud: 'main', backoffMs: [] });
    expect(result.grant).toBeNull();
    expect(result.attempts).toBe(1); // 停、不重试
    expect(result.lastError).toBe('host-down');
    expect(result.cause).toBe('Command studio_request_grant not allowed by ACL'); // 原文，非泛化枚举

    // 页端呈现：横幅挂到 document.body（真实 DOM），静默即红。
    const banner = createGrantBanner({ enabled: true, getMount: () => document.body });
    surfaceGrantFailure(result, 'main', banner.setBanner);

    const el = document.querySelector('[data-studio-grant-banner]');
    expect(el).not.toBeNull(); // 横幅真的挂上了
    const text = el!.textContent ?? '';
    expect(text).toContain('宿主凭据不可用'); // 可见
    expect(text).toContain('Command studio_request_grant not allowed by ACL'); // **真实原因**
    expect(text).toContain('已停止'); // host-down = 停止不重试（语义不变）

    // 页端可 grep 痕迹（宿主侧拿不到，CDP/Verify 直接读 window.__studioGrantStatus）
    const status = (globalThis as { __studioGrantStatus?: { stage: string; failed: boolean; lastError: string | null; cause: string | null } }).__studioGrantStatus;
    expect(status).toBeDefined();
    expect(status!.stage).toBe('resolver-invoked'); // 裁定五十七 0.14.9 判别仪：失败必钉 resolver-invoked（第 3 选），CDP 直读可判
    expect(status!.failed).toBe(true);
    expect(status!.lastError).toBe('host-down');
    expect(status!.cause).toBe('Command studio_request_grant not allowed by ACL');

    // console.error 也留痕（页端控制台可 grep `[studio-grant]`）
    expect(consoleErrorSpy).toHaveBeenCalled();
    const logged = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('[studio-grant]');
    expect(logged).toContain('not allowed by ACL');
  });

  it('裁定五十八：回落裸连（no-config 枚举）vs ACL 拒绝（闭包抛错）现场互斥可判（CDP 三选一）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const banner = createGrantBanner({ enabled: true, getMount: () => document.body });

    // 场景 A：回落裸连（no-config 退避耗尽，枚举、非闭包抛错）⇒ cause=稳定字面量（与 Core absent 成对）
    surfaceGrantFailure(
      { grant: null, attempts: 6, lastError: 'no-config', cause: GRANT_FALLBACK_BARE_URL_CAUSE },
      'main',
      banner.setBanner,
    );
    let status = (globalThis as { __studioGrantStatus?: Record<string, unknown> }).__studioGrantStatus;
    expect(status!.stage).toBe('resolver-invoked');
    expect(status!.failed).toBe(true);
    expect(status!.lastError).toBe('no-config');
    expect(status!.cause).toBe(GRANT_FALLBACK_BARE_URL_CAUSE); // 稳定字面量，非「只留枚举」
    let el = document.querySelector('[data-studio-grant-banner]');
    expect(el!.textContent).toContain('回落裸连'); // 横幅明说「非 ACL」
    expect(el!.textContent).toContain('grant-fallback-bare-url');
    expect(el!.textContent).not.toContain('取券闭包抛错'); // 回落场景不得误标成「闭包抛错」

    // 场景 B：ACL 拒绝（闭包抛错、IPC 原文）⇒ cause 含 ACL 原文（缺陷① 未修信号），保留「闭包抛错」标签
    surfaceGrantFailure(
      { grant: null, attempts: 1, lastError: 'host-down', cause: 'Command studio_request_grant not allowed by ACL' },
      'main',
      banner.setBanner,
    );
    status = (globalThis as { __studioGrantStatus?: Record<string, unknown> }).__studioGrantStatus;
    expect(status!.lastError).toBe('host-down');
    expect(String(status!.cause)).toContain('not allowed by ACL');
    el = document.querySelector('[data-studio-grant-banner]');
    expect(el!.textContent).toContain('取券闭包抛错');
    expect(el!.textContent).toContain('not allowed by ACL');

    // 场景 C：形状违例（闭包正常返回但违反可辨识联合）⇒ cause=稳定字面量（宿主/页端版本不配对），
    // 横幅「形状违例」文案与 场景 A（回落裸连）/ 场景 B（闭包抛错）**互异**（现场三选一可判）。
    surfaceGrantFailure(
      { grant: null, attempts: 1, lastError: 'host-down', cause: GRANT_REPLY_SHAPE_VIOLATION_CAUSE },
      'main',
      banner.setBanner,
    );
    status = (globalThis as { __studioGrantStatus?: Record<string, unknown> }).__studioGrantStatus;
    expect(status!.cause).toBe(GRANT_REPLY_SHAPE_VIOLATION_CAUSE); // 稳定字面量，非自由句式
    expect(status!.cause).toBe('grant-reply-shape-violation');
    el = document.querySelector('[data-studio-grant-banner]');
    expect(el!.textContent).toContain('形状违例'); // 专属文案
    expect(el!.textContent).toContain('grant-reply-shape-violation');
    expect(el!.textContent).not.toContain('回落裸连'); // 与场景 A 互异
    expect(el!.textContent).not.toContain('取券闭包抛错'); // 与场景 B 互异
  });

  it('横幅 enabled=false（非主窗/登录页）：surfaceGrantFailure 仍留页端痕迹，但不挂 DOM 横幅', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const banner = createGrantBanner({ enabled: false, getMount: () => document.body });
    surfaceGrantFailure(
      { grant: null, attempts: 1, lastError: 'host-down', cause: 'Command studio_request_grant not allowed by ACL' },
      'main',
      banner.setBanner,
    );
    // enabled=false → 横幅不挂 DOM（非主窗形态），但页端痕迹仍在
    expect(document.querySelector('[data-studio-grant-banner]')).toBeNull();
    const status = (globalThis as { __studioGrantStatus?: { failed: boolean } }).__studioGrantStatus;
    expect(status?.failed).toBe(true);
  });

  it('createGrantBanner DOM 行为：setBanner(msg) 挂到 body、setBanner(null) 移除（重复 set 不重复挂）', () => {
    const banner = createGrantBanner({ enabled: true, getMount: () => document.body });
    banner.setBanner('正在等待宿主就绪…（获取连接凭据）');
    let el = document.querySelector('[data-studio-grant-banner]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('正在等待宿主就绪…（获取连接凭据）');
    // 重复 set（不同文案）：复用同一元素、更新文案，不新增节点
    banner.setBanner('宿主凭据不可用，agent 能力离线（原因：host-down；取券闭包抛错：X）。已停止（不可重试）。');
    expect(document.querySelectorAll('[data-studio-grant-banner]').length).toBe(1);
    expect(banner.el()?.textContent).toContain('取券闭包抛错：X');
    // 移除
    banner.setBanner(null);
    expect(document.querySelector('[data-studio-grant-banner]')).toBeNull();
    expect(banner.el()).toBeNull();
  });
});

/**
 * 裁定五十七 0.14.9 判别仪（PM 裁）：`__studioGrantStatus` 的 `stage` 字段把「只能真机暴露」的
 * 缺陷变成 CDP 直读一次四选一。这里端到端驱动 installStudio 的取券 bootstrap，验「进过 resolver」
 * 后的两类终态（第 3 选 ACL 拒绝 / 第 4 选成功）；「无痕 = 注入没跑」「停在 init = connect 没被调」
 * 是纯现场取证态（需真实缺陷才触发），不在单测构造，只验字段存在与钉值正确。
 */
describe('裁定五十七 0.14.9 判别仪 · installStudio 端到端 stage 链', () => {
  /** 假 WebSocket：installStudio 的 host-client 走它，不发起真连接（jsdom 未必提供真 WebSocket）。 */
  class FakeWS {
    readyState = 1;
    onopen: ((ev?: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    send(): void {}
    close(): void {}
  }
  /** 冲刷 resolver 异步链（acquireGrant 结果 + .then 写状态 + connectWsRound 续行）。 */
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    (globalThis as { __deepseekStudio?: unknown }).__deepseekStudio = {};
    vi.stubGlobal('WebSocket', FakeWS);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { __studioGrantStatus?: unknown }).__studioGrantStatus;
    delete (globalThis as { __deepseekStudio?: unknown }).__deepseekStudio;
    document.body.replaceChildren();
  });

  it('第 3 选：ACL 拒绝（闭包抛错）→ resolver-invoked + failed:true + cause（CDP 直读可判）', async () => {
    const throwing: RequestGrantFn = async () => {
      throw new Error('Command studio_request_grant not allowed by ACL');
    };
    vi.stubGlobal('__studioRequestGrant', throwing);
    installStudio({ botId: 'writer' });
    await flush();
    const status = (globalThis as { __studioGrantStatus?: Record<string, unknown> }).__studioGrantStatus;
    expect(status).toBeDefined();
    expect(status!.stage).toBe('resolver-invoked');
    expect(status!.failed).toBe(true);
    expect(status!.lastError).toBe('host-down');
    expect(status!.cause).toBe('Command studio_request_grant not allowed by ACL');
  });

  it('第 4 选：取券成功 → resolver-invoked + failed:false（无 cause、无 lastError）', async () => {
    const ok: RequestGrantFn = async () => ({ ok: true, grant: 'g-main#1', expMs: 60_000 });
    vi.stubGlobal('__studioRequestGrant', ok);
    installStudio({ botId: 'writer' });
    await flush();
    const status = (globalThis as { __studioGrantStatus?: Record<string, unknown> }).__studioGrantStatus;
    expect(status).toBeDefined();
    expect(status!.stage).toBe('resolver-invoked');
    expect(status!.failed).toBe(false);
    expect(status!.cause).toBeUndefined();
    expect(status!.lastError).toBeUndefined();
  });
});
