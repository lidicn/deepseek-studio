// @vitest-environment node
/**
 * A2 统一授权解析器测试（交接单_20261026 §5.4）。
 *
 * 这里是纯函数穷举：把 §1.5 的授权顺序逐条钉死，特别是
 * 「full 放行所有已登记工具，但不能覆盖 hard-deny / policy deny」
 * 「grant 不能跨目标复用」「越界目标不吃 grant」这些容易被写反的地方。
 */

import { describe, it, expect } from 'vitest';
import {
  allowedGrantScopesFor,
  canonicalTargetOf,
  grantKeyOf,
  normalizePath,
  resolveAuthorization,
  type AuthorizationInput,
} from '../../src/host/authorization';
import { DEFAULT_TOOL_DEFINITIONS } from '../../src/host/tool-definitions';
import type { ToolDefinition } from '../../src/host/tool-registry';
import type { PolicyVerdict } from '../../src/host/policy';

const byId: Record<string, ToolDefinition> = Object.fromEntries(
  DEFAULT_TOOL_DEFINITIONS.map((d) => [d.id, d]),
);

const WS_HASH = 'wsabc123def4';
const NOW = 1_000_000;

function verdict(decision: PolicyVerdict['decision'], reason: PolicyVerdict['reason'] = 'inside-workspace'): PolicyVerdict {
  return { decision, reason };
}

function mk(over: Partial<AuthorizationInput> & { tool: string }): AuthorizationInput {
  return {
    params: {},
    mode: 'auto',
    policyVerdict: null,
    workspaceHash: WS_HASH,
    principal: 'main',
    now: NOW,
    // 默认取注册表里的真实定义；用例里想传"漏标 / 未登记"的定义时显式覆盖。
    def: byId[over.tool],
    ...over,
  };
}

function key(tool: string, target: string, cls = byId[tool].approvalClass): string {
  return grantKeyOf({
    principal: 'main',
    workspaceHash: WS_HASH,
    toolId: tool,
    approvalClass: cls,
    canonicalTarget: target,
  });
}

describe('A2 · 规范目标与 grant key', () => {
  it('path 类：分隔符 / 大小写 / 尾斜杠归一，同一路径得到同一 target', () => {
    const a = canonicalTargetOf(byId['file.write'], { path: 'C:\\\\proj\\\\a.txt\\\\' }).target;
    const b = canonicalTargetOf(byId['file.write'], { path: 'C:/proj/a.txt' }).target;
    expect(a).toBe(b);
    expect(a).toBe('c:/proj/a.txt');
  });

  it('argv 类：command 与 argv 归成同一目标，cwd 参与目标', () => {
    const cmd = canonicalTargetOf(byId['shell.exec'], { command: 'npm test' }).target;
    const argv = canonicalTargetOf(byId['shell.exec'], { argv: ['npm', 'test'] }).target;
    expect(cmd).toBe('npm test');
    expect(argv).toBe('npm test');
    const withCwd = canonicalTargetOf(byId['shell.exec'], { argv: ['npm', 'test'], cwd: 'C:\\\\other' }).target;
    expect(withCwd).not.toBe(cmd);
  });

  it('memory-id 类只取 id；chat-action 只取工具名，正文绝不进目标', () => {
    expect(canonicalTargetOf(byId['memory.delete'], { id: 'mem-1', reason: '很长的隐私正文' }).target).toBe('mem-1');
    const chat = canonicalTargetOf(byId['chat-send'], { text: '机密要发送的内容' });
    expect(chat.target).toBe('chat-send');
    expect(chat.target).not.toContain('机密');
  });

  it('grant key 含 principal / workspaceHash / toolId / approvalClass / 目标，任一变化即换 key', () => {
    const base = key('file.write', 'c:/proj/a.txt');
    expect(base).toBe(key('file.write', normalizePath('C:\\\\proj\\\\a.txt')));
    expect(base).not.toBe(key('file.write', 'c:/proj/b.txt'));
    expect(base).not.toBe(
      grantKeyOf({ principal: 'bot-b', workspaceHash: WS_HASH, toolId: 'file.write', approvalClass: 'mode', canonicalTarget: 'c:/proj/a.txt' }),
    );
    expect(base).not.toBe(
      grantKeyOf({ principal: 'main', workspaceHash: 'otherhash', toolId: 'file.write', approvalClass: 'mode', canonicalTarget: 'c:/proj/a.txt' }),
    );
  });

  it('normalizePath 不猜测相对路径的绝对性', () => {
    expect(normalizePath('src/a.ts')).toBe('src/a.ts');
    expect(normalizePath('C:/x//y/')).toBe('c:/x/y');
  });
});

describe('A2 · full 档不再无条件放行 always 类', () => {
  it('full + file.write → allow（且工作区内）', () => {
    const r = resolveAuthorization(mk({ tool: 'file.write', mode: 'full', policyVerdict: verdict('allow'), params: { path: 'C:/proj/a.txt' } }));
    expect(r.decision).toBe('allow');
    expect(r.approvalClass).toBe('mode');
    expect(r.outsideApproved).toBe(false);
  });

  it('full + file.list 越界 → allow 且 outsideApproved=true（沿用既有越界放行语义）', () => {
    const r = resolveAuthorization(mk({ tool: 'file.list', mode: 'full', policyVerdict: verdict('allow', 'outside-workspace'), params: { path: 'C:/other' } }));
    expect(r.decision).toBe('allow');
    expect(r.outsideApproved).toBe(true);
  });

  it('full + python.exec / mcp.call / policy.set / workspace.set / memory.delete / chat-send → allow（2026-11-08 卡 H：完全放开不再弹窗）', () => {
    for (const tool of ['python.exec', 'mcp.call', 'policy.set', 'workspace.set', 'memory.delete', 'chat-send']) {
      const r = resolveAuthorization(mk({ tool, mode: 'full', params: { id: 'mem-1', mode: 'full', root: 'C:\\\\other', text: 'x' } }));
      expect(r.decision, `${tool} 在 full 下不该再询问`).toBe('allow');
      expect(r.reason, tool).toBe('full-mode-allow');
      expect(r.approvalClass, tool).toBe('always');
      // full 档的 allow 不等于"可以静默跨工作区"：outsideApproved 恒 false
      expect(r.outsideApproved, tool).toBe(false);
    }
  });

  it('full + memory.purge → 仍 ask（显式例外：彻底删除不可恢复）', () => {
    const r = resolveAuthorization(mk({ tool: 'memory.purge', mode: 'full', params: { id: 'mem-1' } }));
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe('requires-approval');
  });

  it('full + always 类但越界 → 仍 ask（§1.4 硬规则 5：越界逐次确认，full 不豁免）', () => {
    const r = resolveAuthorization(
      mk({ tool: 'memory.delete', mode: 'full', policyVerdict: verdict('allow', 'outside-workspace'), params: { id: 'mem-1' } }),
    );
    expect(r.decision).toBe('ask');
  });

  it('full + hard-deny → 仍 deny（拒绝不是询问，"不弹窗"不许把拒绝变放行）', () => {
    const r = resolveAuthorization(mk({ tool: 'python.exec', mode: 'full', hardRule: 'disk-format', params: {} }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hard-deny');
  });

  it('full + always 类 + 对话级放行 ⇒ allow，但 reason 是 full-mode-allow（不再来自对话级放行）', () => {
    // K2（2026-11-09）：地板门（`cls === 'mode'`）生效后，always 类**在第 5 步就被跳过**，
    // 照常走进第 6 步 6b（full × always × 非越界 × 非 purge ⇒ allow）。
    // ⚠️ 所以这里**不能**翻成 ask —— 那等于推翻出资人 11-08「完全放开不弹窗」的拍板。
    // 变的只有 reason：不再是 'conversation-approved'，而是 'full-mode-allow'。
    for (const tool of ['python.exec', 'mcp.call', 'policy.set', 'workspace.set', 'memory.delete', 'chat-send']) {
      const r = resolveAuthorization(
        mk({ tool, mode: 'full', conversationApproved: true, params: { id: 'mem-1', mode: 'full', root: 'C:\\\\other', text: 'x' } }),
      );
      expect(r.decision, `${tool} full 档仍应免审`).toBe('allow');
      expect(r.reason, `${tool} 这一发来自 full 档免审，不是对话级放行`).toBe('full-mode-allow');
    }
  });

  it('对话级放行不覆盖 hard-deny / unknown（红线不受影响）', () => {
    const hard = resolveAuthorization(
      mk({ tool: 'shell.exec', mode: 'full', conversationApproved: true, policyVerdict: verdict('allow', 'risk-detected'), hardRule: 'dangerous-disk', params: { command: 'format c:' } }),
    );
    expect(hard.decision).toBe('deny');
    expect(hard.reason).toBe('hard-deny');
    const unknown = resolveAuthorization(mk({ tool: 'not.registered', mode: 'full', conversationApproved: true }));
    expect(unknown.decision).toBe('deny');
    expect(unknown.reason).toBe('unknown-capability');
  });

  it('full + shell.exec 命中硬规则 → deny，且带 hardRule', () => {
    const r = resolveAuthorization(
      mk({ tool: 'shell.exec', mode: 'full', policyVerdict: verdict('allow', 'risk-detected'), hardRule: 'dangerous-disk', params: { command: 'format c:' } }),
    );
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('hard-deny');
    expect(r.hardRule).toBe('dangerous-disk');
  });

  it('hard-deny 优先于有效 grant：即使有 session/temporary grant 也拒', () => {
    const k = key('shell.exec', 'rm -rf c:/');
    const r = resolveAuthorization(
      mk({
        tool: 'shell.exec',
        mode: 'auto',
        policyVerdict: verdict('require-consent', 'risk-detected'),
        hardRule: 'recursive-root-delete',
        grant: { scope: 'session', key: k },
        params: { command: 'rm -rf c:/' },
      }),
    );
    expect(r.decision).toBe('deny');
    expect(r.hardRule).toBe('recursive-root-delete');
  });

  it('工作区未配置（policy deny）优先于 full：file.read → deny', () => {
    const r = resolveAuthorization(mk({ tool: 'file.read', mode: 'full', policyVerdict: verdict('deny', 'workspace-unconfigured'), params: { path: 'C:/x' } }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('workspace-unconfigured');
  });
});

describe('A2 · workspace / auto 档既有语义不回归', () => {
  it('workspace + file.* 区内 → allow；区外 → deny(mode-restricted)', () => {
    const inside = resolveAuthorization(mk({ tool: 'file.read', mode: 'workspace', policyVerdict: verdict('allow', 'inside-workspace'), params: { path: 'C:/proj/a' } }));
    expect(inside.decision).toBe('allow');
    const outside = resolveAuthorization(mk({ tool: 'file.write', mode: 'workspace', policyVerdict: verdict('deny', 'mode-restricted'), params: { path: 'C:/other' } }));
    expect(outside.decision).toBe('deny');
    expect(outside.reason).toBe('mode-restricted');
  });

  it('workspace + python.exec → deny（QD-R2-16 承诺由 policy 层给出，解析器透传）', () => {
    const r = resolveAuthorization(mk({ tool: 'python.exec', mode: 'workspace', policyVerdict: verdict('deny', 'mode-restricted'), params: {} }));
    expect(r.decision).toBe('deny');
  });

  it('auto + shell 命中风险 → ask；无风险 → allow', () => {
    const risky = resolveAuthorization(mk({ tool: 'shell.exec', mode: 'auto', policyVerdict: verdict('require-consent', 'risk-detected'), params: { command: 'rm -rf C:/tmp/x' } }));
    expect(risky.decision).toBe('ask');
    const plain = resolveAuthorization(mk({ tool: 'shell.exec', mode: 'auto', policyVerdict: verdict('allow', 'inside-workspace'), params: { command: 'node --version' } }));
    expect(plain.decision).toBe('allow');
  });

  it('ask 档 + shell 常规命令 → ask(requires-approval)，不被记成越界', () => {
    const r = resolveAuthorization(mk({ tool: 'shell.exec', mode: 'ask', policyVerdict: verdict('require-consent', 'requires-approval'), params: { command: 'npm test' } }));
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe('requires-approval');
    expect(r.outsideApproved).toBe(false);
  });

  it('none 类工具自动放行（skill.list / settings.get）', () => {
    // R2-07：memory.save 已提为 mode（记忆库跨会话回灌 ⇒ 零审批不可接受），
    // 故不在本组；它现在归「mode 类在 workspace 档要问」那条。
    for (const tool of ['skill.list', 'settings.get', 'chat-read']) {
      const r = resolveAuthorization(mk({ tool, mode: 'workspace' }));
      expect(r.decision, tool).toBe('allow');
      expect(r.approvalClass, tool).toBe('none');
    }
  });

  /**
   * R2-07 配套：`memory.save` 是**全表唯一「非 governed 的 mode 工具」**。
   * 它没有 policyVerdict，若不特判就会连 full 档也弹窗 —— 与「full 完全放开不会弹窗」
   * （2026-11-08 卡 H）冲突。三条断言把边界钉死：full 放行、workspace 仍问、
   * 越界即使 full 也要问（§1.4 硬规则 5 不得被本条绕过）。
   */
  it('R2-07 memory.save 档位语义：full 放行 / workspace 要问 / 越界 full 也要问', () => {
    const full = resolveAuthorization(mk({ tool: 'memory.save', mode: 'full', params: { name: 'x' } }));
    expect(full.decision).toBe('allow');
    expect(full.reason).toBe('full-mode-allow');

    const ws = resolveAuthorization(mk({ tool: 'memory.save', mode: 'workspace', params: { name: 'x' } }));
    expect(ws.decision).toBe('ask');

    // 负控（守 `!policyVerdict` 那道门）：governed 的 mode 工具在 full 档**不得**被本条放行。
    // 策略层 deny 仍然生效 —— 否则这条就是「full 绕过策略拒绝」的后门。
    const denied = resolveAuthorization(
      mk({ tool: 'shell.exec', mode: 'full', policyVerdict: verdict('deny', 'missing-command'), params: { command: '' } }),
    );
    expect(denied.decision).toBe('deny');
  });
});

describe('A2 · grant 只能精确命中同一目标', () => {
  it('mode 类：同 path 的 session grant 命中；换 path 不命中', () => {
    const a = canonicalTargetOf(byId['file.write'], { path: 'C:/proj/a.txt' }).target;
    const hit = resolveAuthorization(
      mk({ tool: 'file.write', mode: 'auto', policyVerdict: verdict('require-consent', 'outside-workspace'), grant: { scope: 'session', key: key('file.write', a) }, params: { path: 'C:/proj/a.txt' } }),
    );
    // 上面故意用 outside-workspace：越界不吃 grant
    expect(hit.decision).toBe('ask');
    const inside = resolveAuthorization(
      mk({ tool: 'file.write', mode: 'auto', policyVerdict: verdict('require-consent', 'risk-detected'), grant: { scope: 'session', key: key('file.write', a) }, params: { path: 'C:/proj/a.txt' } }),
    );
    expect(inside.decision).toBe('allow');
    expect(inside.reason).toBe('session-grant');
    expect(inside.grantScope).toBe('session');

    const other = resolveAuthorization(
      mk({ tool: 'file.write', mode: 'auto', policyVerdict: verdict('require-consent', 'risk-detected'), grant: { scope: 'session', key: key('file.write', a) }, params: { path: 'C:/proj/b.txt' } }),
    );
    expect(other.decision).toBe('ask');
  });

  it('过期 grant 不生效', () => {
    const t = 'C:/proj/a.txt';
    const k = key('file.write', canonicalTargetOf(byId['file.write'], { path: t }).target);
    const r = resolveAuthorization(
      mk({ tool: 'file.write', mode: 'auto', policyVerdict: verdict('require-consent', 'risk-detected'), grant: { scope: 'temporary', key: k, expiresAt: NOW - 1 }, params: { path: t } }),
    );
    expect(r.decision).toBe('ask');
  });

  it('always 类：session grant 无效，只有精确 temporary / internal preauth 能替代询问', () => {
    const t = canonicalTargetOf(byId['memory.delete'], { id: 'mem-1' }).target;
    const k = key('memory.delete', t);
    const asSession = resolveAuthorization(mk({ tool: 'memory.delete', mode: 'auto', grant: { scope: 'session', key: k }, params: { id: 'mem-1' } }));
    expect(asSession.decision).toBe('ask');
    const asTemporary = resolveAuthorization(mk({ tool: 'memory.delete', mode: 'auto', grant: { scope: 'temporary', key: k, expiresAt: NOW + 60_000 }, params: { id: 'mem-1' } }));
    expect(asTemporary.decision).toBe('allow');
    expect(asTemporary.reason).toBe('temporary-grant');
    const asExpired = resolveAuthorization(mk({ tool: 'memory.delete', mode: 'auto', grant: { scope: 'temporary', key: k, expiresAt: NOW - 1 }, params: { id: 'mem-1' } }));
    expect(asExpired.decision).toBe('ask');
    const internal = resolveAuthorization(mk({ tool: 'memory.delete', mode: 'auto', grant: { scope: 'session', key: k, source: 'internal-bot' }, params: { id: 'mem-1' } }));
    expect(internal.decision).toBe('ask');
  });

  it('chat-insert / chat-send 的 internal preauth 放行并标 internal-preauth（审计与用户授权分开）', () => {
    for (const tool of ['chat-insert', 'chat-send']) {
      const t = canonicalTargetOf(byId[tool], { text: 'x' }).target;
      const r = resolveAuthorization(mk({ tool, mode: 'auto', grant: { scope: 'session', key: key(tool, t), source: 'internal-bot' }, params: { text: 'x' } }));
      expect(r.decision, tool).toBe('allow');
      expect(r.reason, tool).toBe('internal-preauth');
    }
  });

  it('always 类的 temporary 不吃越界标记外的 grant：principal 变了就不命中', () => {
    const t = canonicalTargetOf(byId['memory.purge'], { id: 'mem-9' }).target;
    const other = grantKeyOf({ principal: 'bot-b', workspaceHash: WS_HASH, toolId: 'memory.purge', approvalClass: 'always', canonicalTarget: t });
    const r = resolveAuthorization(mk({ tool: 'memory.purge', mode: 'auto', grant: { scope: 'temporary', key: other, expiresAt: NOW + 60_000 }, params: { id: 'mem-9' } }));
    expect(r.decision).toBe('ask');
  });

  it('project 规则只替 mode 类免审，不影响 always', () => {
    const modeAsk = resolveAuthorization(mk({ tool: 'shell.exec', mode: 'auto', policyVerdict: verdict('require-consent', 'risk-detected'), projectRuleHit: true, params: { command: 'rm -rf C:/tmp/x' } }));
    expect(modeAsk.decision).toBe('allow');
    expect(modeAsk.reason).toBe('project-rule');
    const always = resolveAuthorization(mk({ tool: 'python.exec', mode: 'auto', projectRuleHit: true }));
    expect(always.decision).toBe('ask');
  });
});

describe('A2 · fail-closed 兜底', () => {
  it('未登记工具 → deny(unknown-capability)', () => {
    const r = resolveAuthorization(mk({ tool: 'ghost.tool', def: undefined as unknown as ToolDefinition }));
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('unknown-capability');
  });

  it('漏标 approvalClass 的定义 → 仍落 always；auto 询问，full 按卡 H 放行（对话级放行仍可覆盖 auto）', () => {
    const legacy = { id: 'legacy', title: 't', description: 'd', risk: 'privileged', allowedOrigins: ['*'] } as unknown as ToolDefinition;
    const auto = resolveAuthorization(mk({ tool: 'legacy', def: legacy, mode: 'auto' }));
    expect(auto.approvalClass).toBe('always');
    expect(auto.decision).toBe('ask');
    // 2026-11-08 卡 H：full 档下 always 类不再询问（fail-closed 的"落 always"语义不变，
    // 变的是 full 档对 always 的处理：allow + reason=full-mode-allow）。
    const full = resolveAuthorization(mk({ tool: 'legacy', def: legacy, mode: 'full' }));
    expect(full.approvalClass).toBe('always');
    expect(full.decision).toBe('allow');
    expect(full.reason).toBe('full-mode-allow');
    const granted = resolveAuthorization(mk({ tool: 'legacy', def: legacy, mode: 'full', conversationApproved: true }));
    expect(granted.decision).toBe('allow');
    // K2：always 类走不进第 5 步（地板门），这一发是 full 档免审给的，不是对话级放行。
    expect(granted.reason).toBe('full-mode-allow');
  });

  it('mode 类但策略层没给结论 → ask(policy-unresolved)', () => {
    const r = resolveAuthorization(mk({ tool: 'shell.exec', mode: 'auto', policyVerdict: null, params: { command: 'ls' } }));
    expect(r.decision).toBe('ask');
    expect(r.reason).toBe('policy-unresolved');
  });

  it('缺参数（missing-path / missing-command）→ deny', () => {
    const p = resolveAuthorization(mk({ tool: 'file.write', mode: 'full', policyVerdict: verdict('deny', 'missing-path') }));
    expect(p.decision).toBe('deny');
    expect(p.reason).toBe('missing-path');
    const c = resolveAuthorization(mk({ tool: 'shell.exec', mode: 'full', policyVerdict: verdict('deny', 'missing-command') }));
    expect(c.reason).toBe('missing-command');
  });

  it('allowedGrantScopes：always 只剩 once/temporary；mode 含 session', () => {
    expect(allowedGrantScopesFor(byId['memory.delete'])).toEqual(['once', 'temporary']);
    expect(allowedGrantScopesFor(byId['policy.set'])).toEqual(['once']);
    expect(allowedGrantScopesFor(byId['file.write'])).toContain('session');
    // R2-07：memory.save 已从 none 提为 mode ⇒ 可发 session（无 session 就无法「同目标二次不问」）。
    expect(allowedGrantScopesFor(byId['memory.save'])).toEqual(['once', 'session']);
  });
});
