import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import type { Logger } from './util/logger.js';

export interface ServerDeps {
  logger: Logger;
  pingDb: () => Promise<void>;
}

export function buildServer({ logger, pingDb }: ServerDeps) {
  const app = Fastify({
    loggerInstance: logger,
    // Render terminates TLS in front of the service.
    trustProxy: true,
  });

  app.register(healthRoutes, { pingDb });

  return app;
}
