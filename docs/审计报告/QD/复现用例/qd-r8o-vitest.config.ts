import { defineConfig } from 'vitest/config';

/**
 * QD R8o 复现件专用配置（宿主入站 tool-call 的 callId 幂等 + 握手门）。
 * 只在 tests/desktop/ 下取本席 zz- 前缀副本，⛔ 收全仓测试，避免与在飞的门抢资源。
 * 运行副本由 docs/审计报告/QD/复现用例/qd-r8o-host-dedupe.test.ts 复制而来。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/desktop/zz-qd-r8o-*.test.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 30_000,
    cacheDir: './.vite-r8o',
  },
});
