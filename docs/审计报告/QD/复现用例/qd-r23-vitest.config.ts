import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['docs/审计报告/QD/复现用例/qd-r23-d[1-4]-*.test.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    cacheDir: './.vite-r23',
  },
});