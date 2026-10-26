/**
 * 工具注册表 + 风险分级 + 站点 allowlist（v0.3.1 治理地基）
 *
 * 这是「授权 → 执行」链路的治理层：声明哪些工具存在、各自的风险等级、以及哪些
 * 页面 origin 被允许发起该工具的 grant。默认 fail-closed——未注册的工具、或不在
 * 白名单内的 origin 一律拒绝。
 *
 * 真实能力（chat-read / chat-insert / chat-send）在 v0.3.3 接入后在此登记；v0.3.2
 * 的授权 UI 会读取 risk 等级决定「同意/拒绝」闸的呈现强度。本模块只做纯数据治理，
 * 不持有任何密钥、不参与 grant 签名（签名在 authority.ts）。
 */

import {
  APPROVAL_CLASSES,
  type ApprovalClass,
  type CanonicalTargetKind,
  type GrantScope,
} from '../shared/consent-contract';

/**
 * 能力风险等级：read < insert < send < privileged。
 * - read：只读，不改变任何状态（低风险，自动放行）。
 * - insert：向页面写入内容（可被用户撤销）。
 * - send：主动向页面外发出内容。
 * - privileged：触达宿主本机资源（进程执行 / 文件系统），最高危。
 *   v0.5 起与阈值比较而非判等——判等写法会在新增等级时静默绕过同意闸门。
 */
export type ToolRisk = 'read' | 'insert' | 'send' | 'privileged';

export const RISK_ORDER: Readonly<Record<ToolRisk, number>> = {
  read: 1,
  insert: 2,
  send: 3,
  privileged: 4,
};

/**
 * 执行侧：能力在哪一侧真正运行。
 * - 'page'：经 ws 派发到注入页，在真实 DOM 中执行（chat-* 走此路）。
 * - 'host'：在常驻宿主进程内执行，**绝不经过页面**（shell / file 必须走此路）。
 */
export type ExecutionSide = 'page' | 'host';

/** 缺省执行侧：保持 v0.4 既有行为（页端），确保新增字段不改变现有能力路由。 */
export const DEFAULT_EXECUTION: ExecutionSide = 'page';

/** 取实际执行侧（def.execution 缺省时回落 'page'）。 */
export function executionSide(def: Pick<ToolDefinition, 'execution'>): ExecutionSide {
  return def.execution ?? DEFAULT_EXECUTION;
}

/** 需要用户同意的最低风险等级。 */
export const CONSENT_MIN_RISK: ToolRisk = 'insert';

/** 是否需要过同意闸门（阈值口径，等级扩展自动生效）。 */
export function needsConsent(def: Pick<ToolDefinition, 'risk'>): boolean {
  return riskRank(def.risk) >= riskRank(CONSENT_MIN_RISK);
}

/** 风险等级数值，便于排序与阈值比较（如「仅允许 ≤ insert 自动放行」）。 */
export function riskRank(risk: ToolRisk): number {
  return RISK_ORDER[risk];
}

/**
 * 审批类别取值（A1）。运行期若拿到缺省/非法值一律 fail-closed 到 'always'：
 * 宁可多问一次，也不能因为漏标让某个特权能力在 full 档下静默执行。
 * 注意默认值不是 'mode'——'mode' 的含义是"跟随档位"，在 full 下等于免审。
 */
export function approvalClassOf(
  def: Pick<ToolDefinition, 'approvalClass'> | Partial<ToolDefinition> | undefined,
): ApprovalClass {
  const value = def?.approvalClass;
  return value && (APPROVAL_CLASSES as readonly string[]).includes(value) ? value : 'always';
}

/** 这类调用是否需要人工确认（approvalClass 口径，与 risk 阈值口径正交）。 */
export function requiresApproval(def: ToolDefinition): boolean {
  const cls = approvalClassOf(def);
  return cls === 'mode' || cls === 'always';
}

export interface ToolDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly risk: ToolRisk;
  /**
   * 允许发起该工具 grant 的页面 origin 白名单（与 location.origin 做大小写不敏感比对）。
   * 空数组 = 不允许任何源（fail-closed）。通配符 '*' 仅用于本地/测试，禁止进入生产默认。
   */
  readonly allowedOrigins: readonly string[];
  /**
   * 执行侧：'page' 派发到注入页 DOM；'host' 在常驻宿主进程内执行。
   * 缺省 'page'（向后兼容 v0.4 全部既有能力）。
   * 触碰宿主本机资源的能力（shell / file）必须显式声明 'host'，
   * 否则会被 `desktop-host` 的页端优先路由误派发到页面。
   */
  readonly execution?: ExecutionSide;
  /**
   * 审批类别（A1，交接单_20261026 §1.1/§1.3）：这类调用是否需要人工确认。
   * 与 risk 正交——risk 描述"能力触达面"，approvalClass 描述"是否逐次问人"。
   * 必填：新工具必须显式归类，禁止静默落到 mode（= full 档下自动执行）。
   * 运行期缺/非法值一律 fail-closed 到 'always'，绝不回落 'mode'。
   */
  readonly approvalClass: ApprovalClass;
  /** 批准后允许发放的 grant 作用域（缺省 = 仅 once）。 */
  readonly grantScopes?: readonly GrantScope[];
  /** 规范目标类型：grant 绑定哪个动作对象（缺省 = 'generic'，不参与 grant 复用）。 */
  readonly canonicalTargetKind?: CanonicalTargetKind;
}

export type ToolRegistryDenyCode = 'unknown-tool' | 'origin-denied';

export class ToolRegistryError extends Error {
  constructor(
    public readonly code: ToolRegistryDenyCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export interface ToolRegistry {
  has(id: string): boolean;
  get(id: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  /**
   * fail-closed 判定：工具未注册 → false；origin 为空串（未知源）→ false；
   * origin 不在白名单 → false。仅当工具注册且 origin 精确命中（或白名单含 '*'）才 true。
   */
  isOriginAllowed(id: string, origin: string): boolean;
  /** 运行时补充登记（v0.3.3 动态接入 chat-* 能力时用）。 */
  register(def: ToolDefinition): void;
}

function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase();
}

export function createToolRegistry(defs: readonly ToolDefinition[] = []): ToolRegistry {
  const map = new Map<string, ToolDefinition>();
  // 归一化：无论构造期还是运行期 register，入库对象都必须带确定的 execution 与
  // approvalClass，避免调用方读到 undefined 而回落到「页端执行 / 跟随档位」这种危险默认值。
  // approvalClass 缺/非法 → fail-closed 到 'always'（不静默免审）。
  const put = (d: ToolDefinition): void => {
    map.set(d.id, { ...d, execution: executionSide(d), approvalClass: approvalClassOf(d) });
  };
  for (const d of defs) put(d);

  return {
    has: (id) => map.has(id),
    get: (id) => map.get(id),
    list: () => [...map.values()],
    isOriginAllowed(id, origin) {
      const def = map.get(id);
      if (!def) return false;
      if (!origin) return false;
      const want = normalizeOrigin(origin);
      return def.allowedOrigins.some((o) => {
        const n = normalizeOrigin(o);
        return n === '*' || n === want;
      });
    },
    register(def) {
      put(def);
    },
  };
}
