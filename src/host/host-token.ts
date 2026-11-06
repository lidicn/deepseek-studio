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

// ── TD-02：bootstrap grant（页面连 WS 的短期一次性凭据，替代明文 host token）──
//
// 背景：原实现把 config.token 注入外部页面（window.__studioHostToken），
// 页面（含第三方站点脚本）拿到即等于拿到宿主全权凭据。本模块改为：注入的是
// **60s、一次性、仅 ws-connect 权、绑 audience** 的 bootstrap grant，不再注入 token。
//
// 格式与 host-token 的 signRaw 一致：base64url(JSON(claims)) + "." + base64url(HMAC-SHA256(secret,payload))。
// tauri 侧（main.rs:issue_bootstrap_grant_rs）用同一 secret + 同算法签，host 侧无状态验签。
// 一次性消费靠 jti + host 进程内存已用集合；grant 本身 60s 过期兜底。

export interface BootstrapGrantClaims {
  readonly iss: 'deepseek-studio-host';
  readonly jti: string;
  readonly aud: string;
  readonly scope: 'ws-connect';
  readonly iat: number;
  readonly exp: number;
}

export const BOOTSTRAP_GRANT_SCOPE = 'ws-connect' as const;
export const DEFAULT_BOOTSTRAP_TTL_MS = 60_000;

export async function issueBootstrapGrant(
  authority: HostTokenAuthority,
  params: { aud: string; ttlMs?: number; now?: () => number; jti?: string },
): Promise<string> {
  const now = params.now ?? (() => Date.now());
  const ttl = params.ttlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
  const iat = now();
  const claims: BootstrapGrantClaims = {
    iss: 'deepseek-studio-host',
    jti: params.jti ?? randomJti(),
    aud: params.aud,
    scope: BOOTSTRAP_GRANT_SCOPE,
    iat,
    exp: iat + Math.max(0, ttl),
  };
  const payload = bufToB64url(toArrayBuffer(enc(JSON.stringify(claims))));
  const sig = await authority.signRaw(payload);
  return `${payload}.${sig}`;
}

function randomJti(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 一次性 jti 记账的容量口径（PM 裁定三十三 3，2026-11-06）。
 *
 * 为什么需要上界：批 N+1 之后「一个窗口一张券」变成「一次连接一张券」（P0 卡 (A)），
 * 不设上界就是**单调增长的 Set** —— 今天已经抓过四次「看着有上界、实际一直在涨」。
 *
 * 三条口径：
 *   1. 每次记账顺带清扫**已过期**的 jti（`exp` 在 `now` 之前）；
 *   2. 硬上界 1024：超出时按**最旧 exp** 淘汰；
 *   3. 触到硬上界**必须打一行 `level=warn`**（不许静默淘汰）。
 */
export const JTI_HARD_CAP = 1024;

/** `verifyBootstrapGrant` 只需要 has/add，故用最小接口（`Set<string>` 天然兼容）。 */
export interface JtiRegistry {
  has(jti: string): boolean;
  add(jti: string, expMs?: number): unknown;
}

/** 有界的一次性 jti 记账（过期清扫 + 硬上界 + 触顶告警）。 */
export class BoundedJtiSet implements JtiRegistry {
  private readonly map = new Map<string, number>();
  private warned = false;
  constructor(
    private readonly cap: number = JTI_HARD_CAP,
    private readonly log: (line: string) => void = (l) => console.log(l),
    private readonly now: () => number = () => Date.now(),
  ) {}

  has(jti: string): boolean {
    return this.map.has(jti);
  }

  add(jti: string, expMs?: number): void {
    const expiry = typeof expMs === 'number' ? expMs : this.now() + 60_000;
    this.pruneExpired();
    this.map.set(jti, expiry);
    if (this.map.size > this.cap) {
      this.evictOldest();
      if (!this.warned) {
        this.warned = true;
        this.log(
          `[host-token] level=warn jti-cap-reached cap=${this.cap} size=${this.map.size} —— 按最旧 exp 淘汰（不是静默丢弃）`,
        );
      }
    }
  }

  /** 清掉 `exp <= now` 的条目；返回清除数量（供单测断言「真的清了」）。 */
  pruneExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [jti, exp] of this.map) {
      if (exp <= now) {
        this.map.delete(jti);
        removed += 1;
      }
    }
    return removed;
  }

  /** 淘汰最旧 exp 的一条（只应在上界触发时调用）。 */
  private evictOldest(): void {
    let oldestJti: string | null = null;
    let oldestExp = Infinity;
    for (const [jti, exp] of this.map) {
      if (exp < oldestExp) {
        oldestExp = exp;
        oldestJti = jti;
      }
    }
    if (oldestJti !== null) this.map.delete(oldestJti);
  }

  get size(): number {
    return this.map.size;
  }
}

export interface VerifyBootstrapResult {
  readonly ok: boolean;
  readonly claims?: BootstrapGrantClaims;
  /**
   * 失败原因（封闭词表）。
   *
   * ⚠️ `absent` 与 `malformed` 必须分开（裁定五十八，2026-11-06 真机）：
   *   - `absent`    = 连接**根本没带券**（`?token=` 缺失 / 空串）。真机上的典型场景是
   *                   「取券失败 → 页面走回落路径 → 而 0.14.8 起建窗已不再注入静态券
   *                   （裁定四十一）⇒ **无静态券可拼**，回落拼出的是裸 URL（无 `?token=`）」。
   *                   **这不是券坏了，是没券**。
   *   - `malformed` = 带了券但结构不合法（无 `.` / 段解析失败）。
   * 合并成一个词会让人照 `bad-signature` 方向去查（真机上绕了两小时的正是这个歧义）。
   *
   * 注：`authority.ts` 里另有一套同名 `reason`，语义本来就是「串畸形」（`splitToken` 失败），
   * **不要跟着改** —— 两处同名不同义，是最容易改串的地方。
   */
  readonly reason?:
    | 'absent'
    | 'malformed'
    | 'bad-signature'
    | 'expired'
    | 'consumed'
    | 'scope-mismatch'
    | 'aud-mismatch';
}

export async function verifyBootstrapGrant(
  authority: HostTokenAuthority,
  presented: string | null,
  usedJtis: JtiRegistry,
  expectedAud: string,
  now: () => number = () => Date.now(),
): Promise<VerifyBootstrapResult> {
  // 裁定五十八：「没带券」与「券串畸形」必须分开（详见 VerifyBootstrapResult.reason 注释）。
  if (presented === null || presented === undefined || presented === '') {
    return { ok: false, reason: 'absent' };
  }
  const dot = presented.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const payload = presented.slice(0, dot);
  const sig = presented.slice(dot + 1);
  const okSig = await authority.verifyRaw(payload, sig);
  if (!okSig) return { ok: false, reason: 'bad-signature' };
  let claims: BootstrapGrantClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBuf(payload))) as BootstrapGrantClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.iss !== 'deepseek-studio-host' || typeof claims.jti !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.scope !== BOOTSTRAP_GRANT_SCOPE) return { ok: false, reason: 'scope-mismatch' };
  if (typeof claims.exp === 'number' && now() > claims.exp) return { ok: false, reason: 'expired' };
  if (claims.aud !== expectedAud) return { ok: false, reason: 'aud-mismatch' };
  if (usedJtis.has(claims.jti)) return { ok: false, reason: 'consumed' };
  usedJtis.add(claims.jti, typeof claims.exp === 'number' ? claims.exp : undefined);
  return { ok: true, claims };
}