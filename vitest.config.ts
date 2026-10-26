import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several test files boot an in-memory Postgres (PGlite) at once; that can take a while.
    hookTimeout: 30_000,
  },
});
