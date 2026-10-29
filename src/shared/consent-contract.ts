/**
 * 审批决策契约（共享层）
 *
 * 唯一允许的三种审批结果。禁止出现"始终允许"。
 *
 * A1 起把「是否审批」与「批准后作用域」拆成独立轴（交接
 * 班_20261026 §1）：
 * - approvalClass：这类工具是否需要人工确认（none/mode/always/hard-deny）。
 *   与 tool-registry 的 risk（能力触达面）不是一回事，不能互相顶替。
 * - grantScope：用户点「允许」之后放行到什么程度、何时失效。
 *   allow-session 的语义改为「会话 + 工作区 + 工具 + 动作类 + 规范目标」，
 *   生命周期到会话结束/工作区变化/策略变化/撤销为止；10 分钟 TTL 只保留给
 *   temporary（always 类的高级二次放行）。
 */

export type ConsentDecision = 'allow-once' | 'deny' | 'allow-session' | 'allow-conversation';

export const CONSENT_DECISIONS = ['allow-once', 'deny', 'allow-session', 'allow-conversation'] as const;

export const CONSENT_BUTTON_LABELS: Readonly<Record<ConsentDecision, string>> = {
  'allow-once': '允许一次',
  deny: '拒绝',
  'allow-session': '本次会话允许此操作',
  'allow-conversation': '本次对话始终允许',
};

/**
 * 同意请求的呈现元数据（v0.5 / A5）。
 * 全部为「已翻译好的展示字符串」或宿主侧枚举透传，页端不再翻译 policy 字符串。
 *
 * A5 收口：原 src/host/protocol.ts 和 src/ui/consent.ts 各复制了一份，加字段必须三处同步。
 * 现以本文件为唯一真源，另两处只做 `export type ... from` 重导出。
 */
export interface ConsentMeta {
  /** 风险等级展示名（如「特权级」）。 */
  riskLabel?: string;
  /** 当前审批档位展示名（如「询问审批」）。 */
  modeLabel?: string;
  /** 命中的风险项中文标签（如「递归删除」「提权执行」）。 */
  riskFlagLabels?: readonly string[];
  /** 是否越出工作区（用于显示越界徽标）。 */
  outside?: boolean;
  /** A5：审计字段——本次调用的 approvalClass（透传，不做翻译）。 */
  approvalClass?: ApprovalClass;
  /** A5：审计字段——用户点允许后采用的 grantScope 建议值。 */
  grantScope?: GrantScope;
  /** A5：审计字段——硬拒绝规则 id（仅当命中 hard-deny 时下发）。 */
  hardRule?: string;
  /** A5：审计字段——规范目标类型（path/argv/memory-id/...）。 */
  canonicalTarget?: string;
  /** A5：动态按钮开关——true 时不渲染「本次会话允许」按钮（如 hard-deny/once-only 场景）。 */
  hideAllowSession?: boolean;
  /** R-4：本次审批允许的 grantScope 列表（host 生产端透传）。 */
  allowedGrantScopes?: readonly string[];
  /**
   * 动态按钮开关——true 时渲染「本次对话始终允许」按钮。
   * 仅在宿主确认存在对话身份（conversationId）且档位允许时下发；
   * 无对话身份时按钮不出现，仍然逐次询问。
   */
  allowConversation?: boolean;
}

/** 审批类别：这类工具调用是否需要人工确认。 */
export const APPROVAL_CLASSES = ['none', 'mode', 'always', 'hard-deny'] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export const APPROVAL_CLASS_LABELS: Readonly<Record<ApprovalClass, string>> = {
  none: '无需确认',
  mode: '按档位',
  always: '始终确认',
  'hard-deny': '直接拒绝',
};

/** 授权作用域：一次人工批准放行到什么范围、何时失效。 */
export const GRANT_SCOPES = ['once', 'turn', 'session', 'project', 'global', 'temporary'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export const GRANT_SCOPE_LABELS: Readonly<Record<GrantScope, string>> = {
  once: '仅本次调用',
  turn: '本轮对话内',
  session: '本会话内此目标',
  project: '本项目规则',
  global: '跨项目规则',
  temporary: '临时放行（10 分钟）',
};

/**
 * 规范目标类型：grant 绑定的"动作对象"是哪一类实体。
 * - 'generic'：无越权意义的只读/低风险能力，不参与 grant 复用（A1 决定，
 *   见交接单 §1.4 硬规则 3——禁止用"同工具名"当授权 key）。
 */
export const CANONICAL_TARGET_KINDS = [
  'path',
  'argv',
  'memory-id',
  'mcp-call',
  'policy-mode',
  'workspace-root',
  'chat-action',
  'generic',
] as const;
export type CanonicalTargetKind = (typeof CANONICAL_TARGET_KINDS)[number];
