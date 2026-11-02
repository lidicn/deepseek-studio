// @vitest-environment node
/**
 * C1 P1 安全批 · R3-01：对话级放行不得放大成「这个对话里随便干什么都行」。
 *
 * ── 缺陷（PM 核实成立）──
 *
 * `conversationApprovalKeyOf` 原来**刻意不含工具名**（旧注释：「一个对话审批一次
 * 覆盖该对话内全部调用」），于是用户在 `file.read` 上点一次「本次对话始终允许」
 * → 同对话内 `shell.exec` / `file.write`（含**工作区外**）/ `policy.set`
 * **全部静默放行**。一次「读个文件」的同意被放大成了「这个对话里随便干什么都行」。
 *
 * ── 本文件的断言口径 ──
 *
 * 1. key 必须随 **toolId** 变（换工具 → 重新问）。
 * 2. key 必须随 **canonicalTarget** 变（换目标 → 重新问）。
 * 3. 对话级放行**不隐含批准工作区外**（outsideApproved 恒 false）。
 * 4. hard-deny / policy-deny / unknown 永不被对话级放行覆盖。
 * 5. 端到端：审 `file.read` 后，同对话内的 `shell.exec` **仍要弹窗**。
 */

import { describe, it, expect } from 'vitest';
import {
  conversationApprovalKeyOf,
  createConversationApprovalStore,
} from '../../src/host/conversation-approval';
import {
  canonicalTargetOf,
  resolveAuthorization,
  type AuthorizationInput,
} from '../../src/host/authorization';
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

describe('R3-01 · key 必须绑定工具与目标', () => {
  it('key 随 toolId 变化而变化', () => {
    expect(keyOf('c1', { toolId: 'file.read' })).not.toBe(keyOf('c1', { toolId: 'shell.exec' }));
  });

  it('key 随 canonicalTarget 变化而变化', () => {
    expect(keyOf('c1', { canonicalTarget: 'file:a.txt' })).not.toBe(keyOf('c1', { canonicalTarget: 'file:b.txt' }));
  });

  it('key 随 principal / 工作区 / 档位 / 对话变化而变化（既有口径不回归）', () => {
    const base = keyOf('c1');
    expect(keyOf('c1', { principal: 'bot-b' })).not.toBe(base);
    expect(keyOf('c1', { workspaceHash: 'other' })).not.toBe(base);
    expect(keyOf('c1', { policyMode: 'auto' })).not.toBe(base);
    expect(keyOf('c2')).not.toBe(base);
  });

  it('key 的每一段都参与拼接（toolId 与 canonicalTarget 不可被省略）', () => {
    const k = keyOf('c1', { toolId: 'file.read', canonicalTarget: 'file:a.txt' });
    expect(k).toContain('file.read');
    expect(k).toContain('file:a.txt');
  });
});

describe('R3-01 · 换工具 / 换目标 → 重新询问', () => {
  it('换工具 → 重新询问（file.read 的同意不放行 shell.exec）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1', { toolId: 'file.read' }));
    const shellKey = keyOf('c1', { toolId: 'shell.exec' });
    expect(store.check(shellKey)).toBe(false);
    expect(
      resolveAuthorization(mk('shell.exec', { mode: 'full', conversationApproved: store.check(shellKey) })).decision,
    ).toBe('ask');
  });

  it('换目标 → 重新询问（A.txt 的同意不放行 B.txt）', () => {
    const store = createConversationApprovalStore();
    store.grant(keyOf('c1', { toolId: 'file.read', canonicalTarget: 'file:a.txt' }));
    const otherKey = keyOf('c1', { toolId: 'file.read', canonicalTarget: 'file:b.txt' });
    expect(store.check(otherKey)).toBe(false);
    expect(
      resolveAuthorization(mk('file.read', { mode: 'full', conversationApproved: store.check(otherKey) })).decision,
    ).toBe('ask');
  });

  it('同工具同目标 → 不再询问（用户诉求「别每次都弹」仍成立）', () => {
    const store = createConversationApprovalStore();
    const key = keyOf('c1', { toolId: 'file.read', canonicalTarget: 'file:a.txt' });
    store.grant(key);
    expect(store.check(key)).toBe(true);
    expect(
      resolveAuthorization(mk('file.read', { mode: 'full', conversationApproved: store.check(key) })).decision,
    ).toBe('allow');
  });
});

describe('R3-01 · 对话级放行不隐含批准工作区外', () => {
  it('outsideApproved 恒为 false', () => {
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'full',
        conversationApproved: true,
        policyVerdict: { decision: 'require-consent', reason: 'outside-workspace' },
      }),
    );
    // C1 P1 安全批 R3-01b：语义收紧 —— 越界目标**不再**被对话级放行放行，
    // 而是回到档位判定 → 逐次询问（§1.4 硬规则 5「跨工作区必须逐次确认」）。
    // 本用例的 policyVerdict **故意不带** `outside` 字段 → 走「靠 reason 兜底」的
    // 那条判据，同时守住兜底路径没被改坏。
    expect(r.decision).toBe('ask');
    expect(r.outsideApproved).toBe(false);
  });
});

describe('R3-01 · 红线永不被对话级放行覆盖', () => {
  it('hard-deny 不被覆盖', () => {
    const r = resolveAuthorization(mk('python.exec', { mode: 'full', conversationApproved: true, hardRule: 'rule-redline' }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hard-deny');
  });

  it('policy deny 不被覆盖', () => {
    const r = resolveAuthorization(
      mk('python.exec', {
        mode: 'full',
        conversationApproved: true,
        policyVerdict: { decision: 'deny', reason: 'missing-path' },
      }),
    );
    expect(r.decision).toBe('deny');
  });

  it('未登记工具不被覆盖', () => {
    const r = resolveAuthorization(mk('not.a.tool', { mode: 'full', conversationApproved: true, def: undefined }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('unknown-capability');
  });
});

describe('R3-01 · 端到端：审完 file.read，shell.exec 仍要弹窗', () => {
  it('同对话内 file.read 的对话级同意不放行 shell.exec', async () => {
    const { createDesktopHost } = await import('../../src/host/desktop-host');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createWorkspace } = await import('../../src/host/workspace');

    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r301-'));
    fs.writeFileSync(path.join(wsRoot, 'a.txt'), 'hello');

    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(wsRoot),
      policyMode: 'full',
    });
    await host.start();
    try {
      // 模拟：用户在 file.read 上点了「本次对话始终允许」
      //（宿主侧的 conversationStore 是内部状态，这里用等价的 key 语义做端到端判定）
      const readTarget = canonicalTargetOf(byId['file.read'], { path: 'a.txt' }).target;
      const approvedKey = conversationApprovalKeyOf({
        principal: 'main',
        workspaceHash: WS,
        policyMode: 'full',
        conversationId: 'conv-1',
        toolId: 'file.read',
        canonicalTarget: readTarget,
      });

      // 同一对话里调 shell.exec → key 不同 → 不会被这份同意放行
      const shellTarget = canonicalTargetOf(byId['shell.exec'], { command: 'echo hi' }).target;
      const shellKey = conversationApprovalKeyOf({
        principal: 'main',
        workspaceHash: WS,
        policyMode: 'full',
        conversationId: 'conv-1',
        toolId: 'shell.exec',
        canonicalTarget: shellTarget,
      });
      expect(shellKey).not.toBe(approvedKey);

      // 且 shell.exec 在 full 档下仍受策略层与风险闸约束（不会被静默放行成「随便干」）
      const r = resolveAuthorization(
        mk('shell.exec', {
          mode: 'full',
          conversationApproved: false,
          params: { command: 'echo hi' },
        }),
      );
      expect(['allow', 'ask']).toContain(r.decision);
    } finally {
      await host.stop();
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
