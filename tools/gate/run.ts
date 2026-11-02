#!/usr/bin/env tsx
/**
 * tools/gate/run.ts — 一键闸门（S5）
 *
 * DCD 裁定 §1.4（20261017）：gate 分两级。
 *
 * 阻塞级（红了必合）：typecheck → vitest → eval-golden → boundary → contract →
 *   coverage → empty-files → doc-drift → e2e-replay。任一步失败立即停止。
 *   20261031 门禁接线：eval-golden（40 条契约 golden）、doc-drift（文档↔代码引用校验，
 *   重写版）、e2e-replay（带断言的离线回放）入闸；CI（.github/workflows/ci.yml）自此
 *   只跑 npm run gate，不再维护平行步骤清单。
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
  // 门禁接线（20261031）：40 条契约 golden 入闸（纯函数、离线、确定性 100%）
  { name: 'eval-golden', cmd: 'npx tsx tools/eval/run.ts' },
  { name: 'boundary-audit', cmd: 'npx tsx tools/audit/boundary.ts' },
  { name: 'contract-guard', cmd: 'npx tsx tools/contract/check.ts' },
  { name: 'coverage-check', cmd: 'npx tsx tools/coverage/check.ts' },
  { name: 'empty-files', cmd: 'npx tsx tools/audit/empty-files.ts' },
  // 门禁接线（20261031）：原 CI 独有的两步并入 gate（CI 自此只跑 npm run gate）
  { name: 'doc-drift', cmd: 'npx tsx tools/audit/doc-drift.ts' },
  { name: 'e2e-replay', cmd: 'npx tsx tools/e2e/runner.ts tools/e2e/fixtures/simple-task.json' },
];

/** 信息级：红了照常合，输出进 logs/gate-info.log。 */
const infoSteps: Step[] = [
  { name: 'symbols', cmd: 'npx tsx tools/audit/symbols.ts' },
  { name: 'm3-clean', cmd: 'npx tsx tools/audit/m3-clean.ts' },
  { name: 'security', cmd: 'npx tsx tools/audit/security.ts' },
  // E3：漂移检测此前存在但从未被任何流程调用——它判定「漂移超阈值」的红色结论永不送达。
  // 先以信息级接入（移植文件与上游有意分叉，红是真实待办而非噪音）；待 7 个移植文件
  // 与上游对齐后再升阻塞级。需能读到 E:\NAS\deepseek-pp，缺失时脚本自行 exit 1 不崩闸门。
  { name: 'upstream-drift', cmd: 'node scripts/check-upstream-drift.mjs' },
  // 原文入库守卫（20261102）：抓包/postData 类会话原文不得进仓库（20261031 net-memsel 事件教训）。
  // 信息级：红了不阻塞，点名文件与规则进 logs/gate-info.log，提交前人工处置（移 logs/** 或脱敏）。
  { name: 'private-leak', cmd: 'npx tsx tools/audit/private-leak.ts' },
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

