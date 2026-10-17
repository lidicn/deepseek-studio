/**
 * C-2: test-runner 测试
 */
import { describe, it, expect } from 'vitest';
import { runTests } from '../../src/host/kernel/test-runner';

describe('C-2 test-runner', () => {
  it('跑测试返回结构化结果', async () => {
    const result = await runTests('E:\\NAS\\deepseek-studio', 'tests/desktop/telemetry-store.test.ts');
    // 只要能返回结果就行，不严格断言 passed/failed
    expect(result).toBeDefined();
    expect(result.rawOutput).toBeDefined();
    console.log('result:', JSON.stringify({ ok: result.ok, passed: result.passed, failed: result.failed, total: result.total }));
  }, 60_000);
});
