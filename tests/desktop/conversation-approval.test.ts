// @vitest-environment node
/**
 * 对话级放行（"一个对话审批一次"）测试。
 *
 * 覆盖两件事：
 *  1) 对话级放行表本身的 key 语义与失效条件（换对话 / 换工作区 / 换档位 / 断线）；
 *  2) resolveAuthorization 中 conversationApproved 的位置：
 *     它必须晚于 hard-deny / policy deny / unknown，早于 always / mode 判定。
 *
 * ── C1 P1 安全批 R3-01：key 语义变更 ──
 *
 * **变更理由**（PM 核实）：原 key **刻意不含工具名**（旧注释：「一个对话审批一次覆盖该对话内全部调用」），
 * 于是用户在 `file.read` 上点一次「本次对话始终允许」→ 同对话内 `shell.exec` / `file.write`
 * （含**工作区外**）/ `policy.set` **全部静默放行**。
 * 一次「读个文件」的同意被放大成「这个对话里随便干什么都行」。
 *
 * **现在**：key 纳入 **toolId + canonicalTarget** → 同意只对「这个工具 + 这个目标」生效；
 * 换工具或换目标**必须重新询问**。
 * 这不违背「一个对话审批一次」的诉求 —— 诉求是「别每个执行都弹」，不是「一次同意覆盖所有工具」。
 *
 * 同时 `resolveAuthorization` 的 `outsideApproved` 在对话级放行分支**恒为 false**
 * （原实现把 `outsideRequested` 直接透传 → 对话级同意顺带批准了工作区外的操作）。
 */

import { describe, it, expect } from 'vitest';
import {
  conversationApprovalKeyOf,
  createConversationApprovalStore,
} from '../../src/host/conversation-approval';
import { resolveAuthorization, type AuthorizationInput } from '../../src/host/authorization';
import { DEFAULT_TOOL_DEFINITIONS } from '../../src/host/tool-definitions';
import type { ToolDefinition } from '../../src/host/tool-registry';

const byId: Record<string, ToolDefinition> = Object.fromEntries(
  DEFAULT_TOOL_DEFINITIONS.map((d) => [d.id, d]),
);

const WS = 'wsabc123def4';
const NOW = 1_000_000;

function mk(tool: string, over: Partial<Omit<AuthorizationInput, 'tool'>> = {}): AuthorizationInput {
  return {
    tool,
    params: {},
    mode: 'full',
    policyVerdict: null,
    workspaceHash: WS,
    principal: 'main',
    now: NOW,
    def: byId[tool],
    ...over,
  };
}

/**
 * 造对话级放行 key。
 *
 * R3-01 后 key 含 toolId + canonicalTarget —— 这里给出默认值，
 * 让既有断言（「换对话/换工作区/换档位 → 重新询问」）**继续测它本来要测的东西**，
 * 而不被新增的两个维度干扰。
 */
function keyOf(
  conversationId: string,
  over: Partial<{
    workspaceHash: string;
    policyMode: string;
    principal: string;
  }> = {},
): string {
  return conversationApprovalKeyOf({
    principal: over.principal ?? 'main',
    workspaceHash: over.workspaceHash ?? WS,
    policyMode: over.policyMode ?? 'full',
    conversationId,
  });
}

describe('对话级放行表 · key 与失效', () => {
  it('key 随 principal / 工作区 / 档位 / 对话任一变化而变化', () => {
    const base = keyOf('c1');
    expect(keyOf('c1', { principal: 'bot-b' })).not.toBe(base);
    expect(keyOf('c1', { workspaceHash: 'other' })).not.toBe(base);
    expect(keyOf('c1', { policyMode: 'auto' })).not.toBe(base);
    expect(keyOf('c2')).not.toBe(base);
  });

  // ── K2（2026-11-09）语义翻转：工具与目标**不再**进 key ──
  //
  // R3-01（2026-10-2x）当年把 toolId + canonicalTarget 塞进 key，修掉了"file.read 的同意
  // 放行 shell.exec"；但副作用是 python.exec / shell.exec 这类目标每次都变的工具永远做不到
  // "一次对话一次"（设计稿 D2）。出资人 2026-11-09 08:2x：「该整个对话就是整个对话」。
  // ⇒ key 只由语境四维构成；**越界与 always 类另有门守着**（见
  // `c1p1-r301-conversation-scope.test.ts` 的 ②③ 两组断言）。
  it('K2：同一对话内换工具 ⇒ **同一个 key**（新语义，R3-01 已退役）', () => {
    // key 函数已不接收工具维度 ⇒ 同参数的两次调用必然相等。
    // 这枚锁的是"key 不含工具维度"这件事本身，而不是值巧合。
    const base = keyOf('c1');
    expect(keyOf('c1')).toBe(base);
    expect(base.split('|')).toHaveLength(4);
  });

  it('K2：同一对话内换目标 ⇒ **同一个 key**（旧放行覆盖全对话目标）', () => {
    expect(keyOf('c1')).toBe(keyOf('c1'));
  });

  it('同一对话内 grant 后即命中；换 key 不命中', () => {
    const store = createConversationApprovalStore();
    const key = keyOf('c1');
    expect(store.check(key)).toBe(false);
    store.grant(key);
    expect(store.check(key)).toBe(true);
    expect(store.check(keyOf('c2'))).toBe(false);
  });

  it('bumpGeneration（断线 / 停止 / 换策略）清空放行且世代号递增', () => {
    const store = createConversationApprovalStore();
    const key = keyOf('c1');
    store.grant(key);
    const g0 = store.currentGeneration();
    const g1 = store.bumpGeneration();
    expect(g1).toBe(g0 + 1);
    expect(store.check(key)).toBe(false);
  });

  it('invalidateInFlight（瞬时断线/重连）只递增世代号，保留已批准对话', () => {
    const store = createConversationApprovalStore();
    const key = keyOf('c1');
    store.grant(key);
    const g0 = store.currentGeneration();
    const g1 = store.invalidateInFlight();
    expect(g1).toBe(g0 + 1);
    expect(store.check(key)).toBe(true);
  });
});

describe('resolveAuthorization · conversationApproved 的位置', () => {
  it('K2：auto 档 always 类（python.exec）即使已放行 ⇒ 仍 ask（地板门挡在外面）', () => {
    const store = createConversationApprovalStore();
    const key = keyOf('c1');

    // 原用例验的是"第一次 ask、对话级放行后第二次 allow"。
    // K2 的地板门（`cls === 'mode'`）把 always 类挡在第 5 步之外 ⇒ 两次都是 ask。
    // 若出资人拍板放开"跨工具免审"，这枚按纪律④翻回 allow 并留记录。
    const first = resolveAuthorization(mk('python.exec', { mode: 'auto', conversationApproved: false }));
    expect(first.decision).toBe('ask');

    store.grant(key);
    const second = resolveAuthorization(mk('python.exec', { mode: 'auto', conversationApproved: store.check(key) }));
    expect(second.decision).toBe('ask');
  });

  it('K2：auto 档 mode 类（file.write）已放行 ⇒ allow（出资人要的"一次对话一次"）', () => {
    // 同一份 store、同一把 key：换到 mode 类就应当被放行——证明上面那枚 ask 是地板门造成的，
    // 不是"对话级放行整体失效"。
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    const r = resolveAuthorization(
      mk('file.write', {
        mode: 'auto',
        conversationApproved: store.check(keyOf('c1')),
        params: { path: 'C:/ws/a.txt', content: 'x' },
      }),
    );
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('conversation-approved');
  });

  it('反证（卡 H 的语义）：full 档下同一调用**不需要**对话级放行就已 allow', () => {
    const fullNoGrant = resolveAuthorization(mk('python.exec', { mode: 'full', conversationApproved: false }));
    expect(fullNoGrant.decision).toBe('allow');
    expect(fullNoGrant.reason).toBe('full-mode-allow');
  });

  it('换对话 → 重新询问（auto 档 always 类：两次都 ask，换不换对话都一样）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    // 地板门挡住 always 类 ⇒ 这里两枚都是 ask。**换对话的隔离性**由下面 mode 类那枚证明
    // （那才是"对话级放行本体会不会跨对话生效"的真问题）。
    expect(
      resolveAuthorization(mk('python.exec', { mode: 'auto', conversationApproved: store.check(keyOf('c1')) })).decision,
    ).toBe('ask');
    expect(
      resolveAuthorization(mk('python.exec', { mode: 'auto', conversationApproved: store.check(keyOf('c2')) })).decision,
    ).toBe('ask');
  });

  it('换工作区 → 重新询问', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    // non-full 档：换工作区后 key 不命中 ⇒ 回到 ask（full 档下 always 类第一次就不问，见卡 H）
    expect(
      resolveAuthorization(
        mk('python.exec', { mode: 'auto', workspaceHash: 'other-ws', conversationApproved: store.check(keyOf('c1', { workspaceHash: 'other-ws' })) }),
      ).decision,
    ).toBe('ask');
  });

  it('换档位 → 重新询问', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1', { policyMode: 'full' }));
    expect(
      resolveAuthorization(
        mk('python.exec', { mode: 'auto', conversationApproved: store.check(keyOf('c1', { policyMode: 'auto' })) }),
      ).decision,
    ).toBe('ask');
  });

  // ── K2（2026-11-09）：R3-01 的 key 侧断言已翻转 ──
  //
  // 历史上这两枚证明「换工具/换目标 → 重新询问」；K2 按出资人 08:2x 语义去掉 key 里的
  // toolId/canonicalTarget，于是"换工具不再重新询问"是**新诉求**。
  //
  // ⚠️ 但"不再问"**不是无条件的**：`authorization.ts` 的地板门（`cls === 'mode'`）与
  // `CONVERSATION_APPROVAL_EXEMPT`（首批只有 `shell.exec`）仍然把 always 类与命令执行挡在门外；
  // 越界那一格（`!outsideRequested`）**一字未动**。这三道门的成对断言在
  // `c1p1-r301-conversation-scope.test.ts` 的 ②③ 两组里，本文件只锁 key 本身的形状。
  it('K2：换工具 ⇒ key 不变（同对话内一次放行覆盖所有 mode 类）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    // 关键：这里已经**没有**"换工具就换 key"的可能——key 函数不接收工具维度。
    expect(store.check(keyOf('c1'))).toBe(true);
    expect(keyOf('c1').split('|')).toHaveLength(4);
  });

  it('K2：换目标 ⇒ key 不变（A.txt 的同意覆盖同对话的 B.txt）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    expect(store.check(keyOf('c1'))).toBe(true);
  });

  it('R3-01b：越界目标不被对话级放行放行（逐次询问），且 outsideApproved 恒 false', () => {
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'full',
        conversationApproved: true,
        // 策略层判的是「目标在工作区外」。
        policyVerdict: { decision: 'require-consent', reason: 'outside-workspace' },
      }),
    );
    // C1 P1 安全批 R3-01b：语义收紧 —— 越界目标回到档位判定 → 逐次询问
    // （§1.4 硬规则 5「跨工作区必须逐次确认」）。
    // 本用例的 policyVerdict **故意不带** `outside` 字段 → 走「靠 reason 兜底」的
    // 那条判据，同时守住兜底路径没被改坏。
    expect(r.decision).toBe('ask');
    // 关键：越界**不**被对话级放行顺带批准（两层防线都在）。
    expect(r.outsideApproved).toBe(false);
  });

  it('hard-deny 永不被对话级放行覆盖', () => {
    const r = resolveAuthorization(mk('python.exec', { mode: 'full', conversationApproved: true, hardRule: 'rule-redline' }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hard-deny');
  });

  it('未登记工具（unknown-capability）永不被对话级放行覆盖', () => {
    const r = resolveAuthorization(mk('not.a.tool', { mode: 'full', conversationApproved: true, def: undefined }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('unknown-capability');
  });

  it('policy 层 deny 永不被对话级放行覆盖', () => {
    const r = resolveAuthorization(
      mk('python.exec', {
        mode: 'full',
        conversationApproved: true,
        policyVerdict: { decision: 'deny', reason: 'missing-path' },
      }),
    );
    expect(r.decision).toBe('deny');
  });
});
