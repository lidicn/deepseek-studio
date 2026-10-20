/**
 * 工具执行授权票据存储（一次性 reservation）
 *
 * 每张 grant 绑定 documentId / sessionId / requestId，且只能被消费一次（one-shot reservation）。
 * 消费后即从可消费集合移除，重放同一 requestId 拿不到第二张有效 grant。
 */

export interface ToolGrant {
  readonly grantId: string;
  readonly documentId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly scope: string;
  /** 发起 grant 的页面 origin（来自 IssueGrantInput）。空串 = 未知源，执行期按 allowlist 闸门拒绝。 */
  readonly origin: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  consumed: boolean;
}

export interface IssueGrantInput {
  documentId: string;
  sessionId: string;
  requestId: string;
  scope: string;
  /** 发起 grant 的页面 origin；留空表示无页面上下文（执行期会被 allowlist 闸门拒绝）。 */
  origin?: string;
  ttlMs?: number;
}

export interface GrantStore {
  issue(input: IssueGrantInput): ToolGrant;
  /** 一次性消费：成功置 consumed=true 并返回；已消费/不存在/过期返回 null。 */
  consume(requestId: string): ToolGrant | null;
  /** 仅返回可消费（未消费、未过期）的 grant；已消费/不存在返回 null。 */
  get(requestId: string): ToolGrant | null;
  /**
   * 原样读取记录（含已消费），供校验层区分「不存在」与「已消费」。
   * 过期记录已被 purgeExpired 移除，故返回 null 即代表真不存在。
   */
  peek(requestId: string): ToolGrant | null;
  revoke(requestId: string): void;
  size(): number;
}

let counter = 0;
function nextGrantId(): string {
  counter += 1;
  return `grant_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function createInMemoryGrantStore(defaultTtlMs = 5 * 60_000): GrantStore {
  const grants = new Map<string, ToolGrant>();

  const purgeExpired = (): void => {
    const now = Date.now();
    for (const [id, g] of grants) if (now > g.expiresAt) grants.delete(id);
  };

  return {
    issue(input) {
      purgeExpired();
      const now = Date.now();
      const grant: ToolGrant = {
        grantId: nextGrantId(),
        documentId: input.documentId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        scope: input.scope,
        origin: input.origin ?? '',
        issuedAt: now,
        expiresAt: now + (input.ttlMs ?? defaultTtlMs),
        consumed: false,
      };
      grants.set(input.requestId, grant);
      return grant;
    },
    consume(requestId) {
      purgeExpired();
      const g = grants.get(requestId);
      if (!g || g.consumed || Date.now() > g.expiresAt) return null;
      g.consumed = true;
      return g;
    },
    get(requestId) {
      purgeExpired();
      const g = grants.get(requestId);
      return g && !g.consumed ? g : null;
    },
    peek(requestId) {
      purgeExpired();
      return grants.get(requestId) ?? null;
    },
    revoke(requestId) {
      grants.delete(requestId);
    },
    size() {
      purgeExpired();
      return grants.size;
    },
  };
}
