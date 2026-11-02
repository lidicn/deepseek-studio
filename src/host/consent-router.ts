/**
 * consent-router.ts — 审批路由（E1）
 *
 * 输入：策略结论 + 上下文，输出 safe / ask / deny。
 * 纯函数，只 import type，不碰 fs、不读 env。
 */

import type { PolicyDecision, PolicyMode, PolicyReason } from './policy';
import {
  inlineCodeOf,
  resolveArgvFromParams,
  stripCmdWrapper,
  tokenizeCommandString,
} from '../shared/command-tokens';

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

/**
 * 硬拒绝地板：任何档位都拦，用户同意也不能覆盖。
 * A2 起对外导出：统一授权解析器复用同一张地板表，避免出现第二套硬拒绝定义。
 *
 * ── C1 P1 安全批 TD-03：地板必须看「真正会执行的 argv」 ──
 *
 * 缺陷（审计 TD-03，PM 核实成立）：原实现只读 `params.command` 字符串，
 * 且正则全部 `^` 锚定。而 `shell.exec`（src/capabilities/shell.ts）**优先使用
 * `params.argv`**，且 argv 形态**不经过** `hasShellSyntax` 检查。于是：
 *
 *   `{ argv: ['diskpart'] }`                    → 地板看到空 command → 放行；
 *   `{ argv: ['cmd', '/c', 'shutdown', '/s'] }` → 地板看到空 command → 放行；
 *   `{ command: 'node -e "<任意代码>"' }`       → 地板看到的是 `node -e ...`，不命中任何名单 → 放行。
 *
 * 承诺（policy.ts 头注释 + 本文件头注释）与实现不一致：
 * 「hard-deny（磁盘格式化/关机）即便 full 档也直接拒绝」——实际上 full 档下模型可无审批关机。
 *
 * 修法：地板改用**与执行侧同源**的取词（`src/shared/command-tokens.ts`），
 * 对「这次调用真正会执行的 argv」判定，并补三条原来缺失的判定：
 *   1. `cmd /c` **剥壳**后再判（否则 `shutdown` 藏在 `cmd` 后面）；
 *   2. 磁盘 / 电源命令按 **argv[0]** 判（不再 `^` 锚定整串，路径形态也能命中）；
 *   3. **内联代码**（`node -e` / `python -c` / `powershell -Command`）**载荷要展开判定**
 *      —— 内联载荷就是任意代码，它让「argv[0] 看着无害」失去意义。
 *
 * 内联载荷的判定分两种（**刻意不同，因产品现状不同**）：
 *   - `node -e` / `python -c` / `powershell -EncodedCommand`
 *     → **一律硬拒**（`inline-code`）。前两者是 PM 的验收口径「`node -e <任意>` 被硬拒」；
 *       `-EncodedCommand` 的载荷是 base64，**不可读**，无法判定 → 只能拒。
 *   - `powershell -Command <载荷>`
 *     → **展开载荷后再判**：载荷里命中地板名单 → 硬拒（按命中的那条规则报）；
 *       载荷本身还是内联代码 → 同样硬拒。
 *     为什么不一刀切：产品提示词明确要求模型「优先用 PowerShell」
 *     （src/inject/main-world-interceptor.ts:802），一刀切会让 Windows 上的
 *     shell_exec 基本不可用 —— 那是**产品语义变更**，不在本卡授权范围内。
 *     展开判定已经堵住了「用 PowerShell 藏危险命令」这个真正的洞。
 */
export function checkHardDeny(
  toolId: string,
  params: Readonly<Record<string, unknown>>,
  realPath: string | null | undefined,
): string | null {
  // 进程类工具：按「真正会执行的 argv」判。
  const argv = executableArgvOf(toolId, params);
  if (argv) {
    // 内联代码（一律拒）只适用于 **shell.exec**。
    // mcp.test / mcp.save 的启动命令是**用户自己填的**（UI 表单），且这两个工具
    // 不在模型的工具表里（tool-contract 的 UI_ONLY_TOOLS）→ 模型够不着。
    // 而 `node -e "<脚本>"` 恰恰是**合法的 MCP server 启动形态**
    // （审计 R2-04 的验收场景就是用一个 `node -e "setInterval(...)"` 假服务器）——
    // 一刀切会把用户的 MCP 配置打死。
    // 故：mcp.* 仍然判磁盘/电源/盘根删除（这些意图明确、无歧义），
    // 但**不**因「内联代码」被拒。
    const rule = hardDenyFromArgv(argv, { allowInlineCode: toolId !== 'shell.exec' });
    if (rule) return rule;
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

/**
 * 取「这次调用真正会执行的 argv」；不适用该工具时返回 null。
 *
 * 与执行侧逐条对齐：
 *   - `shell.exec` → `params.argv` 优先，否则 `params.command`（见 shell.ts execute）；
 *   - `mcp.test`  → `params.config.command` + `params.config.args`（见 desktop-host.ts）；
 *   - `mcp.save`  → 同上（写盘后由 connectStdio 真正 spawn，见 mcp-controller.ts）。
 *
 * 为什么要覆盖 mcp.*：`mcp.test` 会**真的 spawn**，`mcp.save` 写下的配置
 * 会在下次 connect 时被 `connectStdio` **真的 spawn** —— 两处都不经过 shell.exec，
 * 但危害与 TD-03 完全同构（`command: 'node', args: ['-e', '<任意>']`）。
 */
export function executableArgvOf(
  toolId: string,
  params: Readonly<Record<string, unknown>>,
): string[] | null {
  if (toolId === 'shell.exec') {
    return resolveArgvFromParams(params);
  }
  if (toolId === 'mcp.test' || toolId === 'mcp.save') {
    const config = params.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    const bag = config as Record<string, unknown>;
    const command = typeof bag.command === 'string' ? bag.command : '';
    if (!command.trim()) return null;
    const args = Array.isArray(bag.args) ? bag.args.map(String) : [];
    return [command, ...args];
  }
  return null;
}

/** 磁盘级破坏的命令名（argv[0] 口径）。 */
const DISK_COMMANDS = new Set(['format', 'mkfs', 'mkfs.ext4', 'diskpart']);
/** 电源控制的命令名（argv[0] 口径）。 */
const POWER_COMMANDS = new Set([
  'shutdown', 'reboot', 'halt', 'stop-computer', 'restart-computer',
]);
/** 盘根递归删除的命令名（argv[0] 口径）。 */
const ROOT_DELETE_COMMANDS = new Set(['rm', 'rmdir', 'remove-item', 'del', 'erase']);

/** 取 argv[0] 的「命令名」：去目录、去 .exe/.cmd/.bat 后缀、转小写。 */
function commandNameOf(argv0: string): string {
  return argv0
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/, '');
}

/**
 * 对一组 argv 判硬拒绝规则。返回规则 id 或 null。
 *
 * 判定顺序（先判命令名，再判内联载荷）：
 *   1. 剥 `cmd /c` 外壳；
 *   2. 磁盘 / 电源 / 盘根递归删除（按 argv[0] + 目标）；
 *   3. 内联代码：node/python/-EncodedCommand 一律拒；`-Command <载荷>` 展开后再判。
 *
 * `allowInlineCode`：为 true 时**跳过**「内联代码一律拒」这一条
 * （只保留磁盘/电源/盘根删除的判定）。用于 mcp.test / mcp.save ——
 * 它们的启动命令由用户在 UI 里自己填，且 `node -e "<脚本>"` 是合法的
 * MCP server 启动形态（审计 R2-04 的假服务器场景就是它）。
 */
export function hardDenyFromArgv(
  argv: readonly string[],
  options: { allowInlineCode?: boolean } = {},
): string | null {
  return hardDenyFromArgvDepth(argv, 0, options.allowInlineCode === true);
}

function hardDenyFromArgvDepth(
  argv: readonly string[],
  depth: number,
  allowInlineCode: boolean,
): string | null {
  if (argv.length === 0) return null;
  // 深度上限：内联载荷里再套内联载荷最多展开 3 层，防止构造出无限递归。
  if (depth > 3) return 'inline-code';

  const stripped = stripCmdWrapper(argv);
  if (stripped.length === 0) return null;

  const name = commandNameOf(stripped[0]);

  // 磁盘级破坏
  if (DISK_COMMANDS.has(name)) return 'dangerous-disk';
  if (name === 'dd' && stripped.some((a) => /^if=/i.test(a))) return 'dangerous-disk';

  // 电源控制
  if (POWER_COMMANDS.has(name)) return 'power-control';

  // 盘根递归删除：目标必须确实指向盘根
  if (ROOT_DELETE_COMMANDS.has(name)) {
    const target = stripped[stripped.length - 1] ?? '';
    if (/^[CDEF]:[\\/]?$/.test(target) || target === '/') return 'recursive-root-delete';
  }

  // 内联代码
  const inline = inlineCodeOf(stripped);
  if (inline === null) return null;

  // 允许内联代码的场景（mcp.*）：载荷里的危险命令仍要判，但「内联」本身不拒。
  if (allowInlineCode) {
    const inner = hardDenyFromArgvDepth(tokenizeCommandString(inline), depth + 1, allowInlineCode);
    if (inner && inner !== 'inline-code') return inner;
    return hardDenyFromInlineText(inline);
  }

  // node -e / python -c / powershell -EncodedCommand → 一律硬拒
  if (name !== 'powershell' && name !== 'pwsh') return 'inline-code';
  if (stripped.some((a) => /^-encodedcommand$/i.test(a))) return 'inline-code';

  // powershell -Command <载荷>：展开载荷后再判（载荷本身仍是内联代码 → 拒）
  if (inline === '') return 'inline-code';
  const inner = hardDenyFromArgvDepth(tokenizeCommandString(inline), depth + 1, allowInlineCode);
  if (inner) return inner;
  // 载荷里以「字符串参数」形式藏危险命令（如 execSync('shutdown /s')）→ 按词边界扫一遍
  return hardDenyFromInlineText(inline);
}

/**
 * 内联载荷的**文本**兜底扫描：载荷里出现危险命令名（词边界）即硬拒。
 *
 * 为什么需要：`powershell -Command "node -e \"require('child_process').execSync('shutdown /s')\""`
 * 这类载荷里 `shutdown` 不是独立 token（它在引号内、还嵌在函数调用里），
 * 按 argv 取词取不到 → 只能按文本词边界扫。
 */
export function hardDenyFromInlineText(text: string): string | null {
  if (!text) return null;
  if (/\b(?:format|mkfs(?:\.\w+)?|diskpart)\b/i.test(text)) return 'dangerous-disk';
  if (/\b(?:shutdown|reboot|halt)\b/i.test(text)) return 'power-control';
  if (/stop-computer|restart-computer/i.test(text)) return 'power-control';
  if (
    /\b(?:rm|rmdir|remove-item|del|erase)\b[^\n]{0,80}?\b[CDEF]:[\\/]?\s*$/i.test(text)
    || /\b(?:rm|rmdir|remove-item|del|erase)\b[^\n]{0,80}?\s\/[^\n]{0,40}?\s$/i.test(text)
  ) {
    return 'recursive-root-delete';
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
