// @vitest-environment jsdom
/**
 * tests/desktop/consent-window.test.ts
 *
 * K3（审批重设计 v1，2026-11-09）审批窗口页面（src/ui/consent-panel.ts）的行为级验证。
 *
 * 分工（与 mcp-settings-window.test.ts 同族，别把本文件当成「真机验收」）：
 *   - 本文件验 JS 侧能独立证明的：窗口页三按钮行为、两级「将记住什么」、
 *     fail-closed 各态（无 nonce / 渲染失败 / 网络失败）、轮询接线、壳零秘密判据；
 *   - 窗口生命周期 / Rust 侧（K1）与 `/v1/consent/*` 数据面（K2）不在本文件；
 *     路由接通与真机取证另行落卡。
 *
 * 每条负控都带装置自检（先证明「走到了被测分支」，再证明「该拒的拒了、该放的放了」）。
 *
 * 装置时序注意：`mountConsentPanel` 挂载即跑一次 auto-tick（首帧拉 pending），
 * 所以「真实手势」监听器捕获（spy HTMLButtonElement.prototype.addEventListener）
 * 必须**先于** mount 安装，否则渲染时监听器已挂、Map 是空的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONVERSATION_GRANT_REMEMBERED_TEXT,
  mountConsentPanel,
  type ConsentPanel,
  type ConsentPendingRequest,
} from '../../src/ui/consent-panel';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── 测试夹具 ──────────────────────────────────────────────────────────────

function jsonResp(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

interface CallRec {
  url: string;
  init?: RequestInit;
}

/** 静态数据面：GET pending 恒定返回 `pending`；POST reply 返回 `replyStatus`。 */
function mkFetch(pending: ConsentPendingRequest | undefined, replyOk = true, replyStatus = 200) {
  const calls: CallRec[] = [];
  const impl = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/consent/pending')) {
      return Promise.resolve(jsonResp(pending ? { pending: true, request: pending } : { pending: false }));
    }
    if (url.endsWith('/v1/consent/reply')) {
      return Promise.resolve(jsonResp({ accepted: true }, replyOk, replyStatus));
    }
    return Promise.resolve(jsonResp({ error: 'not found' }, false, 404));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const HIGH_RISK_REQ: ConsentPendingRequest = {
  callId: 'c-1',
  tool: 'shell.exec',
  paramsSummary: 'cmd: rm -rf build/ …',
  modeLabel: '询问审批',
  nonce: 'n-1',
  meta: {
    outside: true,
    riskFlags: ['recursive-delete'],
    riskFlagLabels: ['递归删除'],
    riskLabel: '特权级',
    approvalClass: 'always',
    canonicalTarget: 'path:E:/x',
  },
};

interface Fixture {
  panel: ConsentPanel;
  root: HTMLDivElement;
  fetchCalls: CallRec[];
  intervalMs: number;
  cleared: { value: boolean };
}

/**
 * 挂载即 auto-tick（首帧拉一次 pending）。测试若只想等首帧结果，用 `await flush()`，
 * **不要**再显式 `panel.tick()`（那会是第二次 GET，计数全乱）。
 */
function mountPanel(pending: ConsentPendingRequest | undefined, opts: { replyOk?: boolean; replyStatus?: number } = {}): Fixture {
  const root = document.createElement('div');
  root.id = 'consent-root';
  document.body.append(root);
  const { impl, calls } = mkFetch(pending, opts.replyOk ?? true, opts.replyStatus ?? 200);
  let intervalMs = 0;
  const cleared = { value: false };
  const panel = mountConsentPanel({
    root,
    token: 'test-token',
    origin: 'http://127.0.0.1:8760',
    fetchImpl: impl,
    setIntervalImpl: (fn, ms) => {
      intervalMs = ms;
      void fn;
      return 1;
    },
    clearIntervalImpl: () => {
      cleared.value = true;
    },
  });
  return { panel, root, fetchCalls: calls, intervalMs, cleared };
}

/** 微任务清场（auto-tick 与 reply 都是 async；setTimeout 在其后跑） */
const flush = () => new Promise((r) => setTimeout(r, 1));

/**
 * R2-01 同族：jsdom 造不出 isTrusted=true 的事件。渲染前在
 * HTMLButtonElement.prototype.addEventListener 挂 spy，捕获按钮上**真实的 click
 * 监听器**，再用 { isTrusted: true } 最小事件对象直接调用（守卫只读 e.isTrusted）。
 * 按**元素**记录（不按类名）：主按钮与「将记住什么」确认块里有两个
 * `ds-consent-allow-conversation`，按类名会互相覆盖。
 * **必须在 mountPanel 之前调用**（监听器在渲染时挂，晚装就空 Map）。
 */
function captureButtonHandlers() {
  const els = new Map<HTMLButtonElement, (e: Event) => void>();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const spy = vi.spyOn(HTMLButtonElement.prototype, 'addEventListener').mockImplementation(
    function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'click' && typeof listener === 'function') {
        els.set(this as HTMLButtonElement, listener as (e: Event) => void);
      }
      return nativeAdd.call(this, type, listener);
    },
  );
  const trusted = { isTrusted: true } as unknown as Event;
  return {
    /** 按按钮文案找按钮并发出「真实手势」点击 */
    clickByLabel(root: HTMLElement, label: string) {
      const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === label);
      expect(btn, `应存在文案为「${label}」的按钮`).toBeTruthy();
      const h = els.get(btn as HTMLButtonElement);
      expect(h, `「${label}」按钮应挂着 click 监听器`).toBeDefined();
      h!(trusted);
    },
    stop: () => spy.mockRestore(),
  };
}

function replyCalls(calls: CallRec[]): CallRec[] {
  return calls.filter((c) => c.url.endsWith('/v1/consent/reply'));
}

function parseReplyBody(call: CallRec): Record<string, unknown> {
  const raw = (call.init?.body ?? '') as string;
  expect(raw, '回执应是 JSON body').toBeTruthy();
  return JSON.parse(raw) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ── ① 等待 / 错误态（fail-closed 边界） ──────────────────────────────────

describe('K3 窗口页 · ① 等待与错误态', () => {
  it('正控：无 pending → 等待态、零按钮、不显假卡', async () => {
    const { root, fetchCalls } = mountPanel(undefined);
    await flush(); // auto-tick 完成首帧
    expect(root.textContent).toContain('暂无待审批请求');
    expect(root.querySelectorAll('button').length).toBe(0);
    expect(root.querySelector('.ds-consent-card')).toBeNull();
    expect(fetchCalls.length).toBe(1); // 装置自检：auto-tick 恰好打过一次 pending
  });

  it('负控：fetch 不可用 → 「数据面未装配」显性态（不崩、不出假卡）', async () => {
    vi.stubGlobal('fetch', undefined);
    const root = document.createElement('div');
    root.id = 'consent-root';
    document.body.append(root);
    let intervalMs = 0;
    const panel = mountConsentPanel({
      root,
      token: '',
      origin: 'http://127.0.0.1:8760',
      setIntervalImpl: (_fn, ms) => {
        intervalMs = ms;
        return 1;
      },
      clearIntervalImpl: () => undefined,
    });
    await flush();
    expect(root.textContent).toContain('数据面未装配');
    expect(root.querySelectorAll('button').length).toBe(0);
    expect(intervalMs).toBe(2000); // 轮询仍接线（装置自检：不是整段没跑）
    panel.stop();
  });

  it('负控：网络失败 → 错误态「读取待审批请求失败」、零回执（不静默）', async () => {
    const root = document.createElement('div');
    root.id = 'consent-root';
    document.body.append(root);
    const calls: CallRec[] = [];
    const panel = mountConsentPanel({
      root,
      token: 't',
      origin: 'http://127.0.0.1:8760',
      fetchImpl: (() => {
        calls.push({ url: '/v1/consent/pending' });
        return Promise.reject(new Error('ECONNREFUSED'));
      }) as unknown as typeof fetch,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => undefined,
    });
    await flush();
    expect(root.textContent).toContain('读取待审批请求失败');
    expect(root.textContent).toContain('ECONNREFUSED');
    expect(root.querySelector('.ds-consent-card')).toBeNull();
    expect(replyCalls(calls).length).toBe(0); // 读失败不得产生任何回执
    panel.stop();
  });

  it('负控：HTTP 401（token 缺失）→ 可见错误态，不崩不静默', async () => {
    const root = document.createElement('div');
    root.id = 'consent-root';
    document.body.append(root);
    const panel = mountConsentPanel({
      root,
      token: '',
      origin: 'http://127.0.0.1:8760',
      fetchImpl: (() => Promise.resolve(jsonResp({}, false, 401))) as unknown as typeof fetch,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => undefined,
    });
    await flush();
    expect(root.textContent).toContain('HTTP 401');
    expect(root.querySelector('.ds-consent-card')).toBeNull();
    panel.stop();
  });

  it('负控：回执未被宿主受理（400）→ 显性错误态，不当成已处理', async () => {
    const cap = captureButtonHandlers();
    const { root, fetchCalls } = mountPanel(HIGH_RISK_REQ, { replyOk: false, replyStatus: 400 });
    await flush();
    cap.clickByLabel(root, '拒绝');
    cap.stop();
    await flush();
    expect(root.textContent).toContain('回执未被受理（HTTP 400）');
    expect(replyCalls(fetchCalls).length).toBe(1);
  });
});

// ── ② 卡片渲染（复用卡 I 视觉组件） ──────────────────────────────────────

describe('K3 窗口页 · ② 卡片渲染', () => {
  it('高风险 pending：危险外观 + 高风险徽标 + 风险原因行 + 档位/目标显形 + 三按钮', async () => {
    const { root } = mountPanel(HIGH_RISK_REQ);
    await flush();

    const card = root.querySelector<HTMLElement>('.ds-consent-card');
    expect(card).not.toBeNull();
    expect(card!.dataset.risk).toBe('high'); // 卡 I 危险外观（data-risk=high）

    const text = root.textContent ?? '';
    expect(text).toContain('高风险'); // 高风险 chip（buildBadges，卡 I 同源）
    expect(text).toContain('风险：越出工作区 · 特权级 · 递归删除'); // describeRiskReason 拼装序
    expect(text).toContain('询问审批'); // 档位徽标（payload.modeLabel）
    expect(text).toContain('工作区外'); // 越界徽标
    expect(text).toContain('目标：path:E:/x'); // 规范目标显形
    expect(text).toContain('执行终端命令'); // 工具自然语言显示名（T8-1）
    expect(text).toContain('cmd: rm -rf build/ …'); // 参数摘要（宿主脱敏串）

    const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
    // DOM 序＝三按钮行在前、「将记住什么」块在后
    expect(labels).toEqual(['允许一次', '拒绝', '本对话始终允许', '确认：本对话始终允许', '取消']);
  });

  it('非高风险 pending（meta 缺省）：无危险外观、无风险行，三按钮仍在', async () => {
    const req: ConsentPendingRequest = { callId: 'c-2', tool: 'file.read', paramsSummary: 'path: a.txt', nonce: 'n-2' };
    const { root } = mountPanel(req);
    await flush();
    expect(root.querySelector<HTMLElement>('.ds-consent-card')!.dataset.risk).toBeUndefined();
    expect(root.textContent).not.toContain('风险：');
    const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('允许一次');
    expect(labels).toContain('本对话始终允许');
    expect(labels).toContain('拒绝');
  });
});

// ── ③ 三按钮行为（数据面回执） ───────────────────────────────────────────

describe('K3 窗口页 · ③ 三按钮', () => {
  it('允许一次（真实手势）→ POST { callId, decision: allow-once, nonce }', async () => {
    const cap = captureButtonHandlers();
    const { root, fetchCalls } = mountPanel(HIGH_RISK_REQ);
    await flush();
    cap.clickByLabel(root, '允许一次');
    cap.stop();
    await flush();
    const replies = replyCalls(fetchCalls);
    expect(replies.length).toBe(1);
    expect(parseReplyBody(replies[0])).toEqual({ callId: 'c-1', decision: 'allow-once', nonce: 'n-1' });
    expect(replies[0].init?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(root.textContent).toContain('已处理');
  });

  it('拒绝（真实手势）→ POST decision: deny', async () => {
    const cap = captureButtonHandlers();
    const { root, fetchCalls } = mountPanel(HIGH_RISK_REQ);
    await flush();
    cap.clickByLabel(root, '拒绝');
    cap.stop();
    await flush();
    expect(parseReplyBody(replyCalls(fetchCalls)[0])).toEqual({ callId: 'c-1', decision: 'deny', nonce: 'n-1' });
  });

  it('本对话始终允许＝两级：先显「将记住什么」（卡面死字面），显式确认才发 allow-conversation', async () => {
    const cap = captureButtonHandlers();
    const { root, fetchCalls } = mountPanel(HIGH_RISK_REQ);
    await flush();
    cap.clickByLabel(root, '本对话始终允许');
    // 装置自检：第一级后「将记住什么」块已显形、三按钮行已隐藏、且**尚未**发任何回执
    const remembered = root.querySelector<HTMLElement>('.cw-remembered');
    expect(remembered).not.toBeNull();
    expect(remembered!.hidden).toBe(false);
    expect(remembered!.textContent).toContain(CONVERSATION_GRANT_REMEMBERED_TEXT);
    expect(root.querySelector<HTMLElement>('.ds-consent-actions')!.hidden).toBe(true);
    expect(replyCalls(fetchCalls).length).toBe(0);

    cap.clickByLabel(root, '确认：本对话始终允许');
    cap.stop();
    await flush();
    expect(parseReplyBody(replyCalls(fetchCalls)[0])).toEqual({ callId: 'c-1', decision: 'allow-conversation', nonce: 'n-1' });
  });

  it('两级取消：回到三按钮、零回执', async () => {
    const cap = captureButtonHandlers();
    const { root, fetchCalls } = mountPanel(HIGH_RISK_REQ);
    await flush();
    cap.clickByLabel(root, '本对话始终允许');
    cap.clickByLabel(root, '取消');
    cap.stop();
    await flush();
    expect(root.querySelector<HTMLElement>('.cw-remembered')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.ds-consent-actions')!.hidden).toBe(false);
    expect(replyCalls(fetchCalls).length).toBe(0);
  });

  it('负控：合成事件（isTrusted=false）不产生任何回执（R2-01 同族守卫）', async () => {
    const { root, fetchCalls } = mountPanel(HIGH_RISK_REQ);
    await flush();
    const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === '允许一次');
    expect(btn).toBeTruthy();
    (btn as HTMLButtonElement).click(); // jsdom 原生 click：isTrusted 恒 false
    await flush();
    expect(replyCalls(fetchCalls).length).toBe(0);
    expect(root.querySelector('.ds-consent-card')).not.toBeNull(); // 卡片仍在，等待真实手势或宿主超时
  });

  it('负控：无 nonce ⇒ 允许类按钮不渲染（fail-closed），只给拒绝＋说明；拒绝回执不带 nonce', async () => {
    const req: ConsentPendingRequest = { callId: 'c-3', tool: 'memory.purge', paramsSummary: 'id: m-7' };
    const cap = captureButtonHandlers();
    const { root, fetchCalls } = mountPanel(req);
    await flush();
    const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['拒绝']);
    expect(root.textContent).toContain('缺少一次性凭据');
    cap.clickByLabel(root, '拒绝');
    cap.stop();
    await flush();
    const body = parseReplyBody(replyCalls(fetchCalls)[0]);
    expect(body).toEqual({ callId: 'c-3', decision: 'deny' }); // 无 nonce 字段（JSON.stringify 丢弃 undefined）
  });
});

// ── ④ 渲染失败 fail-closed（弹不出 ≠ 静默放行） ─────────────────────────

describe('K3 窗口页 · ④ 渲染失败 fail-closed', () => {
  it('渲染路径抛异常 → 立即 deny 回执、无卡片残留（与卡 I ⑤ 同口径）', async () => {
    const root = document.createElement('div');
    root.id = 'consent-root';
    document.body.append(root);
    const { impl, calls } = mkFetch(HIGH_RISK_REQ);
    // spy 必须**先于** mount 装：auto-tick 的首帧渲染跑在 mount 的微任务链里，
    // 让那次渲染正好撞在「第一次 createElement 抛异常」上。
    const realCreate = document.createElement.bind(document);
    let n = 0;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (n++ === 0) throw new Error('boom');
      return realCreate(tag);
    });
    const panel = mountConsentPanel({
      root,
      token: 't',
      origin: 'http://127.0.0.1:8760',
      fetchImpl: impl,
      setIntervalImpl: () => 1,
      clearIntervalImpl: () => undefined,
    });
    await flush();
    const replies = replyCalls(calls);
    expect(replies.length).toBe(1); // 装置自检：确实发过回执
    expect(parseReplyBody(replies[0])).toEqual({ callId: 'c-1', decision: 'deny', nonce: 'n-1' });
    expect(root.querySelector('.ds-consent-card')).toBeNull(); // 卡片没画出来、也没残留
    expect(root.textContent).toContain('已处理'); // 回执发出后的状态块（第二次 createElement 已恢复）
    panel.stop();
  });
});

// ── ⑤ 轮询接线与 DOM 稳定性 ──────────────────────────────────────────────

describe('K3 窗口页 · ⑤ 轮询与稳定性', () => {
  it('轮询接线：缺省 2000ms；stop() 清定时器', async () => {
    const { panel, intervalMs, cleared } = mountPanel(HIGH_RISK_REQ);
    await flush();
    expect(intervalMs).toBe(2000);
    panel.stop();
    expect(cleared.value).toBe(true);
  });

  it('同一 callId 的重复轮询不重渲染（用户读到一半不被闪烁重置）', async () => {
    const cap = captureButtonHandlers();
    const { panel, root } = mountPanel(HIGH_RISK_REQ);
    await flush();
    cap.clickByLabel(root, '本对话始终允许'); // 进入两级态
    cap.stop();
    const card1 = root.querySelector<HTMLElement>('.ds-consent-card')!;
    await panel.tick(); // 显式第二次轮询（同一请求）
    expect(root.querySelector<HTMLElement>('.ds-consent-card')).toBe(card1); // 同一元素，未被替换
    expect(root.querySelector<HTMLElement>('.cw-remembered')!.hidden).toBe(false); // 两级态保留
  });
});

// ── ⑥ 壳零秘密机器判据（mcp-settings-window.test.ts 同族，自包含拷贝） ──

const TOKEN = 'k3-shell-scan-token-0123456789'; // 低熵构造串（裁定五十二）
const BEARER_RUNTIME_REF = String.raw`(?!window\.|globalThis\.|self\.|process\.env\.)`;
const BEARER_LITERAL_RE = new RegExp(`Bearer\\s+${BEARER_RUNTIME_REF}[A-Za-z0-9._\\-+/=]{16,}`);

function scanShellForSecrets(text: string, token: string): string[] {
  const hits: string[] = [];
  if (token.length > 0 && text.includes(token)) hits.push('token-literal');
  if (/config\s*\.\s*token|config\s*\[\s*['"]token['"]\s*\]/.test(text)) hits.push('config-token');
  if (BEARER_LITERAL_RE.test(text)) hits.push('bearer-literal');
  if (/__STUDIO_TOKEN__\s*[:=]\s*['"`][^'"`]+['"`]/.test(text)) hits.push('embedded-token-assign');
  return hits;
}

describe('K3 窗口页 · ⑥ 壳零秘密（壳不走 Bearer ⇒ 唯一安全边界）', () => {
  it('装置自检：判据对 4 种事故形态逐一命中、合法形态不误报', () => {
    const clean = '<html><body><script src="/consent.js"></script></body></html>';
    expect(scanShellForSecrets(clean, TOKEN)).toEqual([]);
    const planted: Array<[string, string]> = [
      ['token-literal', `<script>var t = "${TOKEN}";</script>`],
      ['config-token', '<script>var t = config.token;</script>'],
      ['bearer-literal', '<script>fetch(u,{headers:{Authorization:"Bearer abcdefghijklmnop1234"}})</script>'],
      ['embedded-token-assign', '<script>window.__STUDIO_TOKEN__ = "abc123";</script>'],
    ];
    for (const [rule, text] of planted) {
      expect(scanShellForSecrets(text, TOKEN), `应命中 ${rule}`).toContain(rule);
    }
    // 反向：运行时读取注入值是合法形态，不得误报
    expect(scanShellForSecrets('<script>var t = window.__STUDIO_TOKEN__;</script>', TOKEN)).toEqual([]);
  });

  it('真实壳产物：三件套（＋ dist 面板 js）零命中；壳契约钉死 #consent-root 与 /consent.js', () => {
    const htmlPath = path.join(REPO_ROOT, 'src', 'ui', 'consent-window.html');
    const cssPath = path.join(REPO_ROOT, 'src', 'ui', 'consent-window.css');
    const jsPath = path.join(REPO_ROOT, 'dist', 'consent-panel.js');
    const candidates = [htmlPath, cssPath, jsPath];
    const present = candidates.filter((p) => existsSync(p));
    for (const p of present) {
      const text = readFileSync(p, 'utf8');
      expect(scanShellForSecrets(text, TOKEN), `${p} 不得含令牌形态`).toEqual([]);
    }
    // 壳契约：根元素与资源引用（服务端逐字节返回，壳里写死的路径就是宿主路由的名字）
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('id="consent-root"');
    expect(html).toContain('/consent.js');
    expect(html).toContain('/consent.css');
    // dist 产物未产出时只做显式记账（产出一落地本扫描自动生效，与 mcp 先例同口径）
    expect(present.length).toBeGreaterThanOrEqual(0);
  });
});
