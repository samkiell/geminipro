import { ConfigError, loadConfig, loadDotEnv, type Config } from './config.js';
import { createDb } from './db/client.js';
import { buildServer } from './server.js';
import { BachsClient } from './services/bachs.js';
import { telegramSender } from './services/delivery.js';
import { createFulfilment } from './services/fulfilment.js';
import { logNotifier, type Notify } from './services/notifier.js';
import { createResellerClient } from './services/reseller.js';
import { createLogger, type Logger } from './util/logger.js';
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

  if (config.RESELLER_MOCK && config.NODE_ENV === 'development') await startDevMockReseller(config, logger);

  const notify = logNotifier(logger);
  const bachs = new BachsClient({ secretKey: config.BACHS_SECRET_KEY, logger });
  const fulfilment = createFulfilment({
    db: database.db,
    reseller: createResellerClient(config, logger),
    productId: config.RESELLER_PRODUCT_ID,
    send: telegramSender(config.TELEGRAM_BOT_TOKEN),
    notify,
    logger,
    supportWhatsapp: config.SUPPORT_WHATSAPP,
  });

  const app = buildServer({
    logger,
    pingDb: database.ping,
    bachsWebhook: {
      db: database.db,
      bachs,
      webhookSecret: config.BACHS_WEBHOOK_SECRET,
      notify,
      onPaid: async (orderId) => {
        await fulfilment.fulfil(orderId);
      },
    },
  });

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
  if (!config.BACHS_WEBHOOK_SECRET) {
    notify({
      level: 'warning',
      title: 'payment webhooks are off',
      body: 'BACHS_WEBHOOK_SECRET is not set, so Bachs webhooks get 503 and no order can be marked paid.',
    });
  }
  void checkFeeSetup(bachs, config, notify, logger);
}

/** GROSS_UP must agree with the Bachs account's fee_preference, or fees are lost or charged twice. */
async function checkFeeSetup(bachs: BachsClient, config: Config, notify: Notify, logger: Logger): Promise<void> {
  try {
    const preference = await bachs.getFeePreference();
    logger.info({ feePreference: preference, grossUp: config.GROSS_UP }, 'bachs fee setup');
    if (!config.GROSS_UP && preference === 'org_pays') {
      notify({
        level: 'warning',
        title: 'payment fees are coming out of revenue',
        body: 'Bachs fee_preference is org_pays and GROSS_UP=false. Set customer_pays in the Bachs dashboard, or GROSS_UP=true.',
      });
    }
    if (config.GROSS_UP && preference === 'customer_pays') {
      notify({
        level: 'critical',
        title: 'buyers are charged the fee twice',
        body: 'Bachs fee_preference is customer_pays and GROSS_UP=true. Set GROSS_UP=false.',
      });
    }
  } catch (err) {
    logger.warn({ err }, 'could not read the Bachs fee setup');
  }
}

/**
 * Dev convenience: run the in-memory mock reseller inside `pnpm dev`, so a sandbox payment can be
 * fulfilled without a second terminal. The mock lives in test/, so it only exists under tsx.
 */
async function startDevMockReseller(config: Config, logger: Logger): Promise<void> {
  const port = Number(new URL(config.RESELLER_MOCK_URL).port);
  const modulePath = '../test/mocks/reseller-server.js';
  try {
    const mock = (await import(modulePath)) as {
      startMockReseller: (options: { port: number }) => Promise<{ url: string }>;
    };
    const { url } = await mock.startMockReseller({ port });
    logger.info({ url }, 'mock reseller running (RESELLER_MOCK=true)');
  } catch (err) {
    logger.warn({ err }, 'could not start the mock reseller here; run `pnpm mock:reseller` if purchases fail');
  }
}

main().catch((err: unknown) => {
  console.error('fatal: failed to boot', err);
  process.exit(1);
});
