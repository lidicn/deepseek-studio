/**
 * consent-router.ts — 审批路由（E1）
 *
 * 输入：策略结论 + 上下文，输出 safe / ask / deny。
 * 纯函数，只 import type，不碰 fs、不读 env。
 */

import type { PolicyDecision, PolicyMode, PolicyReason } from './policy';

export type ConsentVerdict = 'safe' | 'ask' | 'deny';

export type ActionKind =
  | 'read' | 'list' | 'stat'
  | 'search-list' | 'search-grep'
  | 'edit' | 'write' | 'append'
  | 'exec' | 'rollback' | 'other';

export type RouteReason =
  | 'policy-deny'
  | 'hard-deny'
  | 'policy-allow'
  | 'whitelist-hit'
  | 'whitelist-expired'
  | 'whitelist-absent'
  | 'outside-workspace'
  | 'action-mismatch'
  | 'not-governed';

export interface WhitelistEntry {
  readonly id: string;
  readonly toolId: string;
  readonly action: ActionKind;
  readonly pathPattern: string;
  readonly workspaceHash: string;
  readonly createdAt: number;
  readonly ttlMs?: number;
  readonly note?: string;
}

export interface ConsentRouteInput {
  readonly toolId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly mode: PolicyMode;
  readonly policy: PolicyDecision;
  readonly policyReason: PolicyReason;
  readonly resolvedPath: string | null;
  readonly realPath?: string | null;
  readonly relPath: string | null;
  readonly outside: boolean;
  readonly workspaceRoot: string | null;
  readonly workspaceHash: string;
  readonly whitelist: readonly WhitelistEntry[];
  readonly now: number;
}

export interface ConsentRouteResult {
  readonly verdict: ConsentVerdict;
  readonly reason: RouteReason;
  readonly action: ActionKind;
  readonly matchedEntryId?: string;
  readonly hardRule?: string;
}

/** 按工具 id + params 分类动作。 */
export function classifyAction(toolId: string, params: Readonly<Record<string, unknown>>): ActionKind {
  switch (toolId) {
    case 'file.read': return 'read';
    case 'file.list': return 'list';
    case 'file.stat': return 'stat';
    case 'file.edit': return 'edit';
    case 'file.write':
      return params.append === true ? 'append' : 'write';
    case 'search_files':
      return params.operation === 'grep' ? 'search-grep' : 'search-list';
    case 'shell.exec': return 'exec';
    case 'shadow.rollback': return 'rollback';
    default: return 'other';
  }
}

/** 硬拒绝地板：任何档位都拦，用户同意也不能覆盖。 */
function checkHardDeny(
  toolId: string,
  params: Readonly<Record<string, unknown>>,
  realPath: string | null | undefined,
): string | null {
  // 磁盘级破坏
  if (toolId === 'shell.exec') {
    const cmd = typeof params.command === 'string' ? params.command : '';
    if (/^(format|mkfs|diskpart)\b/i.test(cmd)) return 'dangerous-disk';
    if (/^shutdown\b|^reboot\b|^halt\b|^Stop-Computer\b|^Restart-Computer\b/i.test(cmd)) return 'power-control';
    // 盘根递归删除
    if (/^(rm|rmdir|Remove-Item|del|erase)\b/i.test(cmd)) {
      // 简化：只拦明确的盘根目标
      if (/[CDEF]:[\\/]?\s*$/.test(cmd)) return 'recursive-root-delete';
    }
  }

  // 敏感路径写入
  if (realPath) {
    const lower = realPath.toLowerCase();
    if (/^c:\\windows\\/.test(lower)
      || /^c:\\program files\\/.test(lower)
      || /^\/etc\//.test(lower)
      || /^\/usr\//.test(lower)
      || /^\/bin\//.test(lower)
      || /^\/sbin\//.test(lower)
      || /~\/\.ssh\//.test(lower)
      || /~\/\.aws\//.test(lower)
    ) return 'sensitive-path';
  }

  return null;
}

/** glob 匹配：支持 * （不跨 /）、**（跨目录）、?（单字符）。 */
function globMatch(pattern: string, relPath: string): boolean {
  // 拒绝绝对路径、盘符、.. 段
  if (pattern.startsWith('/') || /^[a-zA-Z]:/.test(pattern) || pattern.includes('..')) return false;

  // 转义正则特殊字符，再把 glob 语法转回去
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regex}$`).test(relPath);
}

/** 白名单匹配。 */
function matchWhitelist(
  entries: readonly WhitelistEntry[],
  q: { toolId: string; action: ActionKind; relPath: string | null; outside: boolean; workspaceHash: string; now: number },
): { hit: true; entry: WhitelistEntry } | { hit: false; reason: 'whitelist-absent' | 'whitelist-expired' | 'action-mismatch' | 'outside-workspace' } {
  if (q.outside) return { hit: false, reason: 'outside-workspace' };
  if (!q.relPath) return { hit: false, reason: 'outside-workspace' };

  for (const e of entries) {
    if (e.workspaceHash !== q.workspaceHash) continue;
    if (e.toolId !== q.toolId) continue;
    if (e.action !== q.action) return { hit: false, reason: 'action-mismatch' };
    if (e.ttlMs && q.now - e.createdAt > e.ttlMs) return { hit: false, reason: 'whitelist-expired' };
    if (globMatch(e.pathPattern, q.relPath)) return { hit: true, entry: e };
  }
  return { hit: false, reason: 'whitelist-absent' };
}

/** 主路由函数。 */
export function routeConsent(input: ConsentRouteInput): ConsentRouteResult {
  const action = classifyAction(input.toolId, input.params);

  // 1. 策略已拒，透传
  if (input.policy === 'deny') {
    return { verdict: 'deny', reason: 'policy-deny', action };
  }

  // 2. 硬拒绝地板（policy 为 allow 时也要执行）
  const hard = checkHardDeny(input.toolId, input.params, input.realPath);
  if (hard) {
    return { verdict: 'deny', reason: 'hard-deny', action, hardRule: hard };
  }

  // 3. 策略已放行
  if (input.policy === 'allow') {
    return { verdict: 'safe', reason: 'policy-allow', action };
  }

  // 4. 需要同意
  if (input.policy === 'require-consent') {
    // 4.1 越界永不白名单
    if (input.outside) {
      return { verdict: 'ask', reason: 'outside-workspace', action };
    }
    // 4.2 白名单命中
    const m = matchWhitelist(input.whitelist, {
      toolId: input.toolId,
      action,
      relPath: input.relPath,
      outside: input.outside,
      workspaceHash: input.workspaceHash,
      now: input.now,
    });
    if (m.hit) {
      return { verdict: 'safe', reason: 'whitelist-hit', action, matchedEntryId: m.entry.id };
    }
    return { verdict: 'ask', reason: m.reason, action };
  }

  // 5. 非治理工具
  return { verdict: 'safe', reason: 'not-governed', action };
}
