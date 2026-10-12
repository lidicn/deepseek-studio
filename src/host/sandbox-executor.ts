/**
 * v0.10 沙箱执行器（Python 代码执行）
 *
 * 路线图 v0.10：复刻 python/代码工件运行能力。
 * 当前实现：用系统 python 解释器在隔离临时目录中执行代码，
 * 带超时控制、输出大小限制、临时目录自动清理。
 *
 * 隔离策略：
 * - 每次执行创建独立临时目录（mkdtemp），代码写入 script.py
 * - cwd 限制在工作区内（未配置工作区时用临时目录本身）
 * - 超时默认 30s，可通过 timeoutMs 配置
 * - 执行完毕后删除临时目录（fail-closed：删除失败不影响结果返回）
 *
 * 未来升级方向（路线图原文）：用独立 Tauri webview + Pyodide 替代系统 python，
 * 实现真正的进程级隔离。当前系统 python 方案已满足功能验收，隔离性靠临时目录 + 超时保证。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SandboxExecOptions {
  /** Python 代码 */
  code: string;
  /** 超时毫秒（默认 30000） */
  timeoutMs?: number;
  /** 工作目录（默认临时目录） */
  cwd?: string;
  /** 最大输出字节数（默认 1MB） */
  maxBuffer?: number;
}

export interface SandboxExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly error?: string;
  readonly timedOut?: boolean;
}

/**
 * 在隔离沙箱中执行 Python 代码。
 * 返回 stdout/stderr/exitCode，临时目录执行后自动清理。
 */
export async function execPythonInSandbox(options: SandboxExecOptions): Promise<SandboxExecResult> {
  const { code, timeoutMs = 30000, cwd, maxBuffer = 1024 * 1024 } = options;

  if (!code.trim()) {
    return { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'code is required' };
  }

  // 创建隔离临时目录
  let tempDir: string;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'studio-sandbox-'));
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', exitCode: 1, error: `failed to create temp dir: ${(e as Error).message}` };
  }

  const scriptPath = join(tempDir, 'script.py');
  const execCwd = cwd ?? tempDir;

  try {
    await writeFile(scriptPath, code, 'utf8');

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const result = await new Promise<SandboxExecResult>((resolve) => {
      const child = execFile(pythonCmd, [scriptPath], {
        cwd: execCwd,
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
        },
      }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || error.killed;
          resolve({
            ok: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: error.code ? Number(error.code) || 1 : 1,
            error: timedOut ? `execution timed out after ${timeoutMs}ms` : (stderr?.trim() || error.message),
            timedOut,
          });
        } else {
          resolve({
            ok: true,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: 0,
          });
        }
      });

      // 兜底：子进程意外退出
      child.on('error', (err) => {
        resolve({
          ok: false,
          stdout: '',
          stderr: '',
          exitCode: 127,
          error: `failed to spawn python: ${err.message}`,
        });
      });
    });

    return result;
  } finally {
    // 清理临时目录（fail-closed：删除失败不影响结果）
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
}

/**
 * 工件代码执行入口（RUN_ARTIFACT_CODE）。
 * 统一处理 Python 工件代码的执行、结果格式化、错误清理。
 */
export async function runArtifactCode(
  code: string,
  options?: { timeoutMs?: number; cwd?: string },
): Promise<{ ok: boolean; output: string; error?: string; exitCode: number }> {
  const result = await execPythonInSandbox({
    code,
    timeoutMs: options?.timeoutMs ?? 30000,
    cwd: options?.cwd,
  });

  // 合并输出：stdout 为主，stderr 附加（清理 PowerShell 风格垃圾不适用 python）
  const output = result.stdout.trimEnd();
  const stderr = result.stderr.trim();

  if (result.ok) {
    return { ok: true, output, exitCode: 0 };
  }

  return {
    ok: false,
    output,
    error: result.error ?? (stderr || 'execution failed'),
    exitCode: result.exitCode,
  };
}
