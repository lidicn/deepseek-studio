/**
 * live-delta.ts — M3 真机里程碑 V3：真实流式 delta 验证
 *
 * 发一条较长消息（写一首短诗），挂 onDelta 回调逐 token 收，统计：
 *   - deltaFragmentCount: onDelta 触发次数
 *   - totalDeltaChars: 累计 delta 文本长度
 *   - firstTokenMs: 从发起到第一次 onDelta 的延迟
 *   - totalMs: 整轮耗时
 *
 * 验收：deltaFragmentCount >= 10（证明 WebEngine 能逐 token 收到流式增量，而非一次性吐全文）。
 *
 * 用法：npx tsx tools/metrics/live-delta.ts
 */

import { createLiveEngine, loadLiveConfig } from './lib/live-client';

async function main(): Promise<void> {
  const cfg = loadLiveConfig();
  let fragCount = 0;
  let totalChars = 0;
  let firstTokenMs = -1;
  const t0 = Date.now();

  const engine = createLiveEngine(cfg, {
    stepTimeoutMs: 60_000,
    onDelta: (text: string) => {
      fragCount += 1;
      totalChars += text.length;
      if (firstTokenMs < 0) firstTokenMs = Date.now() - t0;
    },
  });

  console.log(JSON.stringify({ event: 'start' }));
  const r = await engine.send('请写一首关于秋天的短诗，大约100字。');
  const totalMs = Date.now() - t0;

  const result = {
    event: 'result',
    completion: r.completion,
    deltaFragmentCount: fragCount,
    totalDeltaChars: totalChars,
    firstTokenMs,
    totalMs,
    finalContentLen: r.content.length,
    finalContentPreview: r.content.slice(0, 80),
  };
  console.log(JSON.stringify(result));

  if (fragCount < 10) {
    console.error(`[delta] FAIL: deltaFragmentCount=${fragCount} < 10，流式增量未逐 token 到达。`);
    process.exit(1);
  }
  console.log('[delta] ✅ V3 通过：流式 delta 逐 token 到达。');
}

main().catch((e) => {
  console.error('[delta] 异常:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
