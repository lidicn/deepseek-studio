// @vitest-environment node
/**
 * 对话级放行的作用域 —— **K2（2026-11-09）语义翻转版**。
 *
 * ── 历史（必须留着，否则下一个人会把这次改回读成"缺陷回潮"）──
 *
 * C1 P1 安全批 R3-01（2026-10-2x）当时的结论：`conversationApprovalKeyOf` 不含工具名，
 * 于是用户在 `file.read` 上点一次「本次对话始终允许」→ 同对话内 `shell.exec` /
 * `file.write`（含工作区外）/ `policy.set` **全部静默放行**。
 * 修法是把 `toolId` + `canonicalTarget` 塞进 key。
 *
 * ── 为什么现在去掉（出资人 2026-11-09 08:2x 原话）──
 *
 * 「**该整个对话就是整个对话**。该某次放行就是某次放行。该完全放开，就彻底关闭审批。」
 * R3-01 的 key 侧修法虽有安全收益，但**副作用是"一次对话审批一次"在
 * `python.exec` / `shell.exec` 这类工具上永远不可能成立**——它们的 `canonicalTarget`
 * 天然每次调用都变（设计稿 D2）。用户点一次，下一条命令又弹，诉求完全没被满足。
 *
 * ── 现在的分层（这是本文件要钉的东西）──
 *
 * | 层次 | 谁来管 | 本文件对应断言 |
 * |---|---|---|
 * | key 只管**语境**（principal／工作区／档位／对话） | `conversationApprovalKeyOf` | ① 换工具／换目标 **不再** 改变 key |
 * | **地板门**：只有 `mode` 类享受对话级放行 | `authorization.ts` 的 `cls === 'mode'` | ② 已放行后 `python.exec` **仍问** |
 * | **越界**永不吃对话级放行 | `authorization.ts` 的 `!outsideRequested` | ③ 越界 **仍问**（`memory.purge` 单独一枚） |
 * | hard-deny／策略 deny／unknown 永不被覆盖 | 前四步 return | ④ 三态各一枚 |
 *
 * ⚠️ 地板门是**保守门**（等出资人拍板"跨工具免审是否放开"）。若拍板放开，
 * 删掉 `cls === 'mode'` 那一项即可，**届时本文件 ② 那枚要按纪律④翻转并留记录**。
 */

import { describe, it, expect } from 'vitest';
import {
  conversationApprovalKeyOf,
  createConversationApprovalStore,
} from '../../src/host/conversation-approval';
import { resolveAuthorization, type AuthorizationInput } from '../../src/host/authorization';
import { CONVERSATION_APPROVAL_EXEMPT } from '../../src/shared/policy-contract';
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

// ── ① key 只管语境：换工具／换目标**不再**改变 key ──────────────────────────

describe('K2 · 对话级 key 只由语境构成（toolId / canonicalTarget 已移除）', () => {
  it('同一对话内换工具 ⇒ **同一个 key**（新语义：整个对话就是整个对话）', () => {
    // 旧语义（R3-01）这里会 not.toBe；K2 翻转成 toBe。
    // 注意：key 本身已经不含 toolId，所以两次调用参数完全相同——
    // 这枚锁的是"函数签名不再接收工具维度"，而不是"值恰好相等"。
    expect(keyOf('c1')).toBe(keyOf('c1'));
    expect(Object.keys({ principal: 1, workspaceHash: 1, policyMode: 1, conversationId: 1 })).toHaveLength(4);
  });

  it('换对话 ⇒ 换 key（旧放行不跨对话生效）', () => {
    expect(keyOf('c1')).not.toBe(keyOf('c2'));
  });

  it('换工作区 ⇒ 换 key', () => {
    expect(keyOf('c1', { workspaceHash: 'other' })).not.toBe(keyOf('c1'));
  });

  it('换档位 ⇒ 换 key', () => {
    expect(keyOf('c1', { policyMode: 'auto' })).not.toBe(keyOf('c1'));
  });

  it('换发起者 ⇒ 换 key', () => {
    expect(keyOf('c1', { principal: 'bot-7' })).not.toBe(keyOf('c1'));
  });

  it('key 的四个维度都参与拼接（少一维就撞车）', () => {
    const k = keyOf('c1');
    expect(k.startsWith('main|')).toBe(true);
    expect(k).toContain(WS);
    expect(k).toContain('full');
    expect(k).toContain('c1');
    // 恰好四段
    expect(k.split('|')).toHaveLength(4);
  });
});

// ── ② 地板门：已放行后，特权／always 类仍要问 ────────────────────────────────

describe('K2 · 地板门：对话级放行只覆盖 mode 类', () => {
  it('① 正控：区内 mode 类（file.write）已放行 ⇒ allow', () => {
    const r = resolveAuthorization(
      mk('file.write', {
        mode: 'auto',
        conversationApproved: true,
        params: { path: 'C:/ws/a.txt', content: 'x' },
      }),
    );
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('conversation-approved');
  });

  it('② 守门：已放行后 python.exec（always）⇒ **仍 ask**', () => {
    // 这枚就是"出资人若选放开跨工具免审"时唯一要翻的那一枚（纪律④，需留翻转记录）。
    const r = resolveAuthorization(
      mk('python.exec', {
        mode: 'auto',
        conversationApproved: true,
        params: { code: 'print(1)' },
      }),
    );
    expect(r.decision).toBe('ask');
  });

  it('②-补：已放行后 memory.delete（always）⇒ 仍 ask', () => {
    const r = resolveAuthorization(
      mk('memory.delete', {
        mode: 'auto',
        conversationApproved: true,
        params: { id: 'm1' },
      }),
    );
    expect(r.decision).toBe('ask');
  });

  it('②-补：已放行后 shell.exec（mode 类但**在豁免表内**）⇒ 仍 ask', () => {
    // `shell.exec` 是 `approvalClass:'mode'`，本该穿地板门；但它在
    // `CONVERSATION_APPROVAL_EXEMPT` 里 —— 因为"一次点击之后任意命令都不再问"
    // 把 hard-deny 地板之外的全部命令面交给了模型（`del /s`、`curl | sh` 都不在地板里）。
    //
    // 负控：把 `'shell.exec'` 从豁免表里删掉 ⇒ 这枚必红（那时它会变 allow）。
    // 这是"守门"，不是"记录现状"。
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'auto',
        conversationApproved: true,
        params: { command: 'whoami' },
      }),
    );
    expect(r.decision).toBe('ask');
    expect(CONVERSATION_APPROVAL_EXEMPT).toContain('shell.exec');
  });

  it('②-补：豁免表**只**含 shell.exec（新增豁免项必须同时补测试）', () => {
    // 与 `FULL_MODE_STILL_ASKS` 同规：表是本文件锁定对象，加项要在这里留痕。
    expect([...CONVERSATION_APPROVAL_EXEMPT]).toEqual(['shell.exec']);
  });
});

// ── ③ 越界：永不吃对话级放行（这一格 R3-01b 起就没动过）────────────────────

describe('K2 · 越界不吃对话级放行', () => {
  it('越界 + 已放行 ⇒ 仍 ask（`!outsideRequested` 那格一字未动）', () => {
    const r = resolveAuthorization(
      mk('file.write', {
        mode: 'auto',
        conversationApproved: true,
        policyVerdict: { decision: 'require-consent', reason: 'outside-workspace', outside: true },
        params: { path: 'D:/outside/a.txt', content: 'x' },
      }),
    );
    expect(r.decision).toBe('ask');
    expect(r.outsideApproved).toBe(false);
  });

  it('越界理由被 risk-detected 占着时（outside 独立布尔）⇒ 仍 ask', () => {
    // R3-01b 的原始形状：reason 被风险占走，越界事实只靠 outside 布尔传下来。
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'auto',
        conversationApproved: true,
        policyVerdict: { decision: 'require-consent', reason: 'risk-detected', outside: true },
        params: { command: 'rm -rf x', cwd: 'D:/outside' },
      }),
    );
    expect(r.decision).toBe('ask');
  });

  it('**memory.purge**：已放行 + 越界 ⇒ 仍 ask（防第 5 步绕过 FULL_MODE_STILL_ASKS）', () => {
    // `FULL_MODE_STILL_ASKS` 那道例外在第 6 步（always 块），位置在对话级放行之后。
    // 地面门（cls==='mode'）已经把 always 挡在门外，这枚再钉一次"越界那一层也别想绕"。
    const r = resolveAuthorization(
      mk('memory.purge', {
        mode: 'full',
        conversationApproved: true,
        policyVerdict: { decision: 'require-consent', reason: 'outside-workspace', outside: true },
        params: { id: 'm1' },
      }),
    );
    expect(r.decision).toBe('ask');
  });
});

// ── ④ 红线：hard-deny / 策略 deny / unknown 永不被对话级放行覆盖 ─────────────

describe('K2 · 对话级放行覆盖不到的三态', () => {
  it('hard-deny ⇒ deny（即便已放行）', () => {
    const r = resolveAuthorization(
      mk('file.write', { mode: 'auto', conversationApproved: true, hardRule: 'disk-root-delete' }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hard-deny');
  });

  it('策略层 deny ⇒ deny（即便已放行）', () => {
    const r = resolveAuthorization(
      mk('file.write', {
        mode: 'auto',
        conversationApproved: true,
        policyVerdict: { decision: 'deny', reason: 'mode-restricted', outside: true },
      }),
    );
    expect(r.decision).toBe('deny');
  });

  it('未登记工具 ⇒ deny（即便已放行）', () => {
    const r = resolveAuthorization({
      tool: 'not-a-tool',
      params: {},
      mode: 'auto',
      policyVerdict: null,
      workspaceHash: WS,
      principal: 'main',
      now: NOW,
      def: undefined,
      conversationApproved: true,
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('unknown-capability');
  });
});

// ── ⑤ 端到端：store 的行为跟着新 key 走 ─────────────────────────────────────

describe('K2 · 端到端：同对话内一次放行覆盖 mode 类全部目标', () => {
  it('放行 file.write(a) 后，同对话的 file.write(b) ⇒ 命中（不再逐目标问）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    expect(store.check(keyOf('c1'))).toBe(true);
  });

  it('放行后换对话 ⇒ 不命中', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    expect(store.check(keyOf('c2'))).toBe(false);
  });

  it('放行后换档位 ⇒ 不命中（bumpGeneration 也会清空）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1'));
    expect(store.check(keyOf('c1', { policyMode: 'auto' }))).toBe(false);
    store.bumpGeneration();
    expect(store.check(keyOf('c1'))).toBe(false);
  });
});
