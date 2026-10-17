#!/usr/bin/env tsx
/**
 * tools/gate/run.ts — 一键闸门（S5）
 *
 * DCD 裁定 §1.4（20261017）：gate 分两级。
 *
 * 阻塞级（红了必合）：typecheck → vitest → boundary → contract → coverage
 *   任一步失败立即停止。
 *
 * 信息级（红了照常合，但输出进日志留档）：symbols → m3-clean → security
 *   M3 未完、面板 innerHTML 历史债，这些尺红是真实待办，不是噪音。
 *   失败不 process.exit(1)，输出追加到 logs/gate-info.log。
 *
 * 用法：npm run gate
 */

import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Step {
  name: string;
  cmd: string;
}

/** 阻塞级：红了必合。 */
const blockingSteps: Step[] = [
  { name: 'typecheck', cmd: 'npx tsc --noEmit' },
  { name: 'vitest', cmd: 'npx vitest run' },
  { name: 'boundary-audit', cmd: 'npx tsx tools/audit/boundary.ts' },
  { name: 'contract-guard', cmd: 'npx tsx tools/contract/check.ts' },
  { name: 'coverage-check', cmd: 'npx tsx tools/coverage/check.ts' },
];

/** 信息级：红了照常合，输出进 logs/gate-info.log。 */
const infoSteps: Step[] = [
  { name: 'symbols', cmd: 'npx tsx tools/audit/symbols.ts' },
  { name: 'm3-clean', cmd: 'npx tsx tools/audit/m3-clean.ts' },
  { name: 'security', cmd: 'npx tsx tools/audit/security.ts' },
];

function main(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = resolve(__dirname, '..', '..');
  const startedAt = Date.now();

  // 阻塞级
  for (const step of blockingSteps) {
    console.log(`\n=== [阻塞] ${step.name} ===`);
    try {
      execSync(step.cmd, { cwd: root, stdio: 'inherit' });
      console.log(`✅ [${step.name}] 通过`);
    } catch {
      console.error(`\n❌ [阻塞] [${step.name}] 失败：请检查上方输出`);
      process.exit(1);
    }
  }

  // 信息级
  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'gate-info.log');
  const stamp = new Date().toISOString();
  const infoLines: string[] = [`\n=== gate info @ ${stamp} ===`];

  for (const step of infoSteps) {
    console.log(`\n=== [信息] ${step.name} ===`);
    let out = '';
    try {
      out = execSync(step.cmd, { cwd: root, encoding: 'utf8' });
      console.log(`ℹ️ [${step.name}] 通过`);
      infoLines.push(`[${step.name}] PASS\n${out}`);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = (err.stdout || '') + (err.stderr || '');
      console.log(`ℹ️ [${step.name}] 红（信息级，不阻塞）：见 logs/gate-info.log`);
      infoLines.push(`[${step.name}] FAIL\n${out}`);
    }
  }

  appendFileSync(logFile, infoLines.join('\n'), 'utf8');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n✅ 阻塞级全过（${blockingSteps.length} 步阻塞 + ${infoSteps.length} 步信息，${elapsed}s）`);
  process.exit(0);
}

main();
