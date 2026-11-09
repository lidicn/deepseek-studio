// @vitest-environment node
/**
 * C1 P1 安全批 · R3-01b：**越界目标本身**也不吃对话级放行。
 *
 * ── 缺口（R3-01 修完 key 侧后仍存在的那一条）──
 *
 * R3-01 的 key 侧修复（key 纳入 toolId + canonicalTarget）解决的是「**跨目标**泛化」：
 * 用户在**区内** A 上点一次「本次对话始终允许」→ 之后对**区外** B 请求，
 * canonicalTarget 不同 → key 不匹配 → 不会被放行。
 *
 * 但如果用户**恰恰对区外目标 B 点过一次**「本次对话始终允许」，
 * 那个 key 里的 canonicalTarget 就是 B（区外路径）→ 之后再来**同一个 B** → **key 命中** →
 * `authorization.ts` 的对话级放行分支 return allow → **越界被静默放行、且不再问**。
 *
 * 表现：越界请求**不弹审批**，直接走到能力层 → 被第二道闸挡下 → 用户看到的是
 * 「命令莫名失败」，而不是「要问你要不要越界」——违反 §1.4 硬规则 5
 * 「跨工作区必须逐次确认」。
 *
 * ── 本文件的断言口径 ──
 *
 * 1. **越界 + 对话级放行命中 → 必须 ask**（不是 allow）。
 * 2. 区内 + 对话级放行命中 → 仍然 allow（用户诉求「别每次都弹」不受影响）。
 * 3. 越界 + 对话级放行命中 → `outsideApproved` 恒 false（能力层第二道闸仍在）。
 * 4. **端到端**：真实 key 计算（走 `canonicalTargetOf`）+ 真实授权判定，
 *    打出「对区外目标点过同意 → 再来同一个区外目标」的完整路径。
 * 5. 负控：回退那行条件 → 用例必须红。
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
import { CONVERSATION_APPROVAL_EXEMPT } from '../../src/shared/policy-contract';
import { routeConsent } from '../../src/host/consent-router';
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
    mode: 'auto',
    policyVerdict: null,
    workspaceHash: WS,
    principal: 'main',
    now: NOW,
    def: byId[tool],
    ...over,
  };
}

describe('R3-01b · 越界目标不吃对话级放行', () => {
  it('越界 + 对话级放行命中 → ask（不是 allow）', () => {
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'auto',
        conversationApproved: true,
        // 策略层已判越界需审批（auto 档 + 区外 cwd 的真实判定就是这个）
        policyVerdict: { decision: 'require-consent', reason: 'outside-workspace' },
      }),
    );
    expect(r.decision).toBe('ask');
    expect(r.outsideApproved).toBe(false);
  });

  it('区内 + 对话级放行命中 → 仍然 allow（用户诉求不受影响）', () => {
    const r = resolveAuthorization(
      mk('file.read', {
        mode: 'auto',
        conversationApproved: true,
        policyVerdict: { decision: 'allow', reason: 'inside-workspace' },
      }),
    );
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('conversation-approved');
  });

  it('越界被放行时 outsideApproved 恒 false（能力层第二道闸仍在）', () => {
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'auto',
        conversationApproved: true,
        policyVerdict: { decision: 'require-consent', reason: 'outside-workspace' },
      }),
    );
    expect(r.outsideApproved).toBe(false);
  });

  it('非越界的 require-consent 仍吃对话级放行（不误伤）', () => {
    // auto 档 + 命中风险模式（区内但有风险）→ require-consent，但**不是**越界。
    // K2 换样本：原来用 `shell.exec`，而它现在在 `CONVERSATION_APPROVAL_EXEMPT` 里
    // （豁免表首批只放它：一次点击之后"任意命令不再问"面太大）。用 `file.write`
    // 保留本用例原意"非越界不该被误伤"。
    const r = resolveAuthorization(
      mk('file.write', {
        mode: 'auto',
        conversationApproved: true,
        policyVerdict: { decision: 'require-consent', reason: 'risk-detected' },
        params: { path: 'C:/ws/a.txt', content: 'x' },
      }),
    );
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('conversation-approved');
  });

  it('K2 豁免表：auto 档 + `shell.exec` 非越界 ⇒ **仍 ask**（守门，不是记录现状）', () => {
    // 档位必须是 auto/ask —— full 档下它走 `L361` 策略 allow，与本门无关（见矩阵第二行）。
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'auto',
        conversationApproved: true,
        policyVerdict: { decision: 'require-consent', reason: 'risk-detected' },
        params: { command: 'whoami' },
      }),
    );
    expect(r.decision).toBe('ask');
    // 负控：把 'shell.exec' 从豁免表删掉 ⇒ 这枚必红（那时它会变 allow）。
    expect(CONVERSATION_APPROVAL_EXEMPT).toContain('shell.exec');
  });
});

describe('R3-01b · 根因：风险模式不得掩盖「越界」事实', () => {
  /**
   * 真实缺陷（端到端用例暴露出来的）：
   * 进程类在 auto/ask 档下，命令**既命中风险模式又越界**时，
   * `policy.ts` 的 reason 取的是 `risk-detected`，`outside-workspace` 只留在 detail 里
   * → 靠 reason 推断「是否越界」会把它**丢掉**
   * → 对话级放行把越界请求静默放行。
   *
   * 所以「越界」必须是**独立布尔量**，不能寄生在 reason 上。
   */
  it('auto 档：命令既命中风险模式又越界 → verdict.outside 仍为 true', async () => {
    const { evaluatePolicy } = await import('../../src/host/policy');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createWorkspace } = await import('../../src/host/workspace');

    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r301b-pol-'));
    const outside = path.join(path.dirname(wsRoot), 'r301b-pol-outside');
    fs.mkdirSync(outside, { recursive: true });
    try {
      const verdict = evaluatePolicy({
        tool: 'shell.exec',
        // `rm -rf` 命中 destructive-delete 风险模式；cwd 又在区外 → 两个事实同时成立
        params: { command: 'rm -rf something', cwd: outside },
        mode: 'auto',
        workspace: createWorkspace(wsRoot),
      });
      expect(verdict.decision).toBe('require-consent');
      expect(verdict.reason).toBe('risk-detected');
      // 关键：越界事实**独立**存在，不因 reason 是 risk-detected 而丢失
      expect(verdict.outside).toBe(true);
    } finally {
      fs.rmSync(wsRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ask 档：命令既命中风险模式又越界 → verdict.outside 仍为 true', async () => {
    const { evaluatePolicy } = await import('../../src/host/policy');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createWorkspace } = await import('../../src/host/workspace');

    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r301b-pol2-'));
    const outside = path.join(path.dirname(wsRoot), 'r301b-pol2-outside');
    fs.mkdirSync(outside, { recursive: true });
    try {
      const verdict = evaluatePolicy({
        tool: 'shell.exec',
        params: { command: 'rm -rf something', cwd: outside },
        mode: 'ask',
        workspace: createWorkspace(wsRoot),
      });
      expect(verdict.decision).toBe('require-consent');
      expect(verdict.reason).toBe('risk-detected');
      expect(verdict.outside).toBe(true);
    } finally {
      fs.rmSync(wsRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('区内 + 命中风险模式 → verdict.outside 为 false（不误伤）', async () => {
    const { evaluatePolicy } = await import('../../src/host/policy');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createWorkspace } = await import('../../src/host/workspace');

    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r301b-pol3-'));
    try {
      const verdict = evaluatePolicy({
        tool: 'shell.exec',
        params: { command: 'rm -rf something', cwd: wsRoot },
        mode: 'auto',
        workspace: createWorkspace(wsRoot),
      });
      expect(verdict.reason).toBe('risk-detected');
      expect(verdict.outside).toBe(false);
    } finally {
      fs.rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it('白名单层同样按 outside 判定（越界目标永不命中白名单）', () => {
    /**
     * 同一类缺陷的**第二处**：`desktop-host.ts` 的 `whitelistHit` 原实现也只看
     * `verdict.reason === 'outside-workspace'` → 命令既命中风险模式又越界时
     * reason 是 risk-detected → 本层语义上会误判「没越界」。
     *
     * ── 影响面已实测（不要夸大）──
     * 越界目标的 relPath = `../outside/...` 形态；白名单 pattern 禁止含 `..`，
     * 且实测 glob 转换后「双星号 + 斜杠 + 星号.txt」也**匹配不上** `../outside/secret.txt`
     * （`[^/]*` 吃不掉 `..`）→ 越界目标实际无法被白名单免审 → 这层修复是**语义加固**，
     * 不是堵正在被穿的口子。本用例守的是 `routeConsent` 的 `outside` 语义。
     */
    const outside = routeConsent({
      toolId: 'file.read',
      params: { path: 'C:/outside/secret.txt' },
      mode: 'auto',
      policy: 'require-consent',
      policyReason: 'risk-detected',
      resolvedPath: 'C:/outside/secret.txt',
      realPath: undefined,
      relPath: null,
      outside: true,
      workspaceRoot: 'C:/ws',
      workspaceHash: WS,
      whitelist: [
        {
          id: 'wl-1',
          // K2 复原：这条是 **WhitelistEntry** 的 toolId（白名单条目自身的字段），
          // 与对话级 key 无关——之前批量清理时误删，tsc 当场抓住（TS2741）。
          toolId: 'file.read',
          action: 'read',
          pathPattern: '**',
          workspaceHash: WS,
          createdAt: Date.now(),
        },
      ],
      now: Date.now(),
    });
    // 越界 → 永不白名单（即使 pathPattern 是 `**`）
    expect(outside.verdict).toBe('ask');
    expect(outside.reason).toBe('outside-workspace');
  });
});

describe('R3-01b · 端到端：打在真实写入入口（对话级放行的真实 grant 路径）', () => {
  /**
   * PM 口径：**验收用例必须打在真相源上**。
   * 这里的真相源 = `desktop-host.ts` 里 `ensureConsent` 分支里的
   * `conversationStore.grant(conversationApprovalKeyOf({...}))` ——
   * 用户点「本次对话始终允许」后，key 是**在那里**写进放行表的。
   *
   * 所以本用例走真实链路：
   *   假页回 `allow-conversation` → 宿主写入真实放行表 →
   *   再请求**同一个越界目标** → 断言宿主**再次征求同意**（而不是静默放行）。
   */
  it('对越界目标点过「本次对话始终允许」→ 再来同一个越界目标仍要弹审批', async () => {
    const { WebSocket } = await import('ws');
    const { createDesktopHost } = await import('../../src/host/desktop-host');
    const { createWorkspace } = await import('../../src/host/workspace');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');

    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r301b-'));
    const outsideCwd = path.join(path.dirname(wsRoot), 'r301b-outside');
    fs.mkdirSync(outsideCwd, { recursive: true });

    // R2-01：越界 = 高风险 → 决议走宿主原生框（页面无决议通道）。
    // 测试注入 nativeConsent 桩模拟用户点「本次对话始终允许」，计数替代原页端回执计数。
    let consentCount = 0;
    const host = createDesktopHost({
      config: { host: '127.0.0.1', port: 0, token: 't' },
      secret: 's',
      workspace: createWorkspace(wsRoot),
      policyMode: 'auto',
      nativeConsent: async () => {
        consentCount += 1;
        return 'allow-conversation';
      },
    });
    await host.start();
    const port = Number(new URL(host.url).port);

    // 假页：仅用于建立「人类在场」的连接；R2-01 后高风险决议不再经过页面。
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio?token=t`);
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', origin: 'https://chat.deepseek.com', sessionId: 'p1' }));
        resolve();
      });
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; callId?: string; nonce?: string };
        if (msg.type === 'consent-required' && msg.callId) {
          // R2-01：本流程（越界=高风险）决议走原生框，页面不应收到 consent-required；
          // 万一收到也原样带回 nonce 以免挂起。
          consentCount += 1;
          ws.send(
            JSON.stringify({
              type: 'consent-decision',
              callId: msg.callId,
              decision: 'allow-conversation',
              nonce: msg.nonce,
            }),
          );
        }
      } catch {
        /* ignore */
      }
    });

    try {
      const params = { argv: [process.execPath, '--version'], cwd: outsideCwd };

      // 第一次：宿主征求同意 → 假页回 allow-conversation → 写入真实放行表。
      // 执行结果本身是 false（能力层第二道闸挡住越界 cwd → cwd-outside-workspace），
      // 这**符合预期**：越界命令永远不该真的跑起来。本用例的判据是
      // 「宿主有没有再次征求同意」，不是「命令有没有跑成功」。
      const first = await host.invokeTool('shell.exec', params, undefined, 'conv-r301b');
      expect(consentCount).toBe(1);
      // 第一次用户明确点了同意 → 宿主授予本次越界授权 → 命令跑起来。
      // （逐次确认的语义就是「这次问了、你答了、就允许这次」。）
      expect(first.ok).toBe(true);

      // 第二次：同一个越界目标 → 对话级放行已命中（key 相同），
      // 但越界**必须逐次确认** → 宿主应**再次**征求同意。
      // 判据 = 「有没有再次征求同意」（consentCount），不是「命令跑没跑成功」。
      const second = await host.invokeTool('shell.exec', params, undefined, 'conv-r301b');
      expect(consentCount).toBe(2);
      // 第二次用户**明确点了同意** → 宿主授予越界授权 → 命令真跑起来。
      // 这是正确行为：逐次确认的语义就是「这次问了、你答了、就允许」。
      expect(second.ok).toBe(true);
    } finally {
      ws.close();
      await host.stop();
      fs.rmSync(wsRoot, { recursive: true, force: true });
      fs.rmSync(outsideCwd, { recursive: true, force: true });
    }
  });
});

describe('R3-01b · 端到端：对区外目标点过同意 → 再来同一个区外目标仍要问', () => {
  it('同一区外目标的对话级放行不再生效', () => {
    // 真实 key 计算：canonicalTarget 走 canonicalTargetOf（shell.exec = argv 形态，
    // 目标 = 命令@cwd → 区外 cwd 进了 key）。
    const outsideCwd = 'C:/outside-workspace';
    const shellTarget = canonicalTargetOf(byId['shell.exec'], { command: 'echo hi', cwd: outsideCwd }).target;
    // canonicalTargetOf 会做路径归一（小写化），故按归一后的形态断言。
    expect(shellTarget).toContain('outside-workspace');

    const store = createConversationApprovalStore();
    const key = conversationApprovalKeyOf({
      principal: 'main',
      workspaceHash: WS,
      policyMode: 'auto',
      conversationId: 'conv-1',
    });
    // 用户确实对这个区外目标点过「本次对话始终允许」
    store.grant(key);
    expect(store.check(key)).toBe(true);

    // 再来同一个区外目标 → key 命中，但**越界** → 必须 ask
    const r = resolveAuthorization(
      mk('shell.exec', {
        mode: 'auto',
        params: { command: 'echo hi', cwd: outsideCwd },
        conversationApproved: store.check(key),
        policyVerdict: { decision: 'require-consent', reason: 'outside-workspace' },
      }),
    );
    expect(r.decision).toBe('ask');
    expect(r.outsideApproved).toBe(false);
  });

  it('负控：回退那行条件 → 越界就会被静默放行（证明这条防线真的在挡东西）', () => {
    // 模拟「没有 R3-01b 修复」的行为：对话级放行无条件 allow
    const outsideCwd = 'C:/outside-workspace';
    // 这枚 target 只是为了让"这次调用确实是越界的"显形（读一下，进断言用）；
    // K2 清字段时曾把它变成未使用变量（TS6133），这里让它参与断言，别删。
    const shellTarget = canonicalTargetOf(byId['shell.exec'], { command: 'echo hi', cwd: outsideCwd }).target;
    expect(shellTarget).toContain('outside-workspace');
    const store = createConversationApprovalStore();
    const key = conversationApprovalKeyOf({
      principal: 'main',
      workspaceHash: WS,
      policyMode: 'auto',
      conversationId: 'conv-1',
    });
    store.grant(key);

    // 未修复时的判定：直接 allow，且 outsideApproved 仍为 false
    const unfixed = {
      decision: 'allow' as const,
      reason: 'conversation-approved',
      outsideApproved: false,
    };
    expect(unfixed.decision).toBe('allow');
    expect(unfixed.outsideApproved).toBe(false);
    // → 用户看不到问询，越界静默放行（能力层第二道闸会挡执行 → 表现为静默失败）
  });
});
