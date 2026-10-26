import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';
import Groq from 'groq-sdk';
import { createAgentActions } from './agent/actions.js';
import { writeNudge } from './agent/agent.js';
import { groqTransport, ModelPool } from './agent/llm.js';
import { sendPaymentNudges } from './agent/nudge.js';
import { promptFacts } from './agent/prompt.js';
import { createTools } from './agent/tools.js';
import { createAgentTurn } from './agent/turn.js';
import { registerAdmin } from './bot/admin.js';
import { registerBot } from './bot/bot.js';
import { createFlows } from './bot/flows.js';
import { grammyPort } from './bot/telegram.js';
import type { UiFacts } from './bot/views.js';
import { botLink, ConfigError, loadConfig, loadDotEnv, localPhone, type Config } from './config.js';
import { createDb } from './db/client.js';
import { buildServer } from './server.js';
import { BachsClient, BachsProvider } from './services/bachs.js';
import { createFulfilment } from './services/fulfilment.js';
import { saveLead } from './services/leads.js';
import { createNotifier, type Notify } from './services/notifier.js';
import { PAYMENT_WINDOW_MINUTES } from './services/orders.js';
import { pricingFromConfig } from './services/pricing.js';
import { createReconciler } from './services/reconciler.js';
import { sendActivationReminders } from './services/reminders.js';
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
  const db = database.db;
  try {
    await withTimeout(database.ping(), 10_000, 'database ping');
    logger.info('database reachable');
  } catch (err) {
    // Keep booting: Neon may still be waking up, and /health reports the state.
    logger.error({ err }, 'database not reachable at boot');
  }

  if (config.RESELLER_MOCK && config.NODE_ENV === 'development') await startDevMockReseller(config, logger);

  // One Bot API client for everything we send: timeouts, and Telegram's own 429s retried.
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, { client: { timeoutSeconds: 15 } });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 10 }));
  const port = grammyPort(bot.api);

  const notify = createNotifier({
    logger,
    db,
    port,
    adminIds: config.ADMIN_TELEGRAM_IDS,
    alertEmail: config.ALERT_EMAIL,
    alertEmailFrom: config.ALERT_EMAIL_FROM,
    resendApiKey: config.RESEND_API_KEY,
    ntfyTopic: config.NTFY_TOPIC,
  });

  const facts: UiFacts = {
    unitPriceNgn: config.UNIT_PRICE_NGN,
    grossUp: config.GROSS_UP,
    supportIntl: config.SUPPORT_WHATSAPP_INTL,
    supportLocal: localPhone(config.SUPPORT_WHATSAPP_INTL),
    maxQtyPerOrder: config.MAX_QTY_PER_ORDER,
    paymentWindowMinutes: PAYMENT_WINDOW_MINUTES,
  };
  const payments = new BachsProvider(
    new BachsClient({ secretKey: config.BACHS_SECRET_KEY, ...(config.BACHS_BASE_URL && { baseUrl: config.BACHS_BASE_URL }), logger }),
    config.BACHS_WEBHOOK_SECRET,
  );
  const reseller = createResellerClient(config, logger);
  const pricing = pricingFromConfig(config);

  const flows = createFlows({
    db,
    port,
    logger,
    reseller,
    payments,
    pricing,
    facts,
    salesCutoff: config.SALES_CUTOFF,
    returnUrl: botLink(config),
    notify,
  });
  const fulfilment = createFulfilment({
    db,
    reseller,
    productId: config.RESELLER_PRODUCT_ID,
    port,
    facts,
    notify,
    logger,
    onChange: flows.orderChanged,
  });

  const pool = new ModelPool(
    groqTransport(new Groq({ apiKey: config.GROQ_API_KEY })),
    [...new Set([config.GROQ_MODEL, ...config.GROQ_FALLBACK_MODELS])],
    { logger },
  );
  const tools = createTools(
    createAgentActions({
      db,
      flows,
      reseller,
      pricing,
      salesCutoff: config.SALES_CUTOFF,
      supportIntl: facts.supportIntl,
      supportLocal: facts.supportLocal,
      notify,
    }),
    { maxQtyPerOrder: config.MAX_QTY_PER_ORDER },
  );
  registerBot(bot, {
    db,
    logger,
    port,
    flows,
    facts,
    agent: createAgentTurn({ db, pool, tools, facts: promptFacts(config), logger }),
    saveLead: (telegramId, username, summary) => saveLead(db, notify, { telegramId, username, summary }),
    notify,
    registerAdmin: (b) =>
      registerAdmin(b, {
        db,
        port,
        logger,
        facts,
        adminIds: config.ADMIN_TELEGRAM_IDS,
        reseller,
        productId: config.RESELLER_PRODUCT_ID,
        flows,
        notify,
      }),
  });
  try {
    await withTimeout(bot.init(), 15_000, 'telegram getMe');
    logger.info({ bot: bot.botInfo.username }, 'telegram bot ready');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'telegram bot could not start; check TELEGRAM_BOT_TOKEN');
  }

  // Locally there is no public URL for Telegram, so poll. Polling removes any webhook on this bot:
  // run `pnpm webhook:set` again before relying on the deployed service.
  const polling = config.NODE_ENV === 'development';

  const app = buildServer({
    logger,
    pingDb: database.ping,
    bachsWebhook: {
      db,
      payments,
      notify,
      onPaid: async (orderId) => {
        await fulfilment.fulfil(orderId);
      },
      onChange: flows.orderChanged,
    },
    ...(!polling && { telegram: { bot, secretToken: config.TELEGRAM_WEBHOOK_SECRET } }),
  });

  const reconciler = createReconciler({
    db,
    logger,
    notify,
    flows,
    fulfil: (orderId) => fulfilment.fulfil(orderId),
    payments,
    reseller,
    productId: config.RESELLER_PRODUCT_ID,
    lowBalanceLinks: config.LOW_BALANCE_ORDERS,
    sendNudges: () => sendPaymentNudges({ db, port, facts, logger, write: (order) => writeNudge(pool, order) }),
    sendReminders: () => sendActivationReminders({ db, port, logger, delayMinutes: config.REMINDER_DELAY_MINUTES }),
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      reconciler.stop();
      if (polling) await bot.stop();
      await app.close();
      await flows.whenIdle();
      await notify.settled();
      await database.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  if (polling) {
    bot
      .start({ onStart: () => logger.info('telegram long polling started (development)') })
      .catch((err: unknown) => logger.error({ err: (err as Error).message }, 'telegram polling stopped'));
  }
  reconciler.start();
  notify({
    level: 'info',
    title: 'service started',
    body: `The bot (re)started${config.RESELLER_MOCK ? ' in sandbox mode' : ''}. Anything missed while it was down is being caught up.`,
    cooldownKey: 'boot',
  });
  if (!payments.webhookConfigured) {
    notify({
      level: 'warning',
      title: 'payment webhooks are off',
      body: 'BACHS_WEBHOOK_SECRET is not set, so Bachs webhooks get 503 and no order can be marked paid.',
      cooldownKey: 'webhooks_off',
    });
  }
  void checkFeeSetup(payments, config, notify, logger);
}

/** GROSS_UP must agree with the Bachs account's fee_preference, or fees are lost or charged twice. */
async function checkFeeSetup(payments: BachsProvider, config: Config, notify: Notify, logger: Logger): Promise<void> {
  try {
    const preference = await payments.getFeePreference();
    logger.info({ feePreference: preference, grossUp: config.GROSS_UP }, 'bachs fee setup');
    if (!config.GROSS_UP && preference === 'org_pays') {
      notify({
        level: 'warning',
        title: 'payment fees are coming out of revenue',
        body: 'Bachs fee_preference is org_pays and GROSS_UP=false. Set customer_pays in the Bachs dashboard, or GROSS_UP=true.',
        cooldownKey: 'fees',
      });
    }
    if (config.GROSS_UP && preference === 'customer_pays') {
      notify({
        level: 'critical',
        title: 'buyers are charged the fee twice',
        body: 'Bachs fee_preference is customer_pays and GROSS_UP=true. Set GROSS_UP=false.',
        cooldownKey: 'fees',
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
