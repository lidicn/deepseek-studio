// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * #55 / T-2a 验收断言（现状锁已随批翻成此版；red-first 留证见卡面）：
 * 断言 `main-world-interceptor.ts` 的 `L3062`（MAX_LOOP 触顶）与 `L3104`（协议修复失败）
 * 收尾**带原因**——`chatUI.appendError` 触达对应 `code`，且措辞守红线（"未执行"／"已停止"禁用），
 * 且 N 同时进了 `d()` 与 `turn.end` trace（口径不分叉）。
 *
 * 驱动方式（设计稿 §6 ＋ w0 harness，不 inject 钩子，全程 fake timers）：
 * - L3062：25 轮真工具续跑顶到 `loopDepth>=MAX_LOOP`；自然驱动下触顶时刻 `pending` 有/无积压（N 为下界实数），
 *   断言对 N 取「结构」而非固定值（N>0 句带实数、N=0 句不带数，二者都合法）。
 * - L3104：首轮 1 次工具执行（`collectedExecutions` 非空）＋续跑空回复触发协议修复，修复轮仍空回复。
 *
 * 本锁「抓不住」的变异（判据 5 尾巴）：抓不住「N 快照取错了位置（取在复位后仍=0）」——
 * 因自然驱动 N 可为 0，消息结构断言对 N 值不敏感；该变异需靠「构造积压」的驱动抓，本卡未建（#55 只锁收尾带原因）。
 */

vi.mock('../../src/inject/pow', () => ({
  createPowHeaders: vi.fn(async () => ({ 'X-DS-PoW-Response': 't2a-stub' })),
}));

import {
  installMainWorldInterceptor,
  interceptorTraceSnapshot,
  NEUTRAL_TOOL_ONLY_REPLY_NOTE,
} from '../../src/inject/main-world-interceptor';
import { createStudioChatUI } from '../../src/ui/studio-chat-ui';

type Handler = ((...args: unknown[]) => void) | null;
const CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';

function sseDone(): string {
  return 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
    + 'event: close\ndata: {"click_behavior":"none"}\n\n';
}
function sseText(text: string): string {
  return `data: ${JSON.stringify({ v: text })}\n\n`;
}
function sseTool(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec>{\\"command\\":\\"echo hi\\"}</shell_exec>"}]}\n\n';
}

function makeFakeXhrClass() {
  return class FakeXHR {
    static instances: FakeXHR[] = [];
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: Handler = null;
    method = '';
    url = '';
    headers: Record<string, string> = {};
    body: string | null = null;
    constructor() { FakeXHR.instances.push(this); }
    open(m: string, u: string | URL) { this.method = m; this.url = String(u); this.readyState = 1; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    send(body?: string | null) { this.body = typeof body === 'string' ? body : null; }
    respond(status: number, text: string) {
      this.status = status; this.responseText = text;
      this.readyState = 3; this.onreadystatechange?.();
      this.readyState = 4; this.onreadystatechange?.();
    }
    abort() { this.status = 0; this.readyState = 4; this.onreadystatechange?.(); }
  };
}

function installHarness() {
  const FakeXHR = makeFakeXhrClass();
  (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
  vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
  const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'hi', exitCode: 0 } }));
  const onAssistantReply = vi.fn();
  const chatUI = {
    sessionKey: 'test:session',
    activateSession: vi.fn(async () => undefined),
    addUserMessage: vi.fn(),
    startAssistantMessage: vi.fn(),
    // C-1/#61 harness 管线（非断言）：mock 模拟「无在飞气泡」态，条件 start 照走原形态
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
  const handle = installMainWorldInterceptor({ sender, chatUI: chatUI as never, diag: () => {}, onAssistantReply });
  return { FakeXHR, handle, sender, chatUI, onAssistantReply };
}

function chatRequests(FakeXHR: ReturnType<typeof makeFakeXhrClass>) {
  return FakeXHR.instances.filter((x) => x.url.endsWith('/api/v0/chat/completion'));
}

function fireFirstRound(FakeXHR: ReturnType<typeof makeFakeXhrClass>, sessionId: string) {
  const first = new FakeXHR();
  first.open('POST', CHAT_URL);
  first.onreadystatechange = () => {};
  first.send(JSON.stringify({ prompt: 'hi', chat_session_id: sessionId }));
  first.respond(200, sseTool() + sseDone());
  return first;
}

describe('#55 验收断言：L3062/L3104 收尾带原因（现状锁已随批翻成此版）', () => {
  it('L3062 MAX_LOOP 触顶：appendError 触达 max-loop、措辞守红线、N 进了 trace', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      fireFirstRound(FakeXHR, 't2a-maxloop');
      await vi.advanceTimersByTimeAsync(2_000);
      // 喂工具结果直到触顶（max-loop）；触顶后循环停、不再发新请求
      for (let i = 0; i < 30; i++) {
        const reqs = chatRequests(FakeXHR);
        const last = reqs[reqs.length - 1];
        if (!last || last.readyState === 4) break;
        last.respond(200, sseTool() + sseDone());
        await vi.advanceTimersByTimeAsync(1_500);
        if (interceptorTraceSnapshot().some((e) => e.t === 'turn.end' && e.stopReason === 'max-loop')) break;
      }
      // 触顶收尾确实发生
      const maxLoopEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end' && e.stopReason === 'max-loop');
      expect(maxLoopEnds.length).toBeGreaterThan(0);
      expect(maxLoopEnds.at(-1)).toMatchObject({ finished: false });
      // 验收：appendError 触达 'max-loop'
      const call = chatUI.appendError.mock.calls.find((c) => String(c[0]) === 'max-loop');
      expect(call).toBeDefined();
      const msg = String(call![1]);
      // 主句（"已暂停本批续跑"，"已停止"禁用）
      expect(msg).toContain('已暂停本批续跑');
      expect(msg).not.toContain('已停止');
      // 红线："未执行"禁用（pending＝已执行、未送回）
      expect(msg).not.toContain('未执行');
      // N 同批进 trace（口径不分叉）：turn.end 带 undelivered 数值
      const und = (maxLoopEnds.at(-1) as { undelivered?: number }).undelivered;
      expect(typeof und).toBe('number');
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('L3104 协议修复失败：appendError 触达 protocol-repair-failed、定字句', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      fireFirstRound(FakeXHR, 't2a-procrepair');
      await vi.advanceTimersByTimeAsync(2_000);
      // 第 1 次续跑：空回复（无工具、无 task_complete）⇒ 触发协议修复（protocolRepairUsed→true）
      let reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseText('') + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      // 修复轮仍空回复 ⇒ L3104 protocol-repair-failed
      reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseText('') + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      const pfEnds = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end' && e.stopReason === 'protocol-repair-failed');
      expect(pfEnds.length).toBeGreaterThan(0);
      expect(pfEnds.at(-1)).toMatchObject({ finished: false });
      // 验收：appendError 触达定字句。
      // 0.14.19-F3（PM 卡 0.14.19-F1F3，验收口径变更经卡面批准）：旧 #55 定字「模型回复不完整且修复失败，
      // 本轮结果已丢弃，请重试或换个说法。」作废，换成上游真因句——可见提示不得静默（回归锁 (b)：
      // 断言的是 appendError 触达，不是只 return）。
      const call = chatUI.appendError.mock.calls.find((c) => String(c[0]) === 'protocol-repair-failed');
      expect(call).toBeDefined();
      expect(String(call![1])).toBe('上游服务器暂时不可用，本轮已中断，请重试。');
    } finally { handle.stop(); vi.useRealTimers(); }
  });
});

/**
 * T-2b 驱动形态（现树里能命中 L3146 支的自然形态，唯一）：
 * - 带属性工具标签（`<shell_exec command="...">`）：解析器开标签正则 `^<name>` 不接受属性
 *   ⇒ 不提取、不执行（hadTools=false，去重/闸门均不经过）；但 raw-tool-text 兜底
 *   （开标签正则允许属性）能剥掉 ⇒ 剥完 cleanReply 为空。（§4 不对称正是本驱动依赖：
 *   若将来解析器支持属性形态，本驱动变形，需换驱动。）
 * - JSON body 内含 ``` 围栏：`shouldNudge` 的围栏判定「偶数围栏 = 已闭合可交付 ⇒ 不 nudge」
 *   ⇒ incompleteReply=false ⇒ 走 L3126「循环真正结束」（不进协议修复支）。
 *
 * ⚠️ **围栏必须成对**（2026-11-14 R4-N6 移植后）：奇数次 = 未闭合 = 模型仍在写，
 * `shouldNudge` 会判"要继续"，于是本驱动会拐进协议修复轮、拿不到 L3146 支（#55 三条用例
 * 就是这么红的）。要测"交付了一个代码块"，就给**偶数**枚；要测"未闭合"，用
 * `sseAttrToolUnclosed()`（单枚）并断言它走修复轮。
 */
function sseAttrTool(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec command=\\"echo ```hi``` hi\\">{\\"command\\":\\"echo hi\\"}</shell_exec>"}]}\n\n';
}

/** 单枚 ```（未闭合代码块）——模型写到一半被截断的形态；R4-N6 起必须判"继续"、走协议修复轮。 */
function sseAttrToolUnclosed(): string {
  return 'data: {"v":[{"type":"RESPONSE","content":"<shell_exec command=\\"echo ``` hi\\">{\\"command\\":\\"echo hi\\"}</shell_exec>"}]}\n\n';
}

function fireFirstRoundAttr(FakeXHR: ReturnType<typeof makeFakeXhrClass>, sessionId: string, attrPayload: string) {
  const first = new FakeXHR();
  first.open('POST', CHAT_URL);
  first.onreadystatechange = () => {};
  first.send(JSON.stringify({ prompt: 'hi', chat_session_id: sessionId }));
  first.respond(200, attrPayload + sseDone());
  return first;
}

describe('T-2b 验收断言：全工具原文收尾的中性说明（L3146 支，甲案）', () => {
  it('续跑轮回复只有工具原文 ⇒ 中性说明落 bubble（fallbackText＋recordFinal:true）、不挂 appendError、禁词机锁', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      fireFirstRound(FakeXHR, 't2b-neutral');
      await vi.advanceTimersByTimeAsync(2_000);
      // 第 2 续跑轮：带属性工具标签＋代码围栏 ⇒ L3126「循环真正结束」⇒ L3146 支
      const reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseAttrTool() + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      // 循环以 completed 收尾（trace 面不动：本支不新增任何 trace 事件）
      const ends = interceptorTraceSnapshot().filter((e) => e.t === 'turn.end' && e.stopReason === 'completed');
      expect(ends.length).toBeGreaterThan(0);
      // 中性说明以甲案形态落地
      const call = chatUI.finishAssistantMessage.mock.calls.find((c) => (c[0] as { fallbackText?: string })?.fallbackText === NEUTRAL_TOOL_ONLY_REPLY_NOTE);
      expect(call).toBeDefined();
      expect(call![0]).toMatchObject({ fallbackText: NEUTRAL_TOOL_ONLY_REPLY_NOTE, recordFinal: true });
      // 此支非故障：不挂 appendError
      expect(chatUI.appendError.mock.calls.length).toBe(0);
      // 禁词机锁（文案面）：故障／失败／错误 0 命中
      expect(NEUTRAL_TOOL_ONLY_REPLY_NOTE).not.toContain('故障');
      expect(NEUTRAL_TOOL_ONLY_REPLY_NOTE).not.toContain('失败');
      expect(NEUTRAL_TOOL_ONLY_REPLY_NOTE).not.toContain('错误');
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('现状锁：续跑轮回复带非空正文 ⇒ 走原 L3143 路径（fallbackText=正文＋onAssistantReply 落地），中性说明不沾', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI, onAssistantReply } = installHarness();
    try {
      fireFirstRound(FakeXHR, 't2b-normal');
      await vi.advanceTimersByTimeAsync(2_000);
      const reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseText('全部完成。') + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      // L3143 原路径：正文走 fallbackText、recordFinal:true、推送 onAssistantReply
      const call = chatUI.finishAssistantMessage.mock.calls.find((c) => (c[0] as { fallbackText?: string })?.fallbackText === '全部完成。');
      expect(call).toBeDefined();
      expect(call![0]).toMatchObject({ fallbackText: '全部完成。', recordFinal: true });
      expect(onAssistantReply).toHaveBeenCalledWith('全部完成。', expect.anything());
      // 中性说明不沾正常路径
      expect(chatUI.finishAssistantMessage.mock.calls.every((c) => (c[0] as { fallbackText?: string })?.fallbackText !== NEUTRAL_TOOL_ONLY_REPLY_NOTE)).toBe(true);
    } finally { handle.stop(); vi.useRealTimers(); }
  });

  it('真机渲染面（jsdom 真 chatUI）：改后该场景页面显示中性说明（改前同驱动＝空白气泡，负控红态为证）', async () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
    const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'hi', exitCode: 0 } }));
    const ui = createStudioChatUI();
    document.body.appendChild(ui.container);
    const handle = installMainWorldInterceptor({ sender, chatUI: ui as never, diag: () => {} });
    try {
      fireFirstRoundAttr(FakeXHR, 't2b-render', sseTool());
      await vi.advanceTimersByTimeAsync(2_000);
      const reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseAttrTool() + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      // 真 chatUI：中性说明落进 DOM 消息列表（L868 早退守卫靠 startAssistantMessage 先开气泡绕开）
      expect(ui.container.textContent).toContain(NEUTRAL_TOOL_ONLY_REPLY_NOTE);
    } finally {
      handle.stop();
      ui.destroy();
      vi.useRealTimers();
    }
  });
});

/**
 * R4-N6（2026-11-14 移植 `continuation-prompt` 围栏奇偶）的**净增回归锁**。
 *
 * 行为变化本身：奇数次 ``` = 未闭合代码块 = 模型仍在写 ⇒ `shouldNudge` 为 true
 * ⇒ `shouldAttemptProtocolRepair` 为 true ⇒ 走协议修复轮（L3181 支），**不再**落
 * L3146「循环真正结束」的中性说明。
 *
 * 为什么单独一条：上面三条 T-2b 用例测的是"交付了一个**闭合**代码块"（已改成偶数围栏），
 * 它们抓不住奇偶判定被改回 `includes('```')` 的回归——那条只有本用例抓得住。
 * 负控：把 `shouldNudge` 的围栏判定改回 `tail.includes('```')` ⇒ 本用例红（走中性说明支）。
 */
describe('R4-N6 奇数围栏（未闭合代码块）⇒ 协议修复轮，不落中性说明', () => {
  it('单枚 ``` 的回复 ⇒ 走协议修复：trace 记 protocol-repair、发修复请求、无中性说明、无 appendError', async () => {
    vi.useFakeTimers();
    const { FakeXHR, handle, chatUI } = installHarness();
    try {
      fireFirstRound(FakeXHR, 't2b-unclosed');
      await vi.advanceTimersByTimeAsync(2_000);
      // 续跑轮：带属性工具标签 + **单枚** ```（未闭合）
      const reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseAttrToolUnclosed() + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);

      // ① 决策 trace：走协议修复（不是「循环真正结束」）
      const repairDecision = interceptorTraceSnapshot().filter(
        (e) => e.t === 'continuation.decision' && e.reason === 'protocol-repair' && e.triggered === true,
      );
      expect(repairDecision.length).toBeGreaterThan(0);

      // ② 不落中性说明（L3146 支的字面句）
      const neutral = chatUI.finishAssistantMessage.mock.calls.find(
        (c) => (c[0] as { fallbackText?: string })?.fallbackText === NEUTRAL_TOOL_ONLY_REPLY_NOTE,
      );
      expect(neutral).toBeUndefined();
      // 本支非故障收尾：不挂 appendError
      expect(chatUI.appendError.mock.calls.length).toBe(0);

      // ③ 修复轮真的发出去了：请求体 prompt 带协议修复首句
      const repairReqs = chatRequests(FakeXHR).filter((x) => (x.body ?? '').includes('未完整遵循工具调用协议'));
      expect(repairReqs.length).toBeGreaterThan(0);
    } finally { handle.stop(); vi.useRealTimers(); }
  });
});

/**
 * C-1 / #61（出资人拍板首位候选实证）：「在飞气泡＋无条件 start」的显示面实证。
 * 驱动（真 chatUI jsdom、无 mock）：
 * - 第 1 轮：真工具执行（sseTool 无属性）⇒ 工具卡开气泡 B0（startToolCard L940 条件 start，属上一场景）；
 * - 第 2 轮（续跑）：空回复 ⇒ L3104 finish({recordFinal:false}) 关 B0（currentAssistant=null）＋协议修复轮起；
 * - 第 3 轮（修复轮）：带属性工具原文（sseAttrTool）⇒ 不提取、不执行；但 chunk 循环 append（L2150：
 *   解析器不提取属性形态、clean ≠ ''）把工具原文喂进在飞气泡 B1（L840 自动开泡）。
 * 红态读数（修前、在案）：L3155 支入口 B1 在飞，无条件 startAssistantMessage() 抢占它、
 * 再开第二枚 B2（中性说明）⇒ 本场景 delta＝2＝「多一枚空气泡＋一枚中性说明」
 * （PM 待验预测：气泡枚数面命中；光标面不命中——B1 的 80ms 渲染被 L811/L870 清掉、光标从未渲染，cursors=0）。
 * 卡面判读：红 ⇒ 把 L3155 的 start 按 hasOpenAssistantBubble() 条件化（「无泡才开泡」）、修到绿。
 * 修后本 it 锁：本场景 delta 气泡枚数 == 1（B1 复用收中性说明、不多开）＋收尾后 .ds-sc-cursor 零残留
 * （收尾时 streaming 节点被整体替换/移除，光标结构性带不进已收尾气泡）。
 */
describe('C-1 / #61 在飞边缘：协议修复轮全工具原文 ⇒ 本场景恰一枚气泡（复用收中性说明）、无光标残留', () => {
  it('本场景 delta 气泡枚数 == 1（在飞气泡携中性说明；无条件 start 形态会是 2 枚）且 .ds-sc-cursor 零残留', async () => {
    vi.useFakeTimers();
    const FakeXHR = makeFakeXhrClass();
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    vi.stubGlobal('location', { href: 'https://chat.deepseek.com/' });
    const sender = vi.fn(async () => ({ ok: true, data: { stdout: 'hi', exitCode: 0 } }));
    const ui = createStudioChatUI();
    document.body.appendChild(ui.container);
    const handle = installMainWorldInterceptor({ sender, chatUI: ui as never, diag: () => {} });
    try {
      // 第 1 轮：真工具执行（B0 带工具卡，属上一场景）
      fireFirstRoundAttr(FakeXHR, 't61-c1', sseTool());
      await vi.advanceTimersByTimeAsync(2_000);
      // 第 2 轮（续跑）：空回复 ⇒ L3104 关 B0 ＋ 修复轮起
      let reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseText('') + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      // 前提锚：进修复轮时刻，B0（已收尾、带工具卡）是唯一在 DOM 的助手气泡
      const before = ui.container.querySelectorAll('.ds-sc-msg-assistant').length;
      expect(before).toBe(1);
      // 第 3 轮（修复轮）：L2150 append 把工具原文喂进在飞气泡 B1（自动开泡）⇒ L3155 支入口，条件 start 不再多开
      reqs = chatRequests(FakeXHR);
      reqs[reqs.length - 1].respond(200, sseAttrTool() + sseDone());
      await vi.advanceTimersByTimeAsync(2_000);
      // 格①（气泡枚数）：本场景 delta 恰好 1（B1 复用携中性说明；旧无条件 start 形态会是 2，负控红态在案）
      const after = ui.container.querySelectorAll('.ds-sc-msg-assistant').length;
      expect(after - before).toBe(1);
      // 末枚气泡（B1）携中性说明（该气泡显示面正确，非仅枚数正确）
      const last = ui.container.querySelectorAll('.ds-sc-msg-assistant')[after - 1] as HTMLElement;
      expect(last.textContent).toContain(NEUTRAL_TOOL_ONLY_REPLY_NOTE);
      // 格②（光标态）：收尾后 .ds-sc-cursor 零残留（整容器）
      // 机制保证：光标 span 仅在 currentRawText 非空时插入 streaming（studio-chat-ui.ts L832），
      // 收尾时 streaming 节点被整体替换/移除（L878-892）⇒ 光标结构性带不进已收尾气泡。
      expect(ui.container.querySelectorAll('.ds-sc-cursor').length).toBe(0);
    } finally {
      handle.stop();
      ui.destroy();
      vi.useRealTimers();
    }
  });
});
