/**
 * C-4: telemetry/store 测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetryStore } from '../../src/host/telemetry/store';

describe('C-4 telemetry/store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'telemetry-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('追加记录后落盘，文件数 > 0', () => {
    const store = createTelemetryStore({ rootDir: dir });
    store.append({ tool: 'shell_exec', ok: true, durationMs: 100, timestamp: Date.now() });
    expect(store.fileCount).toBeGreaterThan(0);
  });

  it('查询日统计：成功率正确计算', () => {
    const store = createTelemetryStore({ rootDir: dir });
    const now = Date.now();
    store.append({ tool: 'shell_exec', ok: true, durationMs: 100, timestamp: now });
    store.append({ tool: 'shell_exec', ok: true, durationMs: 200, timestamp: now });
    store.append({ tool: 'chat-read', ok: false, durationMs: 50, timestamp: now, error: 'no-page' });

    const date = new Date(now).toISOString().slice(0, 10);
    const stats = store.getDayStats(date);
    expect(stats.total).toBe(3);
    expect(stats.success).toBe(2);
    expect(stats.failure).toBe(1);
    expect(stats.successRate).toBeCloseTo(2 / 3, 2);
    expect(stats.byTool['shell_exec'].total).toBe(2);
    expect(stats.byTool['chat-read'].failure).toBe(1);
  });

  it('空日期返回全 0', () => {
    const store = createTelemetryStore({ rootDir: dir });
    const stats = store.getDayStats('2099-01-01');
    expect(stats.total).toBe(0);
    expect(stats.successRate).toBe(0);
  });
});
