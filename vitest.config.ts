import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', include: ['packages/shared/test/**/*.test.ts'] } },
      { test: { name: 'client-unit', include: ['apps/client/test/**/*.test.ts'] } },
      {
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'server',
          include: ['apps/server/test/**/*.test.ts'],
          testTimeout: 45_000,
          hookTimeout: 45_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
