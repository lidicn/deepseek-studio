/**
 * 宿主令牌（host token）
 *
 * 常驻 JS 宿主（Tauri 主进程 / 桌面后台）持有的权威凭证。桌面没有 MV3 background SW，
 * 工具执行授权由常驻宿主签发（P0-#3 推荐方案）。token = base64url(claims).hmac，
 * 用共享密钥做 HMAC-SHA256（Web Crypto，浏览器/Node 通用）。
 */

export interface HostTokenClaims {
  readonly iss: 'deepseek-studio-host';
  readonly iat: number;
  readonly exp: number;
}

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
/** 新 lib 下 Uint8Array 为泛型，crypto 需要 BufferSource（ArrayBuffer 视图），这里统一转换。 */
function buf(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
function bufToB64url(buf: ArrayBufferLike): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 密钥环（v0.5，5.1 令牌轮换）
 *
 * 轮换 semantics：新密钥立即生效，旧密钥在宽限期内**仍然被接受**。
 * 这样在轮换瞬间已签发出去的 grant 不会因为「签发用旧密钥、校验用新密钥」而被误拒——
 * 那会让正在执行的 agent 链路在无人知情的情况下断掉。
 */
export interface SecretRing {
  /** 当前生效密钥（用于签名）。 */
  readonly current: string;
  /** 当前可接受的密钥集合（新 + 仍在宽限期内的旧）。 */
  readonly accepted: readonly string[];
  /** 仍处宽限期的上一个密钥，没有则 null。 */
  readonly previous: string | null;
  /** 轮换到 next（缺省生成随机密钥），返回新密钥。 */
  rotate(next?: string): string;
}

export const DEFAULT_SECRET_GRACE_MS = 10 * 60_000;

function randomSecret(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createSecretRing(
  initial: string,
  graceMs: number = DEFAULT_SECRET_GRACE_MS,
  now: () => number = () => Date.now(),
): SecretRing {
  let current = initial;
  let previous: string | null = null;
  let previousExpiresAt = 0;

  return {
    get current() {
      return current;
    },
    get previous() {
      return now() < previousExpiresAt ? previous : null;
    },
    get accepted() {
      const list = [current];
      if (previous && now() < previousExpiresAt) list.push(previous);
      return list;
    },
    rotate(next) {
      const fresh = next && next.length > 0 ? next : randomSecret();
      if (fresh === current) return current; // 无意义轮换：不制造假的「已轮换」
      previous = current;
      previousExpiresAt = now() + Math.max(0, graceMs);
      current = fresh;
      return current;
    },
  };
}

export interface HostTokenAuthority {
  sign(claims: Omit<HostTokenClaims, 'iss'>): Promise<string>;
  verify(token: string): Promise<HostTokenClaims | null>;
  /** 对任意字符串做 HMAC-SHA256（用于签发 grant 这类「数据 + 签名」两段式令牌）。 */
  signRaw(message: string): Promise<string>;
  verifyRaw(message: string, signature: string): Promise<boolean>;
  readonly secret: string;
}

/**
 * 传入字符串 = 固定单密钥（向后兼容）；
 * 传入 SecretRing = 支持轮换，签名用 current、校验接受 current + 宽限期内的 previous。
 */
export function createHostTokenAuthority(
  secret: string | SecretRing,
  _defaultTtlMs = 10 * 60_000,
): HostTokenAuthority {
  const ring = typeof secret === 'string' ? createSecretRing(secret) : secret;
  const keyCache = new Map<string, Promise<CryptoKey>>();
  const importKey = (s: string): Promise<CryptoKey> => {
    const cached = keyCache.get(s);
    if (cached) return cached;
    const p = crypto.subtle.importKey('raw', buf(enc(s)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(s, p);
    return p;
  };
  const getKey = (): Promise<CryptoKey> => importKey(ring.current);
  const getAcceptedKeys = (): Promise<CryptoKey>[] => ring.accepted.map(importKey);

  return {
    get secret() {
      return ring.current;
    },
    async sign(claims) {
      const full: HostTokenClaims = { iss: 'deepseek-studio-host', ...claims };
      const payload = bufToB64url(toArrayBuffer(enc(JSON.stringify(full))));
      const key = await getKey();
      const sig = bufToB64url(await crypto.subtle.sign('HMAC', key, buf(enc(payload))));
      return `${payload}.${sig}`;
    },
    async verify(token) {
      const dot = token.indexOf('.');
      if (dot < 0) return null;
      const payload = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      const keys = await Promise.all(getAcceptedKeys());
      for (const key of keys) {
        const ok = await crypto.subtle.verify('HMAC', key, buf(b64urlToBuf(sig)), buf(enc(payload)));
        if (!ok) continue;
        try {
          const claims = JSON.parse(new TextDecoder().decode(b64urlToBuf(payload))) as HostTokenClaims;
          if (claims.iss !== 'deepseek-studio-host') return null;
          if (typeof claims.exp === 'number' && Date.now() > claims.exp) return null;
          return claims;
        } catch {
          return null;
        }
      }
      return null;
    },
    async signRaw(message) {
      const key = await getKey();
      return bufToB64url(await crypto.subtle.sign('HMAC', key, buf(enc(message))));
    },
    async verifyRaw(message, signature) {
      // 任一可接受密钥验过即通过（轮换期旧 grant 不被误拒）
      for (const key of await Promise.all(getAcceptedKeys())) {
        if (await crypto.subtle.verify('HMAC', key, buf(b64urlToBuf(signature)), buf(enc(message)))) return true;
      }
      return false;
    },
  };
}

/**
 * QD-R2-12：WS query token 校验共享 helper。
 * - source 是字符串 = 固定单 token（兼容旧用法）；
 * - source 是函数 = 每连接求值的 accepted 集合（轮换环）；
 * - candidates 为空 / 空串 → 返回 false（fail-closed，不再等于「不校验」）；
 * - 比较走常数时间，避免时序侧信道。
 *
 * 同时用于 /studio（page-runtime）与 /agent-ws（agent-channel），两处必须一致。
 */
export type WSQueryTokenSource = string | (() => Iterable<string>);

export function verifyWsQueryToken(
  presented: string | null,
  source: WSQueryTokenSource | undefined,
): boolean {
  if (!presented || !source) return false;
  const candidates: readonly string[] = typeof source === 'function'
    ? [...source()].filter((t) => typeof t === 'string' && t.length > 0)
    : [source].filter((t) => t.length > 0);
  if (candidates.length === 0) return false;
  const enc = (s: string) => {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  };
  const a = enc(presented);
  for (const cand of candidates) {
    const b = enc(cand);
    if (a.length !== b.length) continue;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff === 0) return true;
  }
  return false;
}
