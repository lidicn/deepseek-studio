/**
 * 桌面平台适配：常驻 JS 宿主充当工具执行授权方
 *
 * 替代 MV3 background SW。agent loop 调用 requestToolExecution 拿到一次性 grant token；
 * 真正执行工具前必须对端 consumeGrant 成功，否则拒绝。host 侧持有密钥，页面/注入脚本拿不到。
 */

import { createToolAuthority, type ToolAuthority, type VerifyResult } from './authority';
import type { SecretRing } from './host-token';
import type { IssueGrantInput } from './grant-store';

export interface PlatformDesktopOptions {
  secret: string;
  /** v0.5：密钥环（与 secret 二选一，优先 secretRing）。 */
  secretRing?: SecretRing;
  tokenTtlMs?: number;
  grantTtlMs?: number;
}

export interface PlatformDesktop {
  /** 签发一张一次性 tool grant（常驻宿主侧调用）。 */
  requestToolExecution(input: IssueGrantInput): Promise<string>;
  /** 校验 grant（不消费）。 */
  verify(token: string): Promise<VerifyResult>;
  /** 一次性消费 grant。 */
  consume(token: string): Promise<VerifyResult>;
  readonly authority: ToolAuthority;
}

export function createPlatformDesktop(options: PlatformDesktopOptions): PlatformDesktop {
  const authority = createToolAuthority({
    secret: options.secret,
    secretRing: options.secretRing,
    tokenTtlMs: options.tokenTtlMs,
    grantTtlMs: options.grantTtlMs,
  });
  return {
    authority,
    requestToolExecution: (input) => authority.issueGrant(input),
    verify: (token) => authority.verifyGrant(token),
    consume: (token) => authority.consumeGrant(token),
  };
}
