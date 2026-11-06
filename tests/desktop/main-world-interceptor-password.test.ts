// @vitest-environment jsdom
/**
 * P1 凭据守卫（2026-11-06 UI 卡）：`input[type="password"]` 不进入两条打字预热路径。
 *
 * 缺陷面（改动前）：文档级 `input` 捕获只按标签名（TEXTAREA/INPUT/contenteditable）过滤、
 * 不看 `type` → 密码框打字时：
 *   - skills 预热白触发 `skill.list` 刷新（行为泄漏）；
 *   - memory select 预热经 `draftOf` **读 `.value`** → 6 字阈值一过即把密码明文
 *     作为草稿送宿主 `memory.select`（feature flag 默认关着才没外泄；flag 一开即凭据泄漏）。
 *
 * 断言口径（PM 预审 ②）：负控断言的是**行为泄漏**（`skill.list` 零发送 + `memory.select`
 * 零发送），不是「不读值」——`draftOf` 的读值路径已被两个 `onInput` 的门覆盖。
 *
 * 每个用例 `vi.resetModules()` + 动态 import：模块级预热状态（`skillsPrewarmLastAt` /
 * `memorySelectState`）按用例隔离，冷却窗口不跨用例污染。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ExecuteResult } from '../../src/capabilities/types';

/** 测试内部统一的 ToolCallRequest 形状（src/inject 模块内部类型不导出）。 */
interface TestToolCallRequest {
  invocationName: string;
  params?: Record<string, unknown>;
}

function defaultSenderResult(invocationName: string): ExecuteResult {
  if (invocationName === 'mcp.list') return { ok: true, data: { tools: [] } };
  if (invocationName === 'skill.list') return { ok: true, data: { skills: [] } };
  if (invocationName === 'memory.select') return { ok: true, data: { memories: [] } };
  return { ok: true, data: { stdout: 'ok', exitCode: 0 } };
}

function makeTestSender() {
  return vi.fn(async (req: TestToolCallRequest): Promise<ExecuteResult> => defaultSenderResult(req.invocationName));
}

function countCalls(sender: ReturnType<typeof makeTestSender>, name: string): number {
  return sender.mock.calls.filter((c: unknown[]) => (c[0] as TestToolCallRequest | undefined)?.invocationName === name).length;
}

function makeFakeXhrClass() {
  return class FakeXHR {
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: ((...a: unknown[]) => void) | null = null;
    url = '';
    method = 'GET';
    open(m: string, u: string | URL) { this.method = m; this.url = String(u); this.readyState = 1; }
    setRequestHeader() { /* noop */ }
    send() { this.readyState = 4; }
    abort() { this.readyState = 4; }
  };
}

function makeChatUI() {
  return {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    beginTurnSession: vi.fn(),
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  handle: import('../../src/inject/main-world-interceptor').MainWorldInterceptorHandle;
  sender: ReturnType<typeof makeTestSender>;
}

async function installWith(mod: typeof import('../../src/inject/main-world-interceptor'), enabled: boolean): Promise<Harness> {
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  (globalThis as Record<string, unknown>).XMLHttpRequest = makeFakeXhrClass();
  const sender = makeTestSender();
  const chatUI = makeChatUI();
  const handle = mod.installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {} });
  mod.configureMemorySelect({
    enabled: () => enabled,
    invoke: (taskText: string) =>
      sender({ invocationName: 'memory.select', params: { taskText } })
        .then((r) => r as { ok: boolean; data?: { memories?: unknown } }),
  });
  // 让启动期的 mcp.list / skill.list 拉取 settle（mock 首试即成功，只排微任务）。
  for (let i = 0; i < 30; i++) await Promise.resolve();
  return { handle, sender };
}

function typeInto(el: HTMLElement, text: string): void {
  (el as HTMLInputElement).value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('凭据守卫：password 输入框不进入打字预热（P1 2026-11-06）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('flag 开态：密码框输入 ≥6 字（预热阈值）→ skill.list 零发送 + memory.select 零发送', async () => {
    const mod = await import('../../src/inject/main-world-interceptor');
    const { handle, sender } = await installWith(mod, true);
    // 推「不新鲜」：负控断的是**凭据守卫**本身（gate 拦），不是新鲜度跳过——
    // 若守卫回归，这里 skill.list/memory.select 会 +1 被抓；若守卫在，恒 0。
    mod.__setSkillsFreshnessClockForTests(() => 1e15);
    try {
      const baseSkills = countCalls(sender, 'skill.list');
      const baseSelect = countCalls(sender, 'memory.select');

      const input = document.createElement('input');
      input.type = 'password';
      document.body.appendChild(input);
      typeInto(input, 'secret-1'); // 8 字 > 6 字阈值：改动前这里会触发两条预热
      await sleep(750); // > 600ms 预热静默窗口

      expect(countCalls(sender, 'skill.list') - baseSkills).toBe(0);
      expect(countCalls(sender, 'memory.select') - baseSelect).toBe(0);
    } finally {
      mod.__resetSkillsFreshnessForTests();
      handle.stop();
    }
  });

  it('正控（flag 开态）：普通 textarea 同样输入 → 两条预热照发（修的是密码框，不是误伤正常输入）', async () => {
    const mod = await import('../../src/inject/main-world-interceptor');
    const { handle, sender } = await installWith(mod, true);
    // 把 skills 新鲜度时钟推到「不新鲜」：启动期那次成功的 skill.list 落在 TTL 内会让
    // 预热 isSkillsFresh() 跳过 → 正控的 skill.list 恒 0（修前正控失败根因）。
    mod.__setSkillsFreshnessClockForTests(() => 1e15);
    try {
      const baseSkills = countCalls(sender, 'skill.list');
      const baseSelect = countCalls(sender, 'memory.select');

      const area = document.createElement('textarea');
      document.body.appendChild(area);
      typeInto(area, 'hello world');
      await sleep(750);

      expect(countCalls(sender, 'skill.list') - baseSkills).toBeGreaterThanOrEqual(1);
      expect(countCalls(sender, 'memory.select') - baseSelect).toBeGreaterThanOrEqual(1);
    } finally {
      mod.__resetSkillsFreshnessForTests();
      handle.stop();
    }
  });

  it('flag 关态 + 密码框：memory.select 保持零（关态门控未被修破坏）且凭据守卫在 skills 路径同样生效', async () => {
    const mod = await import('../../src/inject/main-world-interceptor');
    const { handle, sender } = await installWith(mod, false);
    // 推「不新鲜」：同上，让 skills 路径真正可拉，负控断的才是凭据守卫而非新鲜度跳过。
    mod.__setSkillsFreshnessClockForTests(() => 1e15);
    try {
      const baseSkills = countCalls(sender, 'skill.list');
      const baseSelect = countCalls(sender, 'memory.select');

      const input = document.createElement('input');
      input.type = 'password';
      document.body.appendChild(input);
      typeInto(input, 'secret-1');
      await sleep(750);

      // 关态：memory.select 本来就不会发（与改动前一致，防回归）
      expect(countCalls(sender, 'memory.select') - baseSelect).toBe(0);
      // skills 路径无 flag 门控：凭据守卫在关态下同样拦（改动前这里会 +1）
      expect(countCalls(sender, 'skill.list') - baseSkills).toBe(0);
    } finally {
      mod.__resetSkillsFreshnessForTests();
      handle.stop();
    }
  });

  it('flag 关态 + 普通 textarea：skills 预热行为与改动前一致（关态不误伤），memory.select 仍为关', async () => {
    const mod = await import('../../src/inject/main-world-interceptor');
    const { handle, sender } = await installWith(mod, false);
    // 同上：推「不新鲜」，skills 预热才真正会拉（关态也不误伤普通 textarea 的 skills 路径）。
    mod.__setSkillsFreshnessClockForTests(() => 1e15);
    try {
      const baseSkills = countCalls(sender, 'skill.list');
      const baseSelect = countCalls(sender, 'memory.select');

      const area = document.createElement('textarea');
      document.body.appendChild(area);
      typeInto(area, 'hello world');
      await sleep(750);

      expect(countCalls(sender, 'skill.list') - baseSkills).toBeGreaterThanOrEqual(1);
      expect(countCalls(sender, 'memory.select') - baseSelect).toBe(0);
    } finally {
      mod.__resetSkillsFreshnessForTests();
      handle.stop();
    }
  });
});
