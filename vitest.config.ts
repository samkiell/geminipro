import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several test files boot an in-memory Postgres (PGlite) at once; that can take a while.
    hookTimeout: 60_000,
    // ...and so can the queries inside a test while the other files are busy (seen past 30s on a
    // loaded machine). A real failure still fails fast on its assertion.
    testTimeout: 60_000,
  },
});
