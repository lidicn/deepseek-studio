/**
 * Bearer 鉴权：本机 agent loop / 客户端必须带 Authorization: Bearer <token>。
 * 缺失或错误 → 401（fail-closed）。
 *
 * v0.5 变更（5.1 令牌轮换）：
 * 过去 `createBearerAuthenticator(token)` 在构造期固化一个字符串，导致
 * 「轮换」只能靠重启进程，且旧令牌会立刻失效、把正在跑的客户端全部打断。
 * 现在接受「取令牌的函数」：每请求重新取一次当前可接受的令牌集合，
 * 于是轮换期可以**同时**接受新令牌与仍在宽限期内的旧令牌。
 */

/** 令牌来源：字面量（兼容旧用法）或每请求求值的函数（轮换用）。 */
export type TokenSource = string | (() => Iterable<string>);

export interface Authenticator {
  authenticate(authHeader: string | undefined): boolean;
}

function enc(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** 常量时间比较，避免时序侧信道。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * 构造鉴权器。
 * - 传字符串：等价于固定单一令牌（向后兼容）。
 * - 传函数：返回当前可接受的全部令牌（新令牌 + 宽限期内的旧令牌）；
 *   函数抛错或返回空集合 → 一律拒绝（fail-closed，轮换出错不会放行）。
 */
export function createBearerAuthenticator(source: TokenSource): Authenticator {
  const candidates = (): readonly string[] => {
    if (typeof source === 'string') return [source];
    try {
      return [...source()].filter((t) => typeof t === 'string' && t.length > 0);
    } catch {
      return [];
    }
  };

  return {
    authenticate(header) {
      if (!header) return false;
      const presented = enc(header);
      for (const token of candidates()) {
        if (timingSafeEqual(presented, enc(`Bearer ${token}`))) return true;
      }
      return false;
    },
  };
}
