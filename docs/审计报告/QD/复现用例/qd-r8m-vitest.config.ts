import { defineConfig } from 'vitest/config';

/**
 * QD R8m 复现件专用配置（任务 A｜M10 记忆系统）。
 * 只在 docs/审计报告/QD/复现用例/ 下取本席文件，⛔ 收全仓测试，避免与在飞的门抢资源。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['docs/审计报告/QD/复现用例/qd-r8m-memory.test.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 30_000,
    cacheDir: './.vite-r8m',
  },
});
