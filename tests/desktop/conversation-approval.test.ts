// @vitest-environment node
/**
 * 对话级放行（"一个对话审批一次"）测试。
 *
 * 覆盖两件事：
 *  1) 对话级放行表本身的 key 语义与失效条件（换对话 / 换工作区 / 换档位 / 断线）；
 *  2) resolveAuthorization 中 conversationApproved 的位置：
 *     它必须晚于 hard-deny / policy deny / unknown，早于 always / mode 判定。
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

function keyOf(conversationId: string, over: Partial<{ workspaceHash: string; policyMode: string; principal: string }> = {}): string {
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
