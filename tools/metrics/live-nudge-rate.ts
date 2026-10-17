/**
 * live-nudge-rate.ts — M3 真机里程碑 V2：nudgeRate 取数
 *
 * 在真实 DeepSeek 页面跑 N 轮简单任务，每轮记录：
 *   - completion: 'complete' | 'truncated' | 'disconnected' | 'unknown'
 *   - contentLen: 本轮回复可见文本长度
 *   - toolCalls: 本轮工具调用数
 *   - durationMs: 耗时
 *
 * nudge = completion !== 'complete'（truncated/disconnected = 需要外部 nudge）。
 * nudgeRate = nudge 轮数 / 总轮数。
 *
 * 用法：
 *   npx tsx tools/metrics/live-nudge-rate.ts --rounds=50
 *
 * 输出：每轮一行 JSON，最后一行汇总（nudgeCount / nudgeRate / 平均耗时）。
 */

import { createLiveEngine, loadLiveConfig } from './lib/live-client';

const PROMPTS = [
  '用一个字回答：太阳从哪边升起？',
  '用一个字回答：水在零度以下会变成什么？',
  '用一个字回答：一周有几天？',
  '用一个字回答：月亮本身会发光吗？',
  '用一个字回答：一年有几个季节？',
];

function parseArgs(): { rounds: number; stepTimeoutMs: number } {
  const args = process.argv.slice(2);
  let rounds = 50;
  let stepTimeoutMs = 60_000;
  for (const a of args) {
    const m = a.match(/^--rounds=(\d+)$/);
    if (m) rounds = Number(m[1]);
    const t = a.match(/^--timeout=(\d+)$/);
    if (t) stepTimeoutMs = Number(t[1]);
  }
  return { rounds, stepTimeoutMs };
}

async function main(): Promise<void> {
  const { rounds, stepTimeoutMs } = parseArgs();
  const cfg = loadLiveConfig();
  console.log(JSON.stringify({ event: 'start', rounds, stepTimeoutMs, baseUrl: cfg.baseUrl }));

  const engine = createLiveEngine(cfg, { stepTimeoutMs });

  const rows: Array<{
    round: number;
    completion: string;
    contentLen: number;
    toolCalls: number;
    durationMs: number;
  }> = [];

  for (let i = 1; i <= rounds; i++) {
    const prompt = PROMPTS[(i - 1) % PROMPTS.length];
    const t0 = Date.now();
    let completion = 'unknown';
    let contentLen = 0;
    let toolCalls = 0;
    try {
      const r = await engine.send(prompt);
      completion = r.completion ?? 'unknown';
      contentLen = r.content.length;
      toolCalls = r.toolCalls;
    } catch (e) {
      completion = 'exception';
      contentLen = 0;
    }
    const durationMs = Date.now() - t0;
    rows.push({ round: i, completion, contentLen, toolCalls, durationMs });
    console.log(
      JSON.stringify({ round: i, completion, contentLen, toolCalls, durationMs }),
    );
  }

  const nudgeCount = rows.filter((r) => r.completion !== 'complete').length;
  const completeCount = rows.filter((r) => r.completion === 'complete').length;
  const disconnected = rows.filter((r) => r.completion === 'disconnected').length;
  const truncated = rows.filter((r) => r.completion === 'truncated').length;
  const avgMs = Math.round(rows.reduce((s, r) => s + r.durationMs, 0) / rows.length);
  const summary = {
    event: 'summary',
    total: rounds,
    complete: completeCount,
    truncated,
    disconnected,
    nudgeCount,
    nudgeRate: Number((nudgeCount / rounds).toFixed(3)),
    avgDurationMs: avgMs,
  };
  console.log(JSON.stringify(summary));
}

main().catch((e) => {
  console.error('[nudge-rate] 异常:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
