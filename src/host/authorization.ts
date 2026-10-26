/**
 * 统一授权解析器（A2 · 交接单_20261026 §5）
 *
 * 把原先散在 desktop-host / policy.ts / consent-router 的三套判定收敛成**一个纯函数**，
 * 让每条工具调用走同一条授权顺序。它是"唯一真源"：desktop-host 不再同时维护
 * 「policy 分支」+「requiresHumanConsent」两套结论。
 *
 * 顺序固定（§1.5，不可调换）：
 *   1. 工具登记 / origin / 执行侧（未知即 fail-closed）
 *   2. hard-deny（磁盘、关机、盘根递归删除、敏感凭据路径）
 *   3. workspace / resource deny（未配置工作区、档位禁止、缺参数）
 *   4. 显式 deny 规则（A4 落地前留空位）
 *   5. always 类的新鲜人工确认（grant 只能消费精确 temporary）
 *   6. mode 类的有效 grant
 *   7. policyMode 对 mode 类的判定
 *   8. none 类放行
 *   9. 其余一律 fail-closed
 *
 * 纯函数纪律：不做 fs/env/realpath。工作区边界与风险模式由调用方（宿主）算好后
 * 以 `policyVerdict` 传入；hard 规则由 consent-router 的 `checkHardDeny` 结果传入。
 * 这样本文件可脱离真实磁盘做穷举测试。
 */

import { createHash } from 'node:crypto';
import {
  APPROVAL_CLASSES,
  type ApprovalClass,
  type CanonicalTargetKind,
  type GrantScope,
} from '../shared/consent-contract';
import type { PolicyMode } from '../shared/policy-contract';
import type { PolicyVerdict } from './policy';
import type { ToolDefinition } from './tool-registry';

export type AuthorizationDecisionKind = 'allow' | 'ask' | 'deny';

/** 授权结论（含审计需要回放的判定要素）。 */
export interface AuthorizationResult {
  readonly decision: AuthorizationDecisionKind;
  /** 稳定原因码，直接进审计 reason 字段（拒绝必须有原因，禁止空串）。 */
  readonly reason: string;
  readonly approvalClass: ApprovalClass;
  /** 规范目标摘要（路径 / argv / memory id / MCP server+tool…），不含敏感正文。 */
  readonly canonicalTarget?: string;
  readonly targetKind?: CanonicalTargetKind;
  /** 本次判定所依据的 grant key（A3 用它查放行表）。 */
  readonly grantKey?: string;
  /** 命中并生效的 grant 作用域（allow 且来自 grant 时才有值）。 */
  readonly grantScope?: GrantScope;
  /** 该工具在当前判定下允许发放的 grant 作用域（供 UI 决定按钮）。 */
  readonly allowedGrantScopes: readonly GrantScope[];
  /** 命中硬规则时记录规则 id。 */
  readonly hardRule?: string;
  /**
   * 是否已获准越出工作区。只有 mode 类且「策略直接放行」或「用户已批准」才为真；
   * always 类不因 full 档位被置真（§5.3 第 6 条）。
   */
  readonly outsideApproved: boolean;
}

/** 宿主已查到的 grant 命中信息。 */
export interface GrantMatch {
  readonly scope: GrantScope;
  readonly key: string;
  /** 仅 temporary 有值；缺省视为不过期（靠生命周期清理）。 */
  readonly expiresAt?: number;
  /** 授权来源：用户点击 vs bot 内部预授权。 */
  readonly source?: 'user' | 'internal-bot';
}

export interface AuthorizationInput {
  readonly tool: string;
  /** 注册表里的工具定义；undefined 表示未登记（fail-closed）。 */
  readonly def: ToolDefinition | undefined;
  readonly params: Readonly<Record<string, unknown>>;
  readonly mode: PolicyMode;
  /** 宿主用 evaluatePolicy 预算的策略结论；非受管辖工具传 null。 */
  readonly policyVerdict: PolicyVerdict | null;
  /** consent-router.checkHardDeny 的结果；null/undefined 表示未命中硬规则。 */
  readonly hardRule?: string | null;
  /** 会话/工作区级 grant 命中结果（宿主按 grantKey 查表后传入）。 */
  readonly grant?: GrantMatch | null;
  /** 用户持久规则（A4）命中结果；本版由调用方固定传 null。 */
  readonly projectRuleHit?: boolean;
  /** grant key 计算所需的身份。 */
  readonly workspaceHash: string;
  readonly principal: string;
  readonly now: number;
}

/** always 类允许的 grant：once，或高级流程下的精确 temporary；其余工具含 session。 */
export function allowedGrantScopesFor(def: ToolDefinition): readonly GrantScope[] {
  const declared = def.grantScopes ?? (['once'] as const);
  const cls = approvalClassOf(def);
  if (cls === 'always') {
    // §1.4 硬规则 4：always 不得发放 session / turn。
    return declared.filter((s) => s === 'once' || s === 'temporary');
  }
  if (cls === 'none') return ['once'];
  return declared;
}

/** 与 tool-registry 同口径的取值（缺/非法 → fail-closed 到 always）。 */
function approvalClassOf(def: Pick<ToolDefinition, 'approvalClass'> | undefined): ApprovalClass {
  const value = def?.approvalClass;
  return value && (APPROVAL_CLASSES as readonly string[]).includes(value) ? value : 'always';
}

/**
 * 计算"规范目标"：grant 绑定的动作对象。同工具不同参数不得复用授权，
 * 靠的就是这里把参数压成一个稳定、可比较、不含正文的字符串。
 */
export function canonicalTargetOf(
  def: ToolDefinition | undefined,
  params: Readonly<Record<string, unknown>>,
): { kind: CanonicalTargetKind; target: string } {
  const kind: CanonicalTargetKind = def?.canonicalTargetKind ?? 'generic';
  const str = (keys: readonly string[]): string => {
    for (const k of keys) {
      const v = params[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  switch (kind) {
    case 'path': {
      const p = str(['path', 'filePath', 'target']);
      return { kind, target: p ? normalizePath(p) : '' };
    }
    case 'argv': {
      // 命令文本优先取 command（人类可读），否则拼 argv；cwd 参与目标（换目录=换目标）。
      const cmd = str(['command', 'cmd']) || joinArgv(params);
      const cwd = normalizePath(str(['cwd', 'workdir']));
      return { kind, target: cwd ? `${cmd}@${cwd}` : cmd };
    }
    case 'memory-id':
      return { kind, target: str(['id', 'memoryId']) };
    case 'mcp-call': {
      const server = str(['server', 'serverName', 'name']);
      const toolName = str(['tool', 'toolName']);
      const nestedCmd = nestedCommand(params);
      return { kind, target: [server, toolName, nestedCmd].filter(Boolean).join('::') };
    }
    case 'policy-mode':
      return { kind, target: str(['mode']) };
    case 'workspace-root':
      return { kind, target: normalizePath(str(['root', 'path'])) };
    case 'chat-action':
      // 页侧动作没有"目标实体"，按动作本身收敛；正文绝不进 grant key。
      return { kind, target: def?.id ?? '' };
    default:
      return { kind: 'generic', target: def?.id ?? '' };
  }
}

function joinArgv(params: Readonly<Record<string, unknown>>): string {
  const argv = params.argv;
  if (Array.isArray(argv) && argv.every((a) => typeof a === 'string')) {
    return (argv as string[]).join(' ');
  }
  return '';
}

function nestedCommand(params: Readonly<Record<string, unknown>>): string {
  const cfg = params.config;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return '';
  const n = cfg as Record<string, unknown>;
  const cmd = typeof n.command === 'string' ? n.command.trim() : '';
  if (cmd) return cmd;
  const url = typeof n.url === 'string' ? n.url.trim() : '';
  const transport = typeof n.transport === 'string' ? n.transport : '';
  return url ? `${transport}:${url}` : '';
}

/** 路径规范化：统一分隔符、折叠多余分隔符、盘符小写（Windows 大小写不敏感）。 */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  out = out.replace(/\/{2,}/g, '/');
  out = out.replace(/^([a-zA-Z]:\/)/, (_, d: string) => (d as string).toLowerCase());
  out = out.replace(/\/+$/, '');
  return out;
}

/**
 * grant key：`principal + workspaceHash + toolId + approvalClass + canonicalTarget`。
 * 刻意不含 conversationId（对话可恢复/分叉/压缩，key 会串，§1.4 硬规则 3）。
 */
export function grantKeyOf(input: {
  principal: string;
  workspaceHash: string;
  toolId: string;
  approvalClass: ApprovalClass;
  canonicalTarget: string;
}): string {
  const digest = createHash('sha1')
    .update(`${input.canonicalTarget}\u0000${input.toolId}`)
    .digest('hex')
    .slice(0, 16);
  return [input.principal, input.workspaceHash, input.toolId, input.approvalClass, digest].join('|');
}

/** 主解析函数。顺序见文件头注释。 */
export function resolveAuthorization(input: AuthorizationInput): AuthorizationResult {
  const { def, mode, params, policyVerdict } = input;
  const cls: ApprovalClass = approvalClassOf(def);
  const target = canonicalTargetOf(def, params);
  const allowed = allowedGrantScopesFor(def ?? ({ approvalClass: cls } as ToolDefinition));
  const grantKey = grantKeyOf({
    principal: input.principal,
    workspaceHash: input.workspaceHash,
    toolId: input.tool,
    approvalClass: cls,
    canonicalTarget: target.target,
  });
  const base = { approvalClass: cls, targetKind: target.kind, canonicalTarget: target.target, grantKey, allowedGrantScopes: allowed };

  // 1) 未登记工具 / 无定义 → fail-closed（desktop-host 已在更外层拒过，这里兜第二道）。
  if (!def) return { ...base, decision: 'deny', reason: 'unknown-capability', outsideApproved: false };

  const outsideRequested = policyVerdict?.reason === 'outside-workspace';

  // 2) hard-deny 永远先于任何 grant / 档位 / 来源。
  if (input.hardRule) {
    return { ...base, decision: 'deny', reason: 'hard-deny', hardRule: input.hardRule, outsideApproved: false };
  }

  // 3) 资源/工作区拒绝：策略层 deny（工作区未配置、档位禁止、缺参数）。
  if (policyVerdict && policyVerdict.decision === 'deny') {
    return { ...base, decision: 'deny', reason: policyVerdict.reason, outsideApproved: false };
  }

  // 4) 显式 deny 规则（A4 接入位）：本版恒不命中。

  // 5) always：必须新鲜人工确认；只有"精确 temporary grant"能替代本次询问。
  if (cls === 'always') {
    const g = input.grant;
    if (g && g.scope === 'temporary' && g.key === grantKey && (!g.expiresAt || g.expiresAt > input.now) && g.source !== 'internal-bot') {
      return { ...base, decision: 'allow', reason: 'temporary-grant', grantScope: 'temporary', outsideApproved: false };
    }
    // bot 内部预授权（§1.4 硬规则 6）：唯一合法用途是 chat-insert / chat-send 这类
    // 页侧聊天动作——bot 自己启动时发的工具级放行，不是"用户允许了 chat-send"。
    // 别的 always 工具（memory.delete / policy.set …）拿不到这条通道：内部预授权
    // 一旦被泛化，就等于让 bot 给自己开了删记忆 / 改档位的后门。
    if (g && g.source === 'internal-bot' && g.key === grantKey && target.kind === 'chat-action') {
      return { ...base, decision: 'allow', reason: 'internal-preauth', grantScope: g.scope, outsideApproved: false };
    }
    return { ...base, decision: 'ask', reason: 'requires-approval', outsideApproved: false };
  }

  // 6) mode：有效 grant 先于档位（grant 是"用户对这一具体目标的明确同意"）。
  if (cls === 'mode') {
    const g = input.grant;
    if (
      g &&
      g.key === grantKey &&
      g.scope !== 'once' &&
      // 越界目标不吃 grant（§1.4 硬规则 5）：跨工作区必须逐次确认，或由用户显式建 project 规则。
      !outsideRequested &&
      (g.expiresAt === undefined || g.expiresAt > input.now)
    ) {
      return {
        ...base,
        decision: 'allow',
        reason: g.source === 'internal-bot' ? 'internal-preauth' : `${g.scope}-grant`,
        grantScope: g.scope,
        outsideApproved: false,
      };
    }

    // 7) 档位判定：full / auto / workspace / ask 全在这里收敛。
    if (mode === 'full') {
      // full 只免掉 mode 类的逐次确认；越界同样视为已批准（与既有 outsideApproved 语义一致）。
      return {
        ...base,
        decision: 'allow',
        reason: policyVerdict?.reason ?? 'mode-full',
        outsideApproved: outsideRequested,
      };
    }
    if (policyVerdict) {
      if (policyVerdict.decision === 'allow') {
        return { ...base, decision: 'allow', reason: policyVerdict.reason, outsideApproved: outsideRequested };
      }
      if (policyVerdict.decision === 'require-consent') {
        // 用户持久规则只能替 mode 类免审（A4 落地前恒 false）。
        if (input.projectRuleHit && !outsideRequested) {
          return { ...base, decision: 'allow', reason: 'project-rule', outsideApproved: false };
        }
        return { ...base, decision: 'ask', reason: policyVerdict.reason, outsideApproved: false };
      }
    }
    // mode 类但策略层没给结论：保守询问，绝不静默放行。
    return { ...base, decision: 'ask', reason: 'policy-unresolved', outsideApproved: false };
  }

  // 8) none：无审批类别风险，直接放行（工作区边界仍由资源层 deny 兜住）。
  if (cls === 'none') {
    return { ...base, decision: 'allow', reason: 'no-approval-required', outsideApproved: false };
  }

  // 9) 其余（含理论上到不了的 hard-deny 静态归类）→ fail-closed。
  return { ...base, decision: 'deny', reason: 'fail-closed', outsideApproved: false };
}
