/**
 * tools/e2e/runner.ts — E2E 集成测试脚手架（S15）
 *
 * 用 replay mock 引擎 + TaskLoop 串起来跑端到端，不接真实网页。
 * 用法：npx tsx tools/e2e/runner.ts tools/e2e/fixtures/simple-task.json
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMessageHistory } from '../../src/host/kernel/message-history';
import { createTaskLoop } from '../../src/host/kernel/task-loop';
import { createReplayEngine } from '../metrics/replay';

function main(): void {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('用法: tsx tools/e2e/runner.ts <fixture.json>');
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) as {
    userPrompt: string;
    replayLines: unknown[];
  };

  const engine = createReplayEngine(fixture.replayLines.map((l) => JSON.stringify(l)));
  const history = createMessageHistory();
  const loop = createTaskLoop({ engine, history, maxRounds: 3 });

  loop.run(fixture.userPrompt).then((r) => {
    console.log('=== E2E 结果 ===');
    console.log('round:', r.round);
    console.log('content:', r.content);
    console.log('toolCalls:', r.toolCalls);
    console.log('stopReason:', r.stopReason);
  });
}

main();
