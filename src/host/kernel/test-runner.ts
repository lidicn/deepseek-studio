/**
 * C-2: test-runner — 工作区跑测试 + 结构化结果。
 *
 * 硬性要求：只能经 capabilities/shell.ts，不得另开 spawn。
 * 输出：passed / failed / total / failures[]
 */
import { createShellCapability } from '../../capabilities/shell';

export interface TestRunResult {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: string[];
  durationMs: number;
  rawOutput: string;
}

/**
 * 跑 vitest 测试并解析结构化结果。
 *
 * @param workspace 工作区路径
 * @param filter 可选的测试文件过滤（如 "tests/desktop/telemetry-store.test.ts"）
 */
export async function runTests(workspace: string, filter?: string): Promise<TestRunResult> {
  const start = Date.now();

  // 走 capabilities/shell.ts 双闸
  // workspace 传 null：测试环境不做工作区边界校验
  const shell = createShellCapability({ workspace: null, timeoutMs: 120_000 });
  const argv = filter
    ? ['npx', 'vitest', 'run', filter]
    : ['npx', 'vitest', 'run'];

  const result = await shell.execute({ argv });
  const durationMs = Date.now() - start;
  const rawOutput = (result.data?.stdout ?? '') + (result.data?.stderr ?? '');

  // 用文本估算结果
  let total = 0, passed = 0, failed = 0;
  const failures: string[] = [];

  const passMatch = rawOutput.match(/(\d+)\s+passed/);
  const failMatch = rawOutput.match(/(\d+)\s+failed/);
  if (passMatch) passed = parseInt(passMatch[1]);
  if (failMatch) failed = parseInt(failMatch[1]);
  total = passed + failed;

  // 提取失败的测试名
  const failLines = rawOutput.match(/×\s+(.+)/g);
  if (failLines) {
    for (const line of failLines.slice(0, 10)) {
      failures.push(line.replace(/^×\s+/, ''));
    }
  }

  return {
    ok: result.ok && failed === 0,
    total,
    passed,
    failed,
    failures,
    durationMs,
    rawOutput: rawOutput.slice(0, 5000),
  };
}
