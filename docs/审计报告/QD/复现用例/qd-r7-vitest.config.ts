import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/desktop/zz-qd-r7-*.test.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 30_000,
    cacheDir: './.vite-r7',
  },
});
