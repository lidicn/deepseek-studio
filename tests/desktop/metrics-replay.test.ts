/**
 * S10 JSONL replay 测试。
 */

import { describe, it, expect } from 'vitest';
import { createReplayEngine } from '../../tools/metrics/replay';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(__dirname, '..', '..', 'tools', 'metrics', 'samples');

function readLines(name: string): string[] {
  return readFileSync(join(samplesDir, name), 'utf8').split('\n');
}

describe('S10 replay engine', () => {
  it('1. healthy 样本 → engine.send 返回 toolCalls=1（每轮一个 after-call）', async () => {
    const engine = createReplayEngine(readLines('healthy.jsonl'));
    const r = await engine.send('test');
    expect(r.toolCalls).toBe(1);
    expect(typeof r.content).toBe('string');
  });

  it('2. unhealthy 样本 → toolCalls 匹配轮次', async () => {
    const engine = createReplayEngine(readLines('unhealthy.jsonl'));
    let totalToolCalls = 0;
    for (let i = 0; i < 20; i++) {
      const r = await engine.send('test');
      totalToolCalls += r.toolCalls;
    }
    // unhealthy 每轮有 1 个 after-call bus 事件
    expect(totalToolCalls).toBe(20);
  });

  it('3. health() 返回 ok', async () => {
    const engine = createReplayEngine([]);
    const h = await engine.health();
    expect(h.ok).toBe(true);
  });

  it('4. 空输入 → send 返回 content 空, toolCalls=0', async () => {
    const engine = createReplayEngine([]);
    const r = await engine.send('x');
    expect(r.toolCalls).toBe(0);
  });

  it('5. 多轮 send 顺序消费', async () => {
    const lines = [
      '{"kind":"loop","type":"tool"}',
      '{"kind":"bus","event":"after-call"}',
      '{"kind":"loop","type":"assistant"}',
      '{"kind":"loop","type":"tool"}',
      '{"kind":"loop","type":"assistant"}',
    ];
    const engine = createReplayEngine(lines);
    const r1 = await engine.send('a');
    const r2 = await engine.send('b');
    expect(r1.toolCalls).toBe(1);
    expect(r2.toolCalls).toBe(0);
  });

  it('6. waitForNextReply 委托给 send', async () => {
    const engine = createReplayEngine([]);
    const r = await engine.waitForNextReply!();
    expect(r.toolCalls).toBe(0);
  });
});
