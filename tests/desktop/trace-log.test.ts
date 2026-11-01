/**
 * C1-F3：宿主侧 trace 落盘（`memory.select` 取证通道）单测。
 *
 * 只验通道本身：写到 `logs/trace/trace-<UTC日期>.jsonl`、一行一条、强制单行化。
 * 真机上 `memory.select` 的耗时/轮次由 Verify 在 audit + trace 两侧取证。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import { appendTraceLine } from '../../src/host/trace-log';

describe('trace-log（C1-F3 落盘通道）', () => {
  it('写入 logs/trace/trace-<日期>.jsonl，一行一条 JSON', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'studio-trace-'));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      appendTraceLine(JSON.stringify({ kind: 'msel', sessionId: 's1', seq: 1, durationMs: 12 }));
      const day = new Date().toISOString().slice(0, 10);
      const file = nodePath.join(dir, 'logs', 'trace', `trace-${day}.jsonl`);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0])).toMatchObject({ kind: 'msel', sessionId: 's1', seq: 1, durationMs: 12 });
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('多行内容被压成一行（JSONL 约束）', () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'studio-trace-'));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      appendTraceLine('{"kind":"msel",\n"seq":2}');
      const day = new Date().toISOString().slice(0, 10);
      const file = nodePath.join(dir, 'logs', 'trace', `trace-${day}.jsonl`);
      const raw = readFileSync(file, 'utf8');
      expect(raw.trim().split('\n').length).toBe(1);
      expect(JSON.parse(raw.trim())).toMatchObject({ kind: 'msel', seq: 2 });
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
