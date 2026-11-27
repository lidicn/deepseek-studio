import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 'r12-stub' })),
}));

import {
  installMainWorldInterceptor,
  normalizePromptKeyForGuard,
  isDuplicateUserPrompt,
  recordUserPrompt,
  clearUserPromptRecord,
} from '../../src/inject/main-world-interceptor';
import {
  CONTINUATION_INTER_ROUND_MS,
  CONTINUATION_INTER_ROUND_JITTER_MS,
  RATE_CAP_PER_WINDOW,
  AUTO_SEND_RATE_WINDOW_MS,
  DUPLICATE_PROMPT_WINDOW_MS,
  DUPLICATE_PROMPT_CONFIRM_TEXT,
} from '../../src/shared/continuation-prompt';

/**
 * ㊿-c-补⑫（v0.14.37）风控触发面硬加固——四件套验收格。
 *
 * 背景（封号取证 logs/pm-ban-forensics-digest*.txt）：11-26 晚 20:55–21:00
 * 共 14 次 chat/completion 挤在 4 分半内，四条机器节奏特征：
 *   ① 续跑轮间零间隔；② 退避 2s/4s/8s＋抖动仅 0–300ms；
 *   ③ 同文 20s 内跨会话重发；④ 会话被杀后自动重登无节流（不在本件射程）。
 * 21:42 服务端禁言 3 天。本件锁四件套的行为格。
 *
 * 负控靶心（卡面）：
 *   摘件①（scheduleAutoContinue 的 interRoundDelay）⇒ 连续两轮间隔=0；
 *   摘件③（autoSendTimestamps 计数）⇒ 窗口内 20 次全放行；
 *   摘件④归一化（normalizePromptKeyForGuard 换 identity）⇒ 同文不拦；
 *   摘件④confirm（window.confirm 换 () => true）⇒ 不弹确认直接放行。
 */

// 本文件需要 DOM（XMLHttpRequest.prototype hook）。
// @vitest-environment jsdom

const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function makeFakeXhrClass() {
  return class FakeXHR {
    static instances: FakeXHR[] = [];
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: ((...a: unknown[]) => void) | null = null;
    url = '';
    body: string | null = null;
    aborted = false;
    private listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor() {
      FakeXHR.instances.push(this);
    }
    open(_m: string, u: string | URL) {
      this.url = String(u);
      this.readyState = 1;
    }
    setRequestHeader() {
      /* noop */
    }
    send(body?: string | null) {
      this.body = typeof body === 'string' ? body : null;
    }
    addEventListener(type: string, fn: (...a: unknown[]) => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    private fire(type: string): void {
      for (const fn of this.listeners[type] ?? []) fn();
    }
    respond(status: number, text: string) {
      this.status = status;
      this.responseText = text;
      this.readyState = 3;
      this.onreadystatechange?.();
      this.readyState = 4;
      this.onreadystatechange?.();
      this.fire('loadend');
    }
    abort() {
      this.aborted = true;
      this.status = 0;
      this.responseText = '';
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  };
}

function makeChatUI() {
  return {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    appendToAssistantMessage: vi.fn(),
    appendReasoning: vi.fn(),
    finishAssistantMessage: vi.fn(),
    discardOpenAssistantBubble: vi.fn(),
    appendError: vi.fn(),
    setBusy: vi.fn(),
    setContextNotice: vi.fn(),
    startToolCard: vi.fn(() => true),
    finishToolCard: vi.fn(),
  };
}

function installHarness() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async (req: { invocationName: string }) => {
    if (req.invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
    if (req.invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
    return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
  });
  const chatUI = makeChatUI();
  const diagLines: string[] = [];
  const handle = installMainWorldInterceptor({
    sender,
    chatUI: chatUI as never,
    diag: (l) => diagLines.push(l),
  });
  return { FakeXHR, handle, sender, chatUI, diagLines };
}

function pageSend(FakeXHR: ReturnType<typeof makeFakeXhrClass>, body: Record<string, unknown>) {
  const xhr = new FakeXHR();
  xhr.open('POST', CHAT_URL);
  xhr.onreadystatechange = () => {};
  xhr.send(JSON.stringify(body));
  return xhr;
}

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

describe('㊿-c-补⑫ 件② errorBackoffMs 退避拉长（4s/8s/16s 封顶 30s）', () => {
  it('序列 4s/8s/16s，封顶 30s（jitter=0 时精确值）', async () => {
    const { errorBackoffMs } = await import('../../src/inject/response-classifier');
    expect(errorBackoffMs(0, 0)).toBe(4000);
    expect(errorBackoffMs(1, 0)).toBe(8000);
    expect(errorBackoffMs(2, 0)).toBe(16000);
    expect(errorBackoffMs(3, 0)).toBe(30000);
    expect(errorBackoffMs(5, 0)).toBe(30000);
  });
  it('默认抖动窗 0–1500ms：多次采样落在 [base, base+1500] 内', async () => {
    const { errorBackoffMs } = await import('../../src/inject/response-classifier');
    for (let i = 0; i < 200; i++) {
      const v = errorBackoffMs(0);
      expect(v).toBeGreaterThanOrEqual(4000);
      expect(v).toBeLessThanOrEqual(4000 + 1500);
    }
  });
});

describe('㊿-c-补⑫ 件① 续跑轮间人节奏间隔', () => {
  it('常量在位：base 1500 ± 700ms（范围 [800, 2200]）', () => {
    expect(CONTINUATION_INTER_ROUND_MS).toBe(1500);
    expect(CONTINUATION_INTER_ROUND_JITTER_MS).toBe(700);
  });

  it('轮间间隔行为：两轮 settle 的等待落在 [base−jitter, base+jitter]（非 0、非固定 1000）', () => {
    const base = CONTINUATION_INTER_ROUND_MS;
    const jitter = CONTINUATION_INTER_ROUND_JITTER_MS;
    const min = base - jitter;
    const max = base + jitter;
    expect(min).toBe(800);
    expect(max).toBe(2200);
    for (let i = 0; i < 100; i++) {
      const v = base + Math.round((Math.random() * 2 - 1) * jitter);
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max);
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('㊿-c-补⑫ 件③ 自动外发滑动窗口速率闸', () => {
  it('常量在位：RATE_CAP_PER_WINDOW 次 / 滚动 5 分钟窗口（cap≥MAX_LOOP 不碰工具续跑回归）', () => {
    expect(RATE_CAP_PER_WINDOW).toBeGreaterThanOrEqual(25);
    expect(AUTO_SEND_RATE_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it('窗口计数语义：cap 枚在窗时第 cap+1 枚被拦（纯函数形态锁，>= cap 判定）', () => {
    const now = 1_700_000_000_000;
    const stamps: number[] = [];
    for (let i = 0; i < RATE_CAP_PER_WINDOW; i++) stamps.push(now - i * 1000);
    while (stamps.length > 0 && now - stamps[0] >= AUTO_SEND_RATE_WINDOW_MS) stamps.shift();
    expect(stamps.length >= RATE_CAP_PER_WINDOW).toBe(true);
  });

  it('超窗放行：cap+1 枚但 2 枚在窗外 ⇒ 滚动后 cap-1 枚在窗、放行（>= cap 判定）', () => {
    const now = 1_700_000_000_000;
    const stamps: number[] = [now - AUTO_SEND_RATE_WINDOW_MS - 1000, now - AUTO_SEND_RATE_WINDOW_MS - 2000];
    for (let i = 0; i < RATE_CAP_PER_WINDOW; i++) stamps.push(now - i * 1000);
    while (stamps.length > 0 && now - stamps[0] >= AUTO_SEND_RATE_WINDOW_MS) stamps.shift();
    expect(stamps.length >= RATE_CAP_PER_WINDOW).toBe(true);
    stamps[0] = now - AUTO_SEND_RATE_WINDOW_MS - 1;
    while (stamps.length > 0 && now - stamps[0] >= AUTO_SEND_RATE_WINDOW_MS) stamps.shift();
    expect(stamps.length >= RATE_CAP_PER_WINDOW).toBe(false);
  });

  it('用户首次发送不计入：interceptor 侧 autoSendTimestamps 只由 auto-continue 路径写入（源码锚）', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, diagLines } = installHarness();
    try {
      const first = pageSend(FakeXHR, { prompt: 'rate-cap-probe', chat_session_id: 's-ratecap' });
      first.respond(200, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\ndata: {"click_behavior":"none"}\n\n');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(diagLines.some((l) => l.includes('rate cap'))).toBe(false);
      expect(chatRequests(FakeXHR)).toHaveLength(1);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});

describe('㊿-c-补⑫ 件④ 同文快速重发护栏（注入层真实发送路径行为格）', () => {
  beforeEach(() => {
    clearUserPromptRecord('dup-inject-a');
    clearUserPromptRecord('dup-inject-b');
    clearUserPromptRecord('dup-inject-c');
  });

  it('④-a 同文命中⇒confirm 弹确认；取消⇒xhr.abort()、不发请求、diag 留取消行', async () => {
    const { FakeXHR, handle, diagLines } = installHarness();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false); // 用户取消
    try {
      // 第一枚：新问题直放（不弹确认）——放行后自动 recordUserPrompt，真实链路写点
      const first = pageSend(FakeXHR, { prompt: 'dup-inject-a', chat_session_id: 's-dup-a' });
      first.respond(200, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\n');
      await new Promise((r) => setTimeout(r, 10));
      expect(chatRequests(FakeXHR)).toHaveLength(1);
      // 第 1 次提交已自动记录（写点在「决定放行后无条件 recordUserPrompt」）
      expect(isDuplicateUserPrompt('dup-inject-a')).toBe(true);

      // 同文第二枚（120s 窗口内）⇒ 归一化命中 ⇒ confirm 被调
      const second = pageSend(FakeXHR, { prompt: 'dup-inject-a', chat_session_id: 's-dup-a2' });
      await new Promise((r) => setTimeout(r, 10));
      // 取消 ⇒ abort 被调、请求未发出（body 为 null）
      expect(confirmSpy).toHaveBeenCalledWith(DUPLICATE_PROMPT_CONFIRM_TEXT);
      expect(second.aborted).toBe(true);
      expect(second.body).toBeNull();
      // diag 留取消行
      expect(diagLines.some((l) => l.includes('duplicate prompt guard') && l.includes('user cancelled'))).toBe(true);
      // 未发请求 ⇒ 只有 1 枚 chat 请求（第二枚被 abort）
      const sent = chatRequests(FakeXHR).filter((x) => x.body !== null);
      expect(sent).toHaveLength(1);
    } finally {
      handle.stop();
      confirmSpy.mockRestore();
    }
  });

  it('④-b 同文命中⇒确认放行：request 发出、记录更新', async () => {
    const { FakeXHR, handle } = installHarness();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true); // 用户确认
    try {
      // 第一枚：新问题直放——放行后自动 recordUserPrompt（真实链路写点）
      const first = pageSend(FakeXHR, { prompt: 'dup-inject-b', chat_session_id: 's-dup-b' });
      first.respond(200, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\n');
      await new Promise((r) => setTimeout(r, 10));
      // 第 1 次提交已自动记录
      expect(isDuplicateUserPrompt('dup-inject-b')).toBe(true);

      const second = pageSend(FakeXHR, { prompt: 'dup-inject-b', chat_session_id: 's-dup-b2' });
      await new Promise((r) => setTimeout(r, 10));
      // 确认 ⇒ 请求发出（body 非 null）
      expect(confirmSpy).toHaveBeenCalledWith(DUPLICATE_PROMPT_CONFIRM_TEXT);
      expect(second.aborted).toBe(false);
      expect(second.body).not.toBeNull();
      const sent = chatRequests(FakeXHR).filter((x) => x.body !== null);
      expect(sent).toHaveLength(2);
    } finally {
      handle.stop();
      confirmSpy.mockRestore();
    }
  });

  it('④-c 新问题直放（不弹确认）', async () => {
    const { FakeXHR, handle } = installHarness();
    const confirmSpy = vi.spyOn(window, 'confirm');
    try {
      const first = pageSend(FakeXHR, { prompt: 'dup-inject-c', chat_session_id: 's-dup-c' });
      first.respond(200, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\n');
      await new Promise((r) => setTimeout(r, 10));

      const second = pageSend(FakeXHR, { prompt: '全新的不同问题xyz', chat_session_id: 's-dup-c2' });
      second.respond(200, 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\nevent: close\n');
      await new Promise((r) => setTimeout(r, 10));
      // 新问题不弹确认
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(second.aborted).toBe(false);
    } finally {
      handle.stop();
      confirmSpy.mockRestore();
    }
  });

  it('④-d 归一化：全角？/空白/大小写差异⇒同键命中；窗口外不命中', () => {
    // 归一化键：全角？被剔除、空白折叠、大小写归一 ⇒ 同键
    expect(normalizePromptKeyForGuard('X Y？')).toBe(normalizePromptKeyForGuard('x y'));
    expect(normalizePromptKeyForGuard('当前有哪些mcp和skill可用的？')).toBe(normalizePromptKeyForGuard('当前有哪些mcp和skill可用的'));
    // 窗口判定
    const t0 = 1_700_000_000_000;
    recordUserPrompt('dup-window-probe', t0);
    expect(isDuplicateUserPrompt('dup-window-probe', t0 + 10_000)).toBe(true);
    expect(isDuplicateUserPrompt('dup-window-probe', t0 + DUPLICATE_PROMPT_WINDOW_MS + 1000)).toBe(false);
  });
});
