import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/desktop/zz-qd-r12-*.test.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 30_000,
    cacheDir: './.vite-r12',
  },
});
