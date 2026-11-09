/**
 * 工具执行审计（还清 v0.3 遗留任务 3.2.4）
 *
 * 定位：这是「授权 → 治理 → 同意 → 策略 → 执行」全链路的留痕层，也是 v0.5 之后
 * 所有高风险能力（shell / file）的地基——没有它，宿主本机一旦被命令执行就无法回溯。
 *
 * 设计要点：
 * 1. **覆盖所有终态**，而不只是成功：malformed / grant 校验失败 / unknown-capability /
 *    origin-denied / consent-unavailable / consent-denied / policy-denied / 执行失败，
 *    一律留痕。拒绝类记录的价值高于成功记录（它们是唯一能证明「fail-closed 真的生效」的证据）。
 * 2. **有界环形缓冲**：默认 200 条，写满丢弃最旧的一条，防止长期驻留导致内存无界增长。
 * 3. **只存摘要不存正文**：命令与路径做截断，不记录执行输出正文（避免凭据/隐私落审计）。
 * 4. 纯 TS 无副作用依赖，便于单测。
 */

import type { ExecutionSide, ToolRisk } from './tool-registry';
import type { ApprovalClass, GrantScope } from '../shared/consent-contract';

/** 执行决策档位（与 policy 档位同构；字符串字面量联合是结构化类型，两处声明可互相赋值）。 */
export type AuditMode = 'workspace' | 'ask' | 'auto' | 'full';

export type AuditOutcome =
  /** 执行成功。 */
  | 'executed'
  /** 执行抛出异常或能力返回 !ok。 */
  | 'execution-failed'
  /** grant 令牌畸形（如 base64 解析失败）。 */
  | 'malformed'
  /** grant 校验失败：重放 / 过期 / 密钥不符。 */
  | 'denied'
  /** 工具未在能力表或注册表登记。 */
  | 'unknown-capability'
  /** grant 发起 origin 不在该工具白名单内。 */
  | 'origin-denied'
  /** 需要征求同意但没有可用的页端连接（无法询问人类）。 */
  | 'consent-unavailable'
  /** 用户在页端模态点了拒绝或超时未决。 */
  | 'consent-denied'
  /** 三档策略引擎判定拒绝（如 full 档以外的越界访问、命中风险模式被拦截）。 */
  | 'policy-denied';

/** 拒绝类终态：用于统计与告警（区别于「通过但执行失败」）。 */
export const DENY_OUTCOMES: ReadonlySet<AuditOutcome> = new Set<AuditOutcome>([
  'malformed',
  'denied',
  'unknown-capability',
  'origin-denied',
  'consent-unavailable',
  'consent-denied',
  'policy-denied',
]);

export function isDenyOutcome(outcome: AuditOutcome): boolean {
  return DENY_OUTCOMES.has(outcome);
}

export interface ToolExecutionRecord {
  /** 记录唯一 id，便于日志与 HTTP 端点对照。 */
  readonly id: string;
  /** epoch 毫秒。 */
  readonly at: number;
  readonly tool: string;
  readonly risk?: ToolRisk;
  readonly side?: ExecutionSide;
  /** grant 发起方 origin（未知为空串，保持 fail-closed 语义可追溯）。 */
  readonly origin: string;
  /** 被消费的 grant id（若已通过校验）。 */
  readonly grantId?: string;
  /** 决策档位；未接入策略时为 'ask' 之外的实际档位。 */
  readonly mode?: AuditMode;
  readonly outcome: AuditOutcome;
  /** 失败/拒绝原因码（与 ToolExecutionResult.reason 对齐）。 */
  readonly reason?: string;
  /** 执行耗时毫秒（仅真正发起执行的记录才有）。 */
  readonly durationMs?: number;
  /** 命令 / 路径摘要：截断且不脱敏以外的正文不入审计。 */
  readonly summary?: string;
  readonly ok: boolean;
  /**
   * A2：审批类别。审计必须能回答"这次为什么问/为什么没问"，
   * 只有 risk 是不够的——full 档下 mode 免审、always 仍问，靠这一列区分。
   */
  readonly approvalClass?: ApprovalClass;
  /** A2：本次放行所依据的 grant 作用域（无 grant 时缺省）。 */
  readonly grantScope?: GrantScope;
  /** A2：命中的硬规则 id（hard-deny 时必填）。 */
  readonly hardRule?: string;
  /** A2：规范目标摘要（路径 / argv / memory id 等），用于还原授权链。 */
  readonly canonicalTarget?: string;
  /**
   * K2（2026-11-09）：**本次调用是否触及工作区外**——机器算出来的事实，不是"用户批过"。
   *
   * ── 为什么必须由布尔字段承载，不能靠 `reason` ──
   * 同一个"越界"事实在 `reason` 列**本来就有两个不同取值**：
   *   - `policy.ts` 文件类 workspace 档越界被拒 ⇒ `reason: 'mode-restricted'`（"为什么拒"占着这格）；
   *   - 同一处 full 档越界放行 ⇒ `reason: 'outside-workspace'`。
   * 再往成功路径的白名单里塞 `'outside-workspace'`，只会让"越界"在一条路上叫这个名字、
   * 在另一条路上叫那个名字——那才是真漂移。**所以越界事实只由本字段承载。**
   *
   * ── 与 `AuthorizationResult.outsideApproved` 的区别（两格不同义，别混）──
   *   - `outside`（本字段）= **越界事实**，取 `policyVerdict.outside`，机器算的；
   *   - `outsideApproved`  = **能力层越界通行证**（`allowOutsideWorkspace`），
   *                          full 档下由策略层 allow 直接授予，**不等于用户点过**。
   *
   * ── 已知射程 ──
   * 非 governed 工具（`memory.delete` 等，`verdict === null`）**永不带本字段**（键不存在）——
   * 它们没有边界语义，"没有痕迹"是有原因的没有，不是漏写。
   * `mcp.test` 因 `cwd` 嵌在 `params.config.cwd`、策略层只读顶层而**算不出越界**，
   * 同样不带此键（已知缺口，见 `mcp.test` 单卡）。
   */
  readonly outside?: boolean;

  /**
   * F-2a（2026-11-09）：**这一发审批落在哪个面上**——把"页内到底承担了多少审批"
   * 从"读码推"变成"实测"。
   *
   * 三个值，与 `AGENTS.md`「权限审批」条的语义直接对应：
   *   - `page-modal`            ＝ **页内模态**（页面 DOM，agent 可控面）；
   *   - `host-window`           ＝ **宿主侧独立窗口**（C″，Rust 自绘，合规面）；
   *   - `host-unavailable-deny` ＝ 独立窗口起不来 ⇒ **fail-closed 拒绝**。
   *
   * 为什么要有这一格：条文写着「审批界面须独立于当前页面 DOM」，而**页内模态今天
   * 仍在承担普通审批**（见 `desktop-host.ts` 的普通支）。到底占多少，只有把每次
   * 审批的面记下来才数得清——否则"要不要废止页内模态"这个决定只能靠读码推。
   *
   * 与 `outside` 的关系：**正交**。`outside` 说"越没越界"，本字段说"问在哪儿"。
   * 未经过审批的调用（不弹任何面、例如 `none`/`mode` 类 grant 或 full 档放行）
   * **不带本字段**——没有面可记，不是漏写。
   */
  readonly consentSurface?: 'page-modal' | 'host-window' | 'host-unavailable-deny';
}

/** 写入审计的输入：除 id/at/ok 由本模块补全外，其余由调用方提供。 */
export type AuditInput = Omit<ToolExecutionRecord, 'id' | 'at' | 'ok'>;

export interface AuditLog {
  /** 写入一条记录（环满则丢弃最旧记录），返回落库后的记录。 */
  record(input: AuditInput): ToolExecutionRecord;
  /** 按时间倒序返回最近 n 条。 */
  list(limit?: number): readonly ToolExecutionRecord[];
  /** 按工具名过滤（可选）。 */
  listByTool(tool: string, limit?: number): readonly ToolExecutionRecord[];
  /** 仅返回拒绝类记录。 */
  listDenied(limit?: number): readonly ToolExecutionRecord[];
  /** 总写入计数（含已被环丢弃的），用于判断是否发生审计覆盖。 */
  readonly total: number;
  /** 清空（测试用）。 */
  clear(): void;
}

export const DEFAULT_AUDIT_CAPACITY = 200;
/** 摘要最大长度：命令与路径都按此截断。 */
export const SUMMARY_MAX_LEN = 240;

/**
 * 生成摘要：把任意参数压成单行短文本。
 * - shell：取 command 字段；file：取 path 字段；
 * - 其余：取 JSON 后截断。
 * 不做深度脱敏，但**绝不记录执行输出正文**（调用方不要把 stdout 传进来）。
 */
export function summarizeParams(params: unknown, tool?: string): string {
  // 空参数统一成可读占位：审计记录里留一条空摘要没有任何回溯价值。
  if (params === undefined || params === null) return '(empty)';

  const pick = (keys: readonly string[]): string | undefined => {
    if (typeof params !== 'object') return undefined;
    const bag = params as Record<string, unknown>;
    for (const k of keys) {
      const v = bag[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return undefined;
  };

  // 兜底统一走 JSON（而非 String()），避免对象退化成无意义的 '[object Object]'。
  const fallback = (): string => {
    try {
      return JSON.stringify(params) ?? '(empty)';
    } catch {
      return '(unserializable)';
    }
  };

  let text: string;
  if (tool === 'shell.exec') {
    text = pick(['command', 'cmd']) ?? fallback();
  } else if (tool?.startsWith('file.')) {
    text = pick(['path', 'filePath']) ?? fallback();
  } else {
    text = fallback();
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX_LEN ? `${flat.slice(0, SUMMARY_MAX_LEN)}…` : flat;
}

export function createAuditLog(capacity = DEFAULT_AUDIT_CAPACITY): AuditLog {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError('audit capacity must be a positive integer');
  }
  const ring: ToolExecutionRecord[] = [];
  let seq = 0;
  let total = 0;

  const idOf = (): string => `aud-${(seq += 1).toString(36)}-${Date.now().toString(36)}`;

  function record(input: AuditInput): ToolExecutionRecord {
    const entry: ToolExecutionRecord = {
      ...input,
      id: idOf(),
      at: Date.now(),
      ok: input.outcome === 'executed',
    };
    total += 1;
    if (ring.length >= capacity) ring.shift();
    ring.push(entry);
    return entry;
  }

  function list(limit = capacity): readonly ToolExecutionRecord[] {
    const n = Math.max(0, Math.min(limit, ring.length));
    const start = ring.length - n;
    return start <= 0 ? [...ring] : ring.slice(start);
  }

  return {
    record,
    list,
    listByTool: (tool, limit) => list(Number.MAX_SAFE_INTEGER).filter((r) => r.tool === tool).slice(-(limit ?? capacity)),
    listDenied: (limit) => list(Number.MAX_SAFE_INTEGER).filter((r) => isDenyOutcome(r.outcome)).slice(-(limit ?? capacity)),
    get total() {
      return total;
    },
    clear() {
      ring.length = 0;
      total = 0;
      seq = 0;
    },
  };
}
