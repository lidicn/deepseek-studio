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
    toolId: string;
    canonicalTarget: string;
  }> = {},
): string {
  return conversationApprovalKeyOf({
    principal: over.principal ?? 'main',
    workspaceHash: over.workspaceHash ?? WS,
    policyMode: over.policyMode ?? 'full',
    conversationId,
    toolId: over.toolId ?? 'python.exec',
    canonicalTarget: over.canonicalTarget ?? '',
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

  // ── C1 P1 安全批 R3-01 新增：工具与目标必须进 key ──
  it('R3-01：key 随 toolId 变化而变化（file.read 的同意不放行 shell.exec）', () => {
    const base = keyOf('c1', { toolId: 'file.read' });
    expect(keyOf('c1', { toolId: 'shell.exec' })).not.toBe(base);
  });

  it('R3-01：key 随 canonicalTarget 变化而变化（A.txt 的同意不放行 B.txt）', () => {
    const base = keyOf('c1', { canonicalTarget: 'file:a.txt' });
    expect(keyOf('c1', { canonicalTarget: 'file:b.txt' })).not.toBe(base);
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
  it('同对话第二次调用不再询问（always 类工具）', () => {
    const store = createConversationApprovalStore();
    const key = keyOf('c1');

    const first = resolveAuthorization(mk('python.exec', { mode: 'full', conversationApproved: false }));
    expect(first.decision).toBe('ask');

    store.grant(key);
    const second = resolveAuthorization(mk('python.exec', { mode: 'full', conversationApproved: store.check(key) }));
    expect(second.decision).toBe('allow');
    expect(second.reason).toBe('conversation-approved');
  });

  it('换对话 → 重新询问', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    expect(
      resolveAuthorization(mk('python.exec', { mode: 'full', conversationApproved: store.check(keyOf('c1')) })).decision,
    ).toBe('allow');
    expect(
      resolveAuthorization(mk('python.exec', { mode: 'full', conversationApproved: store.check(keyOf('c2')) })).decision,
    ).toBe('ask');
  });

  it('换工作区 → 重新询问', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    expect(
      resolveAuthorization(
        mk('python.exec', { mode: 'full', workspaceHash: 'other-ws', conversationApproved: store.check(keyOf('c1', { workspaceHash: 'other-ws' })) }),
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

  // ── C1 P1 安全批 R3-01 新增 ──
  it('R3-01：换工具 → 重新询问（file.read 的对话级同意不放行 shell.exec）', () => {
    const store = createConversationApprovalStore();
    // 用户在 file.read 上点了「本次对话始终允许」。
    store.grant(keyOf('c1', { toolId: 'file.read' }));
    // 同一对话里调 shell.exec → key 不同 → 没被放行 → 必须重新询问。
    const shellKey = keyOf('c1', { toolId: 'shell.exec' });
    expect(store.check(shellKey)).toBe(false);
    expect(
      resolveAuthorization(mk('shell.exec', { mode: 'full', conversationApproved: store.check(shellKey) })).decision,
    ).toBe('ask');
  });

  it('R3-01：换目标 → 重新询问（A.txt 的对话级同意不放行 B.txt）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1', { toolId: 'file.read', canonicalTarget: 'file:a.txt' }));
    const otherKey = keyOf('c1', { toolId: 'file.read', canonicalTarget: 'file:b.txt' });
    expect(store.check(otherKey)).toBe(false);
    expect(
      resolveAuthorization(mk('file.read', { mode: 'full', conversationApproved: store.check(otherKey) })).decision,
    ).toBe('ask');
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
