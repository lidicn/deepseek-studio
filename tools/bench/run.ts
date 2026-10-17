#!/usr/bin/env tsx
/**
 * tools/bench/run.ts — 性能基准（S8）
 *
 * 输出 JSON 到 stdout：TaskLoop 空轮 P50/P95、MessageHistory snapshot/restore 耗时、
 * boundary audit 自身耗时。
 */

import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import type { ModelEngine } from '../../src/host/engine/model-engine';
import { checkFile } from '../audit/boundary';

function p50(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function p95(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)];
}

async function benchTaskLoop(): Promise<{ p50: number; p95: number; runs: number }> {
  const engine: ModelEngine = {
    name: 'web',
    async health() { return { ok: true }; },
    async send() { return { content: 'done', toolCalls: 0 }; },
  };
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const h = createMessageHistory();
    const loop = createTaskLoop({ engine, history: h, maxRounds: 1 });
    const t0 = process.hrtime.bigint();
    await loop.run('test');
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { p50: p50(times), p95: p95(times), runs: 100 };
}

function benchMessageHistory(): { snapshotP50: number; restoreP50: number } {
  const h = createMessageHistory();
  for (let i = 0; i < 100; i++) {
    h.append({ role: 'user', content: `msg-${i}` });
  }
  const snap = h.snapshot();

  const snapTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = process.hrtime.bigint();
    h.snapshot();
    snapTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  const restTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = process.hrtime.bigint();
    h.restore(snap);
    restTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  return { snapshotP50: p50(snapTimes), restoreP50: p50(restTimes) };
}

function benchBoundaryAudit(): number {
  const t0 = process.hrtime.bigint();
  checkFile('src/shared/fake.ts', "import { a } from './b';", process.cwd());
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function main(): Promise<void> {
  const taskLoop = await benchTaskLoop();
  const msgHist = benchMessageHistory();
  const audit = benchBoundaryAudit();
  console.log(JSON.stringify({ taskLoop, msgHist, boundaryAuditMs: audit }, null, 2));
}

main();
