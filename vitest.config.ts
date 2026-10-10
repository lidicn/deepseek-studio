import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/desktop/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    globals: true,
    // 序列化文件执行：desktop-entry 与既有 inject-loader 都调用全局幂等的 bootstrapInjection，
    // 并行执行会争用其模块级 installState 单例，改为串行消除跨文件竞态。
    fileParallelism: false,
  },
});
