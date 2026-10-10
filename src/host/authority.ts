/**
 * 工具执行授权 Authority
 *
 * 常驻宿主侧：签发一张带宿主令牌签名的 grant（绑定 document/session/requestId），
 * 并支持一次性校验/消费。agent loop 在调用工具前必须 verify + consume 成功，否则拒绝执行。
 */

import { createHostTokenAuthority, type HostTokenAuthority, type SecretRing } from './host-token';
import { createInMemoryGrantStore, type GrantStore, type IssueGrantInput, type ToolGrant } from './grant-store';

export interface VerifyResult {
  ok: boolean;
  grant?: ToolGrant;
  reason?: 'malformed' | 'bad-signature' | 'expired' | 'consumed' | 'not-found' | 'scope-mismatch';
}

export interface ToolAuthorityOptions {
  secret: string;
  /** v0.5：密钥环（提供后支持轮换，校验接受宽限期内的旧密钥）。 */
  secretRing?: SecretRing;
  tokenTtlMs?: number;
  grantTtlMs?: number;
  tokenAuthority?: HostTokenAuthority;
  store?: GrantStore;
}

export interface ToolAuthority {
  issueGrant(input: IssueGrantInput): Promise<string>;
  verifyGrant(token: string): Promise<VerifyResult>;
  consumeGrant(token: string): Promise<VerifyResult>;
  readonly hostToken: HostTokenAuthority;
}

export function createToolAuthority(options: ToolAuthorityOptions): ToolAuthority {
  const hostToken =
    options.tokenAuthority ?? createHostTokenAuthority(options.secretRing ?? options.secret, options.tokenTtlMs);
  const store = options.store ?? createInMemoryGrantStore(options.grantTtlMs);

  return {
    hostToken,
    async issueGrant(input) {
      const grant = store.issue(input);
      // envelope 自带过期时间，verify 时直接校验，不依赖嵌套 host token
      const envelope = {
        grantId: grant.grantId,
        documentId: grant.documentId,
        sessionId: grant.sessionId,
        requestId: grant.requestId,
        scope: grant.scope,
        origin: grant.origin,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
      };
      const payload = b64urlJson(envelope);
      const sig = await hostToken.signRaw(payload);
      // 两段式：envelopeB64.signature，signature 由 host 共享密钥保护
      return `${payload}.${sig}`;
    },
    async verifyGrant(token) {
      const parts = splitToken(token);
      if (!parts) return { ok: false, reason: 'malformed' };
      const okSig = await hostToken.verifyRaw(parts.payload, parts.sig);
      if (!okSig) return { ok: false, reason: 'bad-signature' };
      const env = parsePayload(parts.payload);
      if (!env) return { ok: false, reason: 'malformed' };
      if (typeof env.expiresAt === 'number' && Date.now() > env.expiresAt) return { ok: false, reason: 'expired' };
      const grant = store.get(env.requestId);
      if (!grant) return { ok: false, reason: 'not-found' };
      if (grant.consumed) return { ok: false, reason: 'consumed' };
      if (grant.scope !== env.scope) return { ok: false, reason: 'scope-mismatch' };
      return { ok: true, grant };
    },
    async consumeGrant(token) {
      const v = await this.verifyGrant(token);
      if (!v.ok || !v.grant) return v;
      const consumed = store.consume(v.grant.requestId);
      if (!consumed) return { ok: false, reason: 'consumed' };
      return { ok: true, grant: consumed };
    },
  };
}

function b64urlJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function parsePayload(s: string): { grantId: string; documentId: string; sessionId: string; requestId: string; scope: string; origin?: string; issuedAt?: number; expiresAt?: number } | null {
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
function splitToken(token: string): { payload: string; sig: string } | null {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  return { payload: token.slice(0, i), sig: token.slice(i + 1) };
}
