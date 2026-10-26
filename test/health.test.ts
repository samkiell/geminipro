import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { createLogger } from '../src/util/logger.js';

const logger = createLogger({ level: 'silent' });
let app: ReturnType<typeof buildServer> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    app = buildServer({ logger, pingDb: async () => {} });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'ok' });
  });

  it('returns 503 when the database ping fails', async () => {
    app = buildServer({
      logger,
      pingDb: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, db: 'error' });
  });
});
