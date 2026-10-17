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

const baseSteps: Step[] = [
  { name: 'typecheck', cmd: 'npx tsc --noEmit' },
  { name: 'boundary-audit', cmd: 'npx tsx tools/audit/boundary.ts' },
  { name: 'contract-guard', cmd: 'npx tsx tools/contract/check.ts' },
  { name: 'eval-golden', cmd: 'npx tsx tools/eval/run.ts' },
  { name: 'metrics-report', cmd: 'npx tsx tools/metrics/report.ts tools/metrics/samples/healthy.jsonl' },
];

const liveStep: Step = { name: 'live-nudge-rate', cmd: 'npx tsx tools/metrics/live-nudge-rate.ts --rounds=10' };

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const startedAt = Date.now();
  const useLive = process.argv.includes('--live');
  const steps = useLive ? [...baseSteps, liveStep] : baseSteps;

  for (const step of steps) {
    console.log(`\n=== [${step.name}] ===`);
    try {
      execSync(step.cmd, { cwd: root, stdio: 'inherit' });
      console.log(`✅ [${step.name}] 通过`);
    } catch {
      console.error(`\n❌ [${step.name}] 失败：请检查上方输出`);
      process.exit(1);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✅ 全部通过（${steps.length} 步，${elapsed}s）`);
  process.exit(0);
}

main();
