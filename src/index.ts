import { ConfigError, loadConfig, loadDotEnv, type Config } from './config.js';
import { createDb } from './db/client.js';
import { buildServer } from './server.js';
import { createLogger } from './util/logger.js';
import { withTimeout } from './util/time.js';

function readConfig(): Config {
  loadDotEnv();
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    pretty: config.NODE_ENV === 'development',
  });

  const database = createDb(config.DATABASE_URL);
  try {
    await withTimeout(database.ping(), 10_000, 'database ping');
    logger.info('database reachable');
  } catch (err) {
    // Keep booting: Neon may still be waking up, and /health reports the state.
    logger.error({ err }, 'database not reachable at boot');
  }

  const app = buildServer({ logger, pingDb: database.ping });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await database.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: '0.0.0.0', port: config.PORT });
}

main().catch((err: unknown) => {
  console.error('fatal: failed to boot', err);
  process.exit(1);
});
