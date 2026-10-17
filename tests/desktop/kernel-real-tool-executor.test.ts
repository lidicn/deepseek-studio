import { describe, expect, it } from 'vitest';

import { createRealToolExecutor } from '../../src/host/kernel/real-tool-executor';

describe('RealToolExecutor（S17）', () => {
  it('1. shell_exec 成功返回 stdout', async () => {
    const ex = createRealToolExecutor({
      shellExec: async () => ({ stdout: 'a.txt', code: 0 }),
    });
    const r = await ex.execute('shell_exec', { cmd: 'ls' });
    expect(r.ok).toBe(true);
    expect(r.result).toBe('a.txt');
  });

  it('2. shell_exec 非零退出 → failed', async () => {
    const ex = createRealToolExecutor({
      shellExec: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
    });
    const r = await ex.execute('shell_exec', { cmd: 'bad' });
    expect(r.ok).toBe(false);
  });

  it('3. file_read 返回内容', async () => {
    const ex = createRealToolExecutor({
      fileRead: async () => 'hello',
    });
    const r = await ex.execute('file_read', { path: '/x' });
    expect(r.ok).toBe(true);
    expect(r.result).toBe('hello');
  });

  it('4. file_write 写成功', async () => {
    let wrote = '';
    const ex = createRealToolExecutor({
      fileWrite: async (_p, c) => { wrote = c; },
    });
    const r = await ex.execute('file_write', { path: '/x', content: 'hi' });
    expect(r.ok).toBe(true);
    expect(wrote).toBe('hi');
  });

  it('5. 未知工具 → failed', async () => {
    const ex = createRealToolExecutor({});
    const r = await ex.execute('nope');
    expect(r.ok).toBe(false);
  });

  it('6. handler 抛错被吞', async () => {
    const ex = createRealToolExecutor({
      shellExec: async () => { throw new Error('denied'); },
    });
    const r = await ex.execute('shell_exec', { cmd: 'x' });
    expect(r.ok).toBe(false);
  });

  it('7. 未接 handler → 明确报错', async () => {
    const ex = createRealToolExecutor({});
    const r = await ex.execute('shell_exec', { cmd: 'x' });
    expect(r.error).toContain('not wired');
  });
});
