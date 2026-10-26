import type { FastifyPluginAsync } from 'fastify';
import { withTimeout } from '../util/time.js';

export interface HealthRouteOptions {
  pingDb: () => Promise<void>;
}

const DB_PING_TIMEOUT_MS = 5_000;

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, { pingDb }) => {
  app.get('/health', async (req, reply) => {
    try {
      await withTimeout(pingDb(), DB_PING_TIMEOUT_MS, 'database ping');
      return { ok: true, db: 'ok' };
    } catch (err) {
      req.log.error({ err }, 'health check failed: database unreachable');
      return reply.code(503).send({ ok: false, db: 'error' });
    }
  });
};
