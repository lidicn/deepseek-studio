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
 *   5. 对话级放行（本对话已由用户点过「本次对话始终允许」）
 *   6. always 类的新鲜人工确认（grant 只能消费精确 temporary）
 *   7. mode 类的有效 grant
 *   8. policyMode 对 mode 类的判定
 *   9. none 类放行
 *   10. 其余一律 fail-closed
 *
 * 关于 full 档（2026-11-08 卡 H 起，出资人拍板「完全放开不会弹窗」）：
 *   - mode 类：由 evaluatePolicy 直接放行（第 8 步）；
 *   - always 类：**默认不再询问**，直接 allow 并在审计里记 `full-mode-allow`（第 6b 步）；
 *   - **三条例外照旧**（都在第 6b 步之前 return，full 档不豁免）：
 *       ① hard-deny（第 2 步）与策略层 deny（第 3 步）＝**拒绝**，不是询问；
 *       ② 越界（第 5 步判出的 outsideRequested）＝仍逐次确认（§1.4 硬规则 5）；
 *       ③ `FULL_MODE_STILL_ASKS`（现仅 `memory.purge`，彻底删除不可恢复）＝仍问一次。
 *   ⇒ 「完全放开」= 不再被打扰，**不是**「拒绝变成放行」，也不是「可以静默跨工作区」。
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
import { FULL_MODE_ALLOW_REASON, FULL_MODE_STILL_ASKS } from '../shared/policy-contract';
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
   * 是否已获准越出工作区。策略直接放行、用户已批准，或 full 档位放行时为真。
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
  /**
   * 对话级放行：用户已在本对话点过「本次对话始终允许」。
   * 只覆盖"逐次询问"这一层；hard-deny / policy-deny / unknown 在前面已拦截。
   */
  readonly conversationApproved?: boolean;
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
      // C1 P1 安全批 R2-02：MCP 目标的 id 键是 `serverId`（见 tool-contract 的
      // 'mcp.get' 适配与 desktop-host 的 mcp.get handler），**不是** `server`/`name`。
      // 原实现只认 server/serverName/name → `mcp.get { serverId }` 取不到 id →
      // 目标退化成空串 → 「换一台服务器」不会被当成换目标（放行会跨服务器复用）。
      const server = str(['serverId', 'server', 'serverName', 'name']);
      const toolName = str(['tool', 'toolName']);
      const nestedCmd = nestedCommand(params);
      return { kind, target: [server, toolName, nestedCmd].filter(Boolean).join('::') };
    }
    case 'policy-mode':
      return { kind, target: str(['mode']) };
    case 'workspace-root':
      return { kind, target: normalizePath(str(['root', 'path'])) };
    case 'search-root':
      // C1 P1 安全批 TD-01：search_files 的目标 = 被遍历的 root。
      // 没有它，search_files 的 canonicalTarget 会退化成空串 →
      // R3-01 的对话级放行 key 就不绑定「检索哪个目录」，
      // 同意过一次 A 目录的检索 → 同对话内检索 B 目录也不再问。
      return { kind, target: normalizePath(str(['root'])) };
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
  const { def, params, policyVerdict } = input;
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

  // C1 P1 安全批 R3-01b：**越界事实独立判定**，不靠 reason 推断。
  //
  // 原实现：`policyVerdict?.reason === 'outside-workspace'`。
  // 问题：reason 表达的是「**为什么**需要审批」，而「是否越界」是**另一个维度**。
  // 进程类在 auto/ask 档下若命令**既命中风险模式又越界**，reason 取的是
  // `risk-detected`，`outside-workspace` 这个事实只留在 detail 里 →
  // → 这里判成「不越界」→ 对话级放行把它放行 → **越界静默通过**。
  //
  // 现在：策略层给出**独立的** `outside` 布尔量（policy.ts 的 PolicyVerdict.outside），
  // 这里直接用它；老判据保留为兜底（策略层未给 outside 时仍能按 reason 判）。
  const outsideRequested =
    policyVerdict?.outside === true || policyVerdict?.reason === 'outside-workspace';

  // 2) hard-deny 永远先于任何 grant / 档位 / 来源。
  if (input.hardRule) {
    return { ...base, decision: 'deny', reason: 'hard-deny', hardRule: input.hardRule, outsideApproved: false };
  }

  // 3) 资源/工作区拒绝：策略层 deny（工作区未配置、档位禁止、缺参数）。
  if (policyVerdict && policyVerdict.decision === 'deny') {
    return { ...base, decision: 'deny', reason: policyVerdict.reason, outsideApproved: false };
  }

  // 4) 显式 deny 规则（A4 接入位）：本版恒不命中。

  // 5) 对话级放行：「一个对话审批一次」。必须在 hard-deny / policy deny / unknown
  //    之后（红线永不被对话放行覆盖），且在 always / mode 判定之前
  //    （否则永远走不到 ask 分支，用户根本没有点按钮的机会）。
  //
  //    C1 P1 安全批 R3-01：两处收紧 ——
  //    ① `outsideApproved` **恒为 false**：原实现把 `outsideRequested` 直接透传出去，
  //       等于「对话级同意」顺带批准了**工作区外**的操作。
  //       越界目标必须逐次确认（§1.4 硬规则 5），对话级放行不覆盖它。
  //    ② key 侧（desktop-host）：key 已纳入 toolId + canonicalTarget，
  //       所以这里的放行只对「这个工具 + 这个目标」生效。
  //
  //    C1 P1 安全批 R3-01b：**越界目标本身**也不吃对话级放行。
  //
  //    ── 为什么 key 侧（②）挡不住这一条 ──
  //    ② 解决的是「**跨目标**泛化」：区内 A 的同意 → 放行区外 B（key 不同 → 不命中）。
  //    但如果用户**恰恰对区外目标 B 点过一次**「本次对话始终允许」，
  //    那个 key 里 canonicalTarget 就是 B（区外路径）→ 之后再来同一个 B → **key 命中** →
  //    这里 return allow → **越界被静默放行，且不再问**。
  //    表现：越界请求不弹审批，直接执行（能力层第二道闸会挡下 → 变成「静默失败」）。
  //    这违反 §1.4 硬规则 5「跨工作区必须逐次确认」——用户永远看不到那一下问询。
  //
  //    ── 修法 ──
  //    `outsideRequested` 为真时**对话级放行不适用**，继续往下走到档位判定
  //    → 走 require-consent → **逐次问**。
  //    语义与硬规则 5 一致：越界是「每次都要问」的事，不是「一个对话问一次」的事。
  //    不放宽任何东西（只把越界从对话级放行的适用范围里摘出去）。
  if (input.conversationApproved && !outsideRequested) {
    return {
      ...base,
      decision: 'allow',
      reason: 'conversation-approved',
      // R3-01：恒 false —— 越界不被对话级放行覆盖。
      outsideApproved: false,
    };
  }

  // 6) always：必须新鲜人工确认；只有"精确 temporary grant"能替代本次询问。
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
    // 6b) 「完全放开（full）」档：always 类**不再询问**（2026-11-08 出资人拍板「完全放开改成不会弹窗」）。
    //
    //   语义边界（三条例外都不能被这条覆盖，且它们都在本行之前 return）：
    //     · hard-deny 地板 → 第 2 步已 return deny（full 档本来就拒绝，不是询问）；
    //     · 策略层 deny（未配置工作区的文件类 / cwd 越界等）→ 第 3 步已 return deny；
    //     · 越界事实（outsideRequested）→ 第 5 步的对话级放行不吃它；本分支同样**不吃**：
    //       越界必须逐次确认（§1.4 硬规则 5），full 档不等于「可以静默跨工作区」。
    //     · `memory.purge`（FULL_MODE_STILL_ASKS 显式例外）→ 仍走 ask，不可撤销操作保留一次确认。
    if (
      input.mode === 'full' &&
      !outsideRequested &&
      !FULL_MODE_STILL_ASKS.includes(input.tool)
    ) {
      return { ...base, decision: 'allow', reason: FULL_MODE_ALLOW_REASON, outsideApproved: false };
    }
    return { ...base, decision: 'ask', reason: 'requires-approval', outsideApproved: false };
  }

  // 7) mode：有效 grant 先于档位（grant 是"用户对这一具体目标的明确同意"）。
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

    // 8) 档位判定：auto / workspace / ask 在这里收敛。
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

  // 9) none：无审批类别风险，直接放行（工作区边界仍由资源层 deny 兜住）。
  if (cls === 'none') {
    return { ...base, decision: 'allow', reason: 'no-approval-required', outsideApproved: false };
  }

  // 10) 其余（含理论上到不了的 hard-deny 静态归类）→ fail-closed。
  return { ...base, decision: 'deny', reason: 'fail-closed', outsideApproved: false };
}
