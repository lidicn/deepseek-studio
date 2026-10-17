import { describe, expect, it } from 'vitest';

import {
  createFakeExecutor,
  executeToolRecord,
} from '../../src/host/kernel/tool-bridge';
import type { ToolExecutor } from '../../src/host/kernel/tool-bridge';
import type { ToolCallRecord } from '../../src/host/engine/model-engine';

function rec(tool: string): ToolCallRecord {
  return { tool, ok: true };
}

describe('ToolBridge（S8 工具执行桥）', () => {
  it('1. 执行成功 → record.ok=true', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: true, result: 'a.txt' } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.record.ok).toBe(true);
  });

  it('2. 执行失败 → record.ok=false', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: false, error: 'exit 1' } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.record.ok).toBe(false);
    expect(r.record.error).toBe('exit 1');
  });

  it('3. 成功时 content 带结果串', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: true, result: 'a.txt' } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.content).toContain('a.txt');
  });

  it('4. 失败时 content 带 failed 字样', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: false, error: 'oops' } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.content).toContain('failed');
  });

  it('5. executor 抛错被吞，不向上炸', async () => {
    const ex: ToolExecutor = {
      async execute() { throw new Error('boom'); },
    };
    const r = await executeToolRecord(ex, rec('x'));
    expect(r.record.ok).toBe(false);
    expect(r.content).toContain('boom');
  });

  it('6. fake executor 记录调用顺序', async () => {
    const ex = createFakeExecutor({
      a: { ok: true },
      b: { ok: true },
    });
    await executeToolRecord(ex, rec('a'));
    await executeToolRecord(ex, rec('b'));
    expect(ex.calls).toEqual(['a', 'b']);
  });

  it('7. 未知工具 → failed: no such tool', async () => {
    const ex = createFakeExecutor({});
    const r = await executeToolRecord(ex, rec('nope'));
    expect(r.record.ok).toBe(false);
    expect(r.content).toContain('no such tool');
  });

  it('8. content 以 [toolname] 开头', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: true, result: '' } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.content).toMatch(/^\[shell_exec\]/);
  });

  it('9. 成功时 record 不带 error 字段', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: true, result: '' } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.record.error).toBeUndefined();
  });

  it('10. 无 result 时 content 退化为 ok', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: true } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.content).toBe('[shell_exec] ok');
  });

  it('11. 无 error 时 failed content 用 unknown error', async () => {
    const ex = createFakeExecutor({ shell_exec: { ok: false } });
    const r = await executeToolRecord(ex, rec('shell_exec'));
    expect(r.content).toContain('unknown error');
  });

  it('12. 多记录依次执行结果顺序正确', async () => {
    const ex = createFakeExecutor({
      t1: { ok: true, result: '1' },
      t2: { ok: false, error: '2' },
    });
    const a = await executeToolRecord(ex, rec('t1'));
    const b = await executeToolRecord(ex, rec('t2'));
    expect(a.content).toContain('1');
    expect(b.content).toContain('2');
  });
});
