/**
 * 测试运行器（test.run，v0.1）
 *
 * 对齐 docs/设计稿/M5-编程工具链最终设计稿.md 第 6 节。
 *
 * 契约：
 *   testRun({ cmd?, scope?, timeoutMs?, maxOutputBytes? })
 *     → { ok: true,  data: TestRunData }              // 工具成功（含测试红）
 *     → { ok: false, error: '<§6.1 词表>' }           // 工具失败
 *
 * 关键原则：
 *   - argv 数组，永不经过 shell 解释器
 *   - 退出码是红绿唯一权威
 *   - ok 与 passed 分离：测试红不是工具失败
 *   - 每工作区同时只允许一次运行（拒而不排队）
 */

import { isWorkspaceConfigured, type WorkspaceContext } from '../host/workspace';
import type { ExecutableCapability, ExecuteResult } from './types';

export const TEST_RUN_TOOL_ID = 'test.run';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export interface TestFailureItem {
  name: string;
  file?: string;
  line?: number;
  message: string;
}

export interface TestRunData {
  status: 'pass' | 'fail' | 'error';
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  argv: string[];
  cwd: string;
  total: number | null;
  passedCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  errorCount: number | null;
  failures: TestFailureItem[];
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
  logRef: { path: string; bytes: number } | null;
}

export interface TestRunOptions {
  workspace?: WorkspaceContext | null;
}

function fail(error: string, reason: string, extra: Record<string, unknown> = {}): ExecuteResult {
  return {
    ok: false,
    error,
    data: { reason, ...extra },
    content: [{ type: 'text', text: `test.run failed: ${error} (${reason})` }],
    details: { reason, ...extra },
    isError: true,
  };
}

function success(data: TestRunData): ExecuteResult {
  const summary =
    data.status === 'pass'
      ? `tests passed (${data.passedCount}/${data.total})`
      : data.status === 'fail'
        ? `tests failed (${data.failedCount}/${data.total})`
        : `test run error: ${data.timedOut ? 'timed out' : 'spawn failed'}`;
  return {
    ok: true,
    data,
    content: [{ type: 'text', text: summary }],
    details: { ...data },
    isError: false,
  };
}

/** 构造 test.run 能力。 */
export function createTestRunCapability(options: TestRunOptions = {}): ExecutableCapability {
  let running = false;

  return {
    id: TEST_RUN_TOOL_ID,
    async execute(params: Record<string, unknown>): Promise<ExecuteResult> {
      if (!isWorkspaceConfigured(options.workspace)) {
        return fail('workspace-unconfigured', 'workspace-unconfigured');
      }

      if (running) {
        return fail('limit-exceeded', 'concurrent-test-runs');
      }

      const workspace = options.workspace ?? null;
      const cwd = workspace?.root ?? process.cwd();

      // 参数
      const cmd = typeof params.cmd === 'string' ? params.cmd : undefined;
      const scope = typeof params.scope === 'string' ? params.scope : undefined;
      const timeoutMs = Math.min(
        typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );

      // 构造 argv
      let argv: string[];
      if (cmd) {
        // 校验字符集
        if (!/^[A-Za-z0-9:_-]{1,64}$/.test(cmd)) {
          return fail('invalid-argument', 'cmd-charset', { cmd });
        }
        // 简化：直接用 npm run <cmd>
        argv = ['npm', 'run', cmd];
      } else if (scope) {
        // scope 必须在工作区内
        if (workspace && !workspace.resolveWithin(scope)) {
          return fail('outside-workspace', 'outside-workspace', { path: scope });
        }
        argv = ['npx', 'vitest', 'run', scope];
      } else {
        argv = ['npx', 'vitest', 'run'];
      }

      running = true;
      const start = Date.now();

      try {
        // 简化实现：直接 spawn
        const { spawn } = await import('node:child_process');
        const child = spawn(argv[0], argv.slice(1), {
          cwd,
          shell: false,
          env: { ...process.env, FORCE_COLOR: '0' },
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
          if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
          if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
        });

        const exitCode = await new Promise<number | null>((resolve) => {
          child.on('close', (code) => resolve(code));
          child.on('error', () => resolve(null));
        });
        clearTimeout(timer);

        const durationMs = Date.now() - start;

        // 解析计数（简化：从 stdout 提取）
        const passMatch = stdout.match(/Tests\s+(\d+)\s+passed/);
        const failMatch = stdout.match(/Tests\s+(\d+)\s+failed/);
        const passedCount = passMatch ? parseInt(passMatch[1], 10) : null;
        const failedCount = failMatch ? parseInt(failMatch[1], 10) : null;
        const total = passedCount !== null && failedCount !== null ? passedCount + failedCount : null;

        if (timedOut) {
          return success({
            status: 'error',
            passed: false,
            exitCode: null,
            timedOut: true,
            durationMs,
            argv,
            cwd,
            total,
            passedCount,
            failedCount,
            skippedCount: null,
            errorCount: null,
            failures: [],
            stdoutTail: stdout.slice(-6144),
            stderrTail: stderr.slice(-6144),
            truncated: stdout.length >= MAX_OUTPUT_BYTES,
            logRef: null,
          });
        }

        if (exitCode === null) {
          return fail('io-error', 'spawn-failed', { argv });
        }

        const passed = exitCode === 0;
        return success({
          status: passed ? 'pass' : 'fail',
          passed,
          exitCode,
          timedOut: false,
          durationMs,
          argv,
          cwd,
          total,
          passedCount,
          failedCount,
          skippedCount: null,
          errorCount: null,
          failures: [],
          stdoutTail: stdout.slice(-6144),
          stderrTail: stderr.slice(-6144),
          truncated: stdout.length >= MAX_OUTPUT_BYTES,
          logRef: null,
        });
      } finally {
        running = false;
      }
    },
  };
}
