/**
 * live-health.ts — M3 真机里程碑 V1：环境确认
 *
 * 做三件事：
 *   1. /healthz 探活本机宿主（8760）
 *   2. engine.health() + 真页面校验（chat-read 必须返回 {count,messages}，
 *      而不是无页面时的 Node 兜底 snapshot）
 *   3. send() 一条简单消息，确认真实回复能回来
 *
 * 用法：npx tsx tools/metrics/live-health.ts
 *
 * 退出码：0 = V1 通过；1 = 环境未就绪（按 stderr 提示处理）。
 */

import { createLiveEngine, hostHealthz, isRealPageRead, loadLiveConfig, makeHttpDispatch } from './lib/live-client';

async function main(): Promise<void> {
  const cfg = loadLiveConfig();
  console.log(`[health] 宿主 = ${cfg.baseUrl}`);

  // 1) /healthz
  const hz = await hostHealthz(cfg);
  console.log(`[health] /healthz -> ok=${hz.ok} body=${hz.body.trim()}`);
  if (!hz.ok) {
    console.error('[health] FAIL：宿主进程没起。先按手册 npm run tauri:dev。');
    process.exit(1);
  }

  const engine = createLiveEngine(cfg);

  // 2) engine.health()
  const health = await engine.health();
  console.log(`[health] engine.health() ->`, health);

  // 真页面校验：health() 在无页面时会被 Node 兜底骗过（chat-read 返回 ok 但带 snapshot）。
  // 必须亲自读一次 chat-read，确认拿到的是 {count,messages}。
  const dispatch = makeHttpDispatch(cfg);
  const probe = await dispatch('chat-read', {});
  console.log(`[health] 真页面探测 chat-read -> ok=${probe.ok} error=${probe.error ?? ''}`);
  console.log(`[health]            data keys =`, probe.data ? Object.keys(probe.data as object) : '(none)');
  if (!isRealPageRead(probe)) {
    console.error('[health] FAIL：没有可信 DeepSeek 页面连接到宿主。');
    console.error('[health]  → 请在 Studio 窗口里确认已登录 chat.deepseek.com 且页面已加载（注入已连上）。');
    console.error('[health]  → 若窗口刚打开，等 10s 再跑一次本脚本。');
    process.exit(1);
  }
  const data = probe.data as { count: number; messages: Array<{ text: string }> };
  console.log(`[health] 当前对话消息数 count=${data.count}，最后一条长度=${data.messages.at(-1)?.text.length ?? 0}`);

  // 3) send 一条简单消息，确认真实回复能回来。
  console.log('[health] 发送一条简单消息…（首次 chat-insert/send 可能在页面弹同意框，请点「允许本次会话」）');
  const t0 = Date.now();
  const r = await engine.send('请只回复两个字：你好');
  const dt = Date.now() - t0;
  console.log(`[health] send 完成：completion=${r.completion} toolCalls=${r.toolCalls} 耗时=${dt}ms`);
  console.log(`[health] 回复文本（前 200 字）: ${JSON.stringify(r.content.slice(0, 200))}`);

  if (r.completion !== 'complete') {
    console.error(`[health] FAIL：首轮 completion=${r.completion}，未拿到干净回复。`);
    process.exit(1);
  }
  if (!r.content || r.content.trim().length === 0) {
    console.error('[health] FAIL：回复为空。');
    process.exit(1);
  }
  console.log('[health] ✅ V1 通过：宿主在线、页面已连接、能收到真实回复。');
}

main().catch((e) => {
  console.error('[health] 异常:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
