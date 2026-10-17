#!/usr/bin/env tsx
/**
 * tools/gate/run.ts — 一键闸门（S5）
 *
 * 串行执行：typecheck → boundary audit → contract guard → eval:golden → metrics:report
 * 任一步失败立即停止。结束时打印总耗时。
 *
 * 用法：npm run gate
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Step {
  name: string;
  cmd: string;
}

const steps: Step[] = [
  { name: 'typecheck', cmd: 'npx tsc --noEmit' },
  { name: 'boundary-audit', cmd: 'npx tsx tools/audit/boundary.ts' },
  { name: 'contract-guard', cmd: 'npx tsx tools/contract/check.ts' },
  { name: 'eval-golden', cmd: 'npx tsx tools/eval/run.ts' },
  { name: 'metrics-report', cmd: 'npx tsx tools/metrics/report.ts tools/metrics/samples/healthy.jsonl' },
];

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const startedAt = Date.now();

  for (const step of steps) {
    console.log(`\n=== [${step.name}] ===`);
    try {
      execSync(step.cmd, { cwd: root, stdio: 'inherit' });
    } catch {
      console.error(`\nGATE FAILED at step: ${step.name}`);
      process.exit(1);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== GATE PASSED (${elapsed}s) ===`);
  process.exit(0);
}

main();
