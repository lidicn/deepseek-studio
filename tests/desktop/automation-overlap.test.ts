import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationManager } from '../../src/host/automation';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('automation 同任务重入锁', () => {
  it('runNow 在上一轮未结束时返回 failed 日志且不再次触发', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-automation-'));
    tempDirs.push(dir);
    let release: (() => void) | undefined;
    const onTaskTrigger = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const manager = createAutomationManager({ storageDir: dir, onTaskTrigger });
    const task = manager.create({
      name: 'overlap',
      cron: '* * * * *',
      type: 'prompt',
      payload: { prompt: 'run' },
      enabled: false,
    });

    const first = manager.runNow(task.id);
    await vi.waitFor(() => expect(onTaskTrigger).toHaveBeenCalledTimes(1));
    const second = await manager.runNow(task.id);

    expect(second?.status).toBe('failed');
    expect(second?.error).toBe('task-already-running');
    expect(onTaskTrigger).toHaveBeenCalledTimes(1);

    release?.();
    await expect(first).resolves.toMatchObject({ status: 'success' });
  });
});
