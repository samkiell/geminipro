import Fastify from 'fastify';
import { bachsWebhookRoutes, type BachsWebhookOptions } from './routes/bachs.js';
import { healthRoutes } from './routes/health.js';
import type { Logger } from './util/logger.js';

export interface ServerDeps {
  logger: Logger;
  pingDb: () => Promise<void>;
  bachsWebhook?: BachsWebhookOptions;
}

export function buildServer({ logger, pingDb, bachsWebhook }: ServerDeps) {
  const app = Fastify({
    loggerInstance: logger,
    // Render terminates TLS in front of the service.
    trustProxy: true,
  });

  app.register(healthRoutes, { pingDb });
  if (bachsWebhook) app.register(bachsWebhookRoutes, bachsWebhook);

  return app;
}
