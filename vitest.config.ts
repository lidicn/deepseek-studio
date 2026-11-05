import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/desktop/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    globals: true,
    // 序列化文件执行：desktop-entry 与既有 inject-loader 都调用全局幂等的 bootstrapInjection，
    // 并行执行会争用其模块级 installState 单例，改为串行消除跨文件竞态。
    fileParallelism: false,
    // ── 超时预算（20261105 · 全量 gate 两轮 flaky 定位）───────────────────────────
    // 本套件有一批「起一个**真宿主**再走**真实 HTTP**」的重量级用例（desktop-host 会装配
    // sqlite / bot registry / API server …）：空闲单机下首次启动约 1.8s、单次 HTTP 往返
    // 0.3–1.8s，而 vitest 默认 testTimeout=5000ms 只留了 2.5 倍余量。
    // 满载复现（8 逻辑核 + 12 个 CPU 占用进程，与 CI 同时跑全量时的处境同型）：
    //   `Test timed out in 5000ms`（c1p1-mcp-workbench-host 三条）+ `[vitest-worker]:
    //   Timeout calling "fetch" with "/src/host/desktop-host.ts"`（模块图 RPC 被饿死）。
    // 这就是 CI 两轮「各自不同文件红、单跑全绿」的根因族：不是断言错，是**预算不够**。
    // 故给足预算：用例 30s / 钩子 60s（宿主启动在 beforeAll/hook 里）。
    // 注意：这不是放宽断言——真挂死仍是无穷等待，30s 后照样红；只是不再把「慢」判成「坏」。
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
