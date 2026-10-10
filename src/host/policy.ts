/**
 * 命令/文件访问多档策略引擎（v0.5 → v0.7 M1 三档）
 *
 * 面板三档口径（用户选定，2026-10-10 需求访谈）：
 *   1. workspace 仅工作区——文件读写限于工作区内，shell 与越界一律硬拒绝
 *   2. auto    风险审批——工作区内读/写自动放行，仅 shell / 删除 / 越界等风险弹审批（默认档）
 *   3. full    完全放开——不询问，仅审计
 * 旧档 ask（询问审批：shell 无风险也审批）保留为合法值以兼容既有配置与测试，
 * 但面板 UI 只暴露上面三档。
 *
 * 判定矩阵：
 * | 档位      | 文件·工作区内 | 文件·工作区外 | shell·无风险 | shell·命中风险 |
 * |-----------|--------------|--------------|-------------|---------------|
 * | workspace | 放行         | 拒绝         | 拒绝        | 拒绝          |
 * | ask       | 放行         | 审批         | 审批        | 审批          |
 * | auto      | 放行         | 审批         | 放行        | 审批          |
 * | full      | 放行         | 放行         | 放行        | 放行          |
 *
 * 两条不可协商的红线（即便 full 档也保持）：
 *   1. shell 一律 argv 执行，启用 full 也不会打开 shell 解释器——
 *      「完全访问」绝不能顺带变成「命令注入可用」。
 *   2. 未配置工作区时，所有文件类工具 deny（fail-closed）。
 *      宁可让能力完全不可用，也不能隐式把某个目录当成可信工作区。
 */

import path from 'node:path';
import type { WorkspaceContext } from './workspace';

const pathResolve = (p: string) => path.resolve(p);
const pathSep = path.sep;

export type PolicyMode = 'workspace' | 'ask' | 'auto' | 'full';

export const POLICY_MODES: readonly PolicyMode[] = ['workspace', 'ask', 'auto', 'full'];

/** 面板 UI 暴露的三档（ask 为旧档，不在 UI 中出现）。 */
export const PANEL_POLICY_MODES: readonly PolicyMode[] = ['workspace', 'auto', 'full'];

export const DEFAULT_POLICY_MODE: PolicyMode = 'auto';

/** 档位展示名（下发页端前已翻译，注入产物不必引入本模块做枚举映射）。 */
export const POLICY_MODE_LABELS: Readonly<Record<PolicyMode, string>> = {
  workspace: '仅工作区',
  ask: '询问审批',
  auto: '风险审批',
  full: '完全放开',
};

export function isPolicyMode(value: unknown): value is PolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value);
}

export type PolicyDecision =
  /** 放行，无需再弹同意。 */
  | 'allow'
  /** 需要用户同意（交给现有页端 consent 闸门）。 */
  | 'require-consent'
  /** 硬拒绝，不由用户决定（如工作区未配置）。 */
  | 'deny';

export type PolicyReason =
  | 'inside-workspace'
  | 'outside-workspace'
  | 'trusted-dir'
  | 'risk-detected'
  /** ask 档下 shell 未命中风险也仍需审批（用户口径「其余审批」）。 */
  | 'requires-approval'
  /** workspace 档：该类操作被档位本身禁止（shell / 越界文件访问）。 */
  | 'mode-restricted'
  | 'workspace-unconfigured'
  | 'missing-path'
  | 'missing-command'
  | 'not-governed';

export interface PolicyVerdict {
  readonly decision: PolicyDecision;
  readonly reason: PolicyReason;
  /** 命中的风险标记 id（仅 risk-detected 时有值），用于 UI 展示与审计。 */
  readonly riskFlags?: readonly string[];
  readonly detail?: string;
}

export interface PolicyInput {
  readonly tool: string;
  readonly params: Record<string, unknown>;
  readonly mode: PolicyMode;
  /** 工作区上下文；null 表示未配置（文件类工具将被 deny）。 */
  readonly workspace: WorkspaceContext | null;
  /** v0.9：额外可信目录列表（除 workspace 外自动放行的目录）。 */
  readonly trustedDirs?: readonly string[];
}

/** 文件类工具（受工作区边界约束）。 */
export const FILE_TOOLS: readonly string[] = ['file.read', 'file.write', 'file.list', 'file.stat'];
/** 进程执行类工具。 */
export const PROCESS_TOOLS: readonly string[] = ['shell.exec'];

export function isFileTool(tool: string): boolean {
  return FILE_TOOLS.includes(tool);
}

export function isProcessTool(tool: string): boolean {
  return PROCESS_TOOLS.includes(tool);
}

/**
 * 风险命令模式。
 * 每条给出可读 id（用于 UI 与审计），正则尽量窄以避免误伤常规命令。
 */
export interface RiskPattern {
  readonly id: string;
  readonly label: string;
  readonly pattern: RegExp;
}

export const RISK_PATTERNS: readonly RiskPattern[] = [
  // 注意：选项前的”-” 是非单词字符，用 \b 包裹选项会导致完全匹配不上
  // （测试曾暴露：rm -rf 一条都识别不出）。这里显式用空白界定选项。
  { id: 'destructive-delete', label: '递归删除', pattern: /\b(rm|rmdir|del|erase)\b[^\n]{0,80}?(?:\s-{1,2}[a-zA-Z]*[rf][a-zA-Z]*|\s\/[sf]\b)/i },
  { id: 'powershell-force-delete', label: 'PowerShell 强制删除', pattern: /Remove-Item[\s\S]*-(Recurse|Force)/i },
  { id: 'disk-format', label: '格式化/磁盘写入', pattern: /\b(format|mkfs|diskpart)\b|\bdd\s+if=/i },
  { id: 'privilege-elevation', label: '提权执行', pattern: /\b(sudo|runas|gsudo|doas)\b|Start-Process[\s\S]*-Verb\s+RunAs/i },
  { id: 'credential-path', label: '敏感凭据路径', pattern: /(\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.netrc|\.git-credentials|\.gnupg)/i },
  { id: 'system-path', label: '系统目录写入', pattern: /(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/System\/|\/Library\/|C:\\Windows|C:\\Program\s*Files)/i },
  { id: 'pipe-to-interpreter', label: '下载管道到解释器', pattern: /(curl|wget|Invoke-WebRequest|iwr)[\s\S]*\|\s*(sh|bash|zsh|python|powershell|pwsh|iex)/i },
  { id: 'dynamic-eval', label: '动态执行注入', pattern: /\b(eval|Invoke-Expression|iex)\s*\(?/i },
  { id: 'git-destructive', label: 'Git 破坏性操作', pattern: /git\s+(push[\s\S]*(--force|-f\b)|reset\s+--hard|clean\s+-fd|checkout\s+--\s+\.)/i },
  { id: 'power-control', label: '系统关机/重启', pattern: /\b(shutdown|reboot|halt|init\s+0)\b|Stop-Computer|Restart-Computer/i },
];

/** 检测命令是否命中风险模式，返回全部命中标记 id。 */
export function detectRisks(command: string): string[] {
  const hits: string[] = [];
  for (const r of RISK_PATTERNS) {
    if (r.pattern.test(command)) hits.push(r.id);
  }
  return hits;
}

export function riskLabel(id: string): string {
  return RISK_PATTERNS.find((r) => r.id === id)?.label ?? id;
}

function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * 取出用于风险检测的命令文本。优先级：command > cmd > argv 数组（安全写法）。
 * argv 以空格拼接仅用于模式匹配，不改变真实执行方式（执行侧始终用 argv）。
 */
function commandText(params: Record<string, unknown>): string | null {
  const direct = firstString(params, ['command', 'cmd']);
  if (direct) return direct;
  const argv = params.argv;
  if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string')) {
    return (argv as string[]).join(' ');
  }
  return null;
}

/**
 * 策略判定入口。纯函数、无副作用，便于单测覆盖整张矩阵。
 */
export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const { tool, params, mode, workspace } = input;

  // —— 文件类：受工作区边界约束 ——
  if (isFileTool(tool)) {
    if (!workspace) {
      // fail-closed：没有可信工作区定义时，文件系统能力整体不可用。
      return { decision: 'deny', reason: 'workspace-unconfigured' };
    }
    const target = firstString(params, ['path', 'filePath', 'target']);
    if (!target) return { decision: 'deny', reason: 'missing-path' };

    const inside = workspace.contains(target);
    if (inside) return { decision: 'allow', reason: 'inside-workspace' };
    // v0.9：额外可信目录内也自动放行（与 workspace 同等信任）。
    if (input.trustedDirs?.length) {
      const resolved = pathResolve(target);
      for (const dir of input.trustedDirs) {
        if (resolved.startsWith(pathResolve(dir) + pathSep) || resolved === pathResolve(dir)) {
          return { decision: 'allow', reason: 'trusted-dir', detail: dir };
        }
      }
    }
    // 工作区外：workspace 档硬拒绝（档位语义就是「不越界」）；ask / auto 审批；full 放行。
    if (mode === 'workspace') return { decision: 'deny', reason: 'mode-restricted', detail: target };
    if (mode === 'full') return { decision: 'allow', reason: 'outside-workspace' };
    return { decision: 'require-consent', reason: 'outside-workspace', detail: target };
  }

  // —— 进程执行类：受风险模式约束 ——
  if (isProcessTool(tool)) {
    // 必须同时支持 argv 数组：那是最安全的调用形式，
    // 若只认 command 字符串，最安全的用法反而会被 missing-command 拦掉。
    const command = commandText(params);
    if (!command) return { decision: 'deny', reason: 'missing-command' };

    // 显式指定 cwd 且落在工作区外 → 视同越界文件访问。
    const cwd = firstString(params, ['cwd', 'workdir']);
    const outsideCwd = cwd && workspace && !workspace.contains(cwd);
    const risks = detectRisks(command);

    if (mode === 'workspace') {
      // 仅工作区档：shell 一律硬拒绝——该档位的承诺是「只动工作区内的文件」。
      return {
        decision: 'deny',
        reason: 'mode-restricted',
        riskFlags: risks,
        detail: outsideCwd ? cwd : undefined,
      };
    }

    if (mode === 'ask') {
      // ask 档：命令一律征询同意，但 reason 要如实反映「为什么需要审批」，
      // 否则审计里会把「常规命令也要审批」误记成「越界」。
      const reason: PolicyReason = risks.length > 0 ? 'risk-detected' : outsideCwd ? 'outside-workspace' : 'requires-approval';
      return {
        decision: 'require-consent',
        reason,
        riskFlags: risks,
        detail: outsideCwd ? cwd : undefined,
      };
    }

    if (mode === 'auto') {
      if (risks.length > 0) return { decision: 'require-consent', reason: 'risk-detected', riskFlags: risks };
      if (outsideCwd) return { decision: 'require-consent', reason: 'outside-workspace', detail: cwd };
      return { decision: 'allow', reason: 'inside-workspace', riskFlags: [] };
    }

    // full 档：用户明确选择不再询问 → 放行，但如实记录命中了什么风险，保证审计可追溯。
    return {
      decision: 'allow',
      reason: risks.length > 0 ? 'risk-detected' : outsideCwd ? 'outside-workspace' : 'inside-workspace',
      riskFlags: risks,
    };
  }

  // 其它工具不归本引擎管辖，沿用既有 risk 阈值同意闸门。
  return { decision: 'allow', reason: 'not-governed' };
}
