#!/usr/bin/env tsx
/**
 * tools/e2e/runner.ts — E2E 集成测试脚手架（S15）
 *
 * 用 replay mock 引擎 + TaskLoop 串起来跑端到端，不接真实网页。
 * 用法：npx tsx tools/e2e/runner.ts tools/e2e/fixtures/simple-task.json
 *
 * 门禁接线（20261031）：旧版只打印结果、无断言——实测连 stopReason=empty-response
 * 的退化输出都 exit 0（CI 的 e2e 步骤恒绿）。现版支持 fixture 里的 expect 字段，
 * 逐项比对，任何不符 → exit 1。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createReplayEngine } from '../metrics/replay';

interface E2EFixture {
  userPrompt: string;
  replayLines: unknown[];
  /**
   * 断言（缺省项不校验；但 gate 已把本步设为阻塞级，建议每个 fixture 至少锁 stopReason）。
   */
  expect?: {
    stopReason?: string;
    round?: number;
    toolCalls?: number;
  };
}

async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('用法: tsx tools/e2e/runner.ts <fixture.json>');
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) as E2EFixture;

  const engine = createReplayEngine(fixture.replayLines.map((l) => JSON.stringify(l)));
  const history = createMessageHistory();
  const loop = createTaskLoop({ engine, history, maxRounds: 3 });

  const r = await loop.run(fixture.userPrompt);
  console.log('=== E2E 结果 ===');
  console.log('round:', r.round);
  console.log('content:', r.content);
  console.log('toolCalls:', r.toolCalls);
  console.log('stopReason:', r.stopReason);

  // ---- 断言（20261031）----
  const expect = fixture.expect ?? {};
  const problems: string[] = [];
  if (expect.stopReason !== undefined && r.stopReason !== expect.stopReason) {
    problems.push(`stopReason: expect=${expect.stopReason}  got=${r.stopReason}`);
  }
  if (expect.round !== undefined && r.round !== expect.round) {
    problems.push(`round: expect=${expect.round}  got=${r.round}`);
  }
  if (expect.toolCalls !== undefined && r.toolCalls !== expect.toolCalls) {
    problems.push(`toolCalls: expect=${expect.toolCalls}  got=${r.toolCalls}`);
  }

  if (problems.length > 0) {
    console.error('\n❌ E2E 断言失败：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('✅ E2E 断言通过');
}

main().catch((error: unknown) => {
  console.error('E2E 执行失败:', error);
  process.exitCode = 1;
});
