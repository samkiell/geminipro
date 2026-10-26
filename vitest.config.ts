import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several test files boot an in-memory Postgres (PGlite) at once; that can take a while.
    hookTimeout: 30_000,
    // ...and so can the queries inside a test while the other files are busy.
    testTimeout: 20_000,
  },
});
