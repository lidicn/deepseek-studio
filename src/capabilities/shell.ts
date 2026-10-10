/**
 * 宿主侧能力：shell.exec（v0.5）
 *
 * 安全红线（即便运行在 full 完全访问档也不可协商）：
 * 1. **永远 `shell: false`** —— 命令不做解释器解释，因此不存在命令注入。
 *    这是「完全访问」与「任由注入」的分界线：前者是用户授权，后者是缺陷。
 * 2. 命令串按引号规则切成 argv；含管道/重定向等 shell 语法一律显式拒绝，
 *    并提示改用 argv 数组，而不是「悄悄执行出一个奇怪结果」。
 * 3. 有超时上限、有输出截断：子进程不能挂住宿主，也不能用巨量输出撑爆内存。
 * 4. cwd 必须落在工作区内（未配置工作区则回落到宿主默认，越界直接拒绝）。
 */

import { spawn } from 'node:child_process';
import { isWorkspaceConfigured, type WorkspaceContext } from '../host/workspace';
import type { CapabilityContext, ExecutableCapability, ExecuteResult } from './types';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ShellCapabilityOptions {
  /** 工作区上下文；cwd 越界据此拒绝。 */
  workspace?: WorkspaceContext | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * 按引号规则切分命令串为 argv（双引号/单引号内的空格不当分隔符）。
 * 不做转义处理——Windows 下反斜杠是路径分隔符，当成转义会破坏路径。
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

/** 检测未被引号包裹的 shell 语法（管道/重定向/命令串联/命令替换）。 */
export function hasShellSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '|' || ch === '>' || ch === '<' || ch === '&' || ch === ';' || ch === '`' || ch === '$') {
      return true;
    }
  }
  return false;
}

interface AppendResult {
  text: string;
  keep: boolean;
}

function appendCapped(existing: string, chunk: string, limit: number): AppendResult {
  if (existing.length >= limit) return { text: existing, keep: false };
  const remaining = limit - existing.length;
  const next = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
  return { text: existing + next, keep: chunk.length <= remaining };
}

function clampTimeout(requested: unknown, fallback: number): number {
  // 非法值（负数 / 0 / NaN / 非数字）一律回落到默认超时，
  // 而不是夹到下界 1ms——那样任何垃圾入参都会让命令「必定超时」。
  const valid = typeof requested === 'number' && Number.isFinite(requested) && requested > 0;
  if (!valid) return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(fallback)));
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(requested)));
}

export function createShellCapability(options: ShellCapabilityOptions = {}): ExecutableCapability {
  // 兼容可变工作区代理：未配置（configured === false）时视同无工作区边界，
  // cwd 回落宿主默认（与 v0.5 静态 null 工作区语义一致）。
  const workspace = options.workspace ?? null;
  const wsActive = isWorkspaceConfigured(workspace) ? workspace : null;
  const baseTimeout = clampTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    id: 'shell.exec',
    async execute(params: Record<string, unknown>, ctx?: CapabilityContext): Promise<ExecuteResult> {
      // 优先使用显式 argv（最安全、无需任何切分）
      const argvParam = params.argv;
      let argv: string[];
      if (Array.isArray(argvParam) && argvParam.length > 0 && argvParam.every((a) => typeof a === 'string')) {
        argv = argvParam as string[];
      } else {
        const command = typeof params.command === 'string' ? params.command : typeof params.cmd === 'string' ? params.cmd : '';
        if (command.trim().length === 0) return { ok: false, error: 'missing-command' };
        // 含 shell 语法 → 明示拒绝，而不是把 '|' 之类的字符当普通参数传下去
        if (hasShellSyntax(command)) {
          return {
            ok: false,
            error: 'shell-syntax-unsupported',
            data: { hint: '不支持管道/重定向等 shell 语法，请改用 argv 数组或单条命令' },
          };
        }
        argv = tokenizeCommand(command);
      }
      if (argv.length === 0) return { ok: false, error: 'missing-command' };

      const requestedCwd = typeof params.cwd === 'string' && params.cwd.trim().length > 0 ? params.cwd.trim() : null;
      const cwd = requestedCwd ?? wsActive?.root ?? process.cwd();
      // 越界 cwd：默认拒绝；仅当宿主（策略档位或用户同意后）显式授权才放行。
      if (wsActive && !wsActive.contains(cwd) && ctx?.allowOutsideWorkspace !== true) {
        return { ok: false, error: 'cwd-outside-workspace', data: { cwd } };
      }

      // v0.9：Windows cmd 内建命令（dir/copy/del/type 等）不是独立可执行文件，
      // shell:false spawn 找不到。自动加 cmd /c 前缀。
      // F4 修复：排除 set/path/whoami/systeminfo 等会泄漏环境/系统信息的命令
      const CMD_BUILTINS = new Set(['dir', 'copy', 'del', 'erase', 'type', 'findstr', 'find', 'ren', 'rename', 'move', 'md', 'mkdir', 'rd', 'rmdir', 'cls', 'echo', 'ver', 'vol', 'date', 'time', 'cd', 'chdir', 'sort', 'more', 'tree', 'xcopy', 'robocopy', 'where', 'tasklist', 'ipconfig', 'ping', 'netstat', 'nslookup']);
      if (process.platform === 'win32' && CMD_BUILTINS.has(argv[0].toLowerCase())) {
        argv = ['cmd', '/c', ...argv];
      }

      // v0.9：Windows 中文路径编码修复——powershell -Command 的参数经 argv 传递时
      // 中文会变 ????（PowerShell 用系统 ANSI 代码页解析命令行）。改用 -EncodedCommand（Base64 UTF-16LE）。
      if (process.platform === 'win32' && /^powershell(\.exe)?$/i.test(argv[0]) || /^pwsh(\.exe)?$/i.test(argv[0] || '')) {
        const cmdIdx = argv.findIndex((a) => a === '-Command' || a === '-c');
        if (cmdIdx >= 0 && argv[cmdIdx + 1]) {
          const script = argv[cmdIdx + 1];
          const encoded = Buffer.from(script, 'utf16le').toString('base64');
          argv = [...argv.slice(0, cmdIdx), '-EncodedCommand', encoded];
        }
      }

      const timeoutMs = clampTimeout(params.timeoutMs, baseTimeout);
      const startedAt = Date.now();

      return await new Promise<ExecuteResult>((resolve) => {
        let child;
        try {
          child = spawn(argv[0], argv.slice(1), {
            cwd,
            shell: false, // 红线：绝不启用解释器
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          resolve({
            ok: false,
            error: 'spawn-failed',
            data: { message: err instanceof Error ? err.message : String(err) },
          });
          return;
        }

        let stdout = '';
        let stderr = '';
        let truncated = false;
        let settled = false;

        const finish = (payload: ExecuteResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(payload);
        };

        const common = () => ({
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          truncated,
          durationMs: Date.now() - startedAt,
          argv,
          cwd,
        });

        child.stdout?.on('data', (buf: Buffer) => {
          const r = appendCapped(stdout, buf.toString('utf8'), maxOutputBytes);
          stdout = r.text;
          if (!r.keep) truncated = true;
        });
        child.stderr?.on('data', (buf: Buffer) => {
          const r = appendCapped(stderr, buf.toString('utf8'), maxOutputBytes);
          stderr = r.text;
          if (!r.keep) truncated = true;
        });
        child.on('error', (err: Error) => {
          finish({ ok: false, error: 'spawn-failed', data: { ...common(), message: err.message } });
        });
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          const exitCode = code ?? (signal ? -1 : 0);
          finish({
            ok: exitCode === 0,
            error: exitCode === 0 ? undefined : 'nonzero-exit',
            data: { ...common(), exitCode },
          });
        });

        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 已经退出：忽略
          }
          finish({ ok: false, error: 'timeout', data: { ...common(), timeoutMs } });
        }, timeoutMs);
      });
    },
  };
}
