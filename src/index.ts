import { fileURLToPath } from 'node:url';
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot } from 'grammy';
import Groq from 'groq-sdk';
import { createBrain } from './agent/brain.js';
import { groqTransport, ModelPool } from './agent/llm.js';
import { sendPaymentNudges } from './agent/nudge.js';
import { promptFacts } from './agent/prompt.js';
import { createUsage } from './agent/usage.js';
import { registerAdmin } from './bot/admin.js';
import { registerBot } from './bot/bot.js';
import { createFlows } from './bot/flows.js';
import { grammyPort } from './bot/telegram.js';
import type { UiFacts } from './bot/views.js';
import { botLink, ConfigError, loadConfig, loadDotEnv, localPhone, type Config } from './config.js';
import { createDb } from './db/client.js';
import { startMockReseller } from './dev/mock-reseller.js';
import { buildServer } from './server.js';
import { BachsClient, BachsProvider } from './services/bachs.js';
import { createErrorAlerts } from './services/error-alerts.js';
import { createFulfilment } from './services/fulfilment.js';
import { saveLead } from './services/leads.js';
import { createNotifier, type Notify } from './services/notifier.js';
import { reservedUnits } from './services/orders.js';
import { pricingFromConfig } from './services/pricing.js';
import { createProof, seedProof } from './services/proof.js';
import { createCountdownRunner } from './services/countdown.js';
import { createReconciler } from './services/reconciler.js';
import { createReferrals, type ReferralConfig } from './services/referrals.js';
import { sendActivationReminders } from './services/reminders.js';
import { createResellerClient } from './services/reseller.js';
import { getSetting, isPaused, setSetting } from './services/settings.js';
import { createLogger, type Logger } from './util/logger.js';
import { withTimeout } from './util/time.js';

/** settings key set by the live shop (production with a live Bachs key) on its database. */
const LIVE_DATABASE = 'live_shop_database';

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
  // In production every error and crash also goes to the owner's Telegram, email and ntfy.
  const errorAlerts = createErrorAlerts();
  const logger = createLogger({
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    pretty: config.NODE_ENV === 'development',
    ...(config.NODE_ENV === 'production' && { errorStream: errorAlerts.stream }),
  });
  // Logged (and so alerted) instead of crashing the bot.
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception, restarting');
    void errorAlerts.flush().finally(() => process.exit(1));
  });
  // The count only, never the ids. Without admins, /admin and friends answer "i don't know that command".
  const adminCount = config.ADMIN_TELEGRAM_IDS.length;
  if (adminCount === 0) logger.warn('no admin ids configured: set ADMIN_TELEGRAM_IDS (send /myid to the bot to get yours)');
  else logger.info({ adminCount }, 'admin ids configured');

  const database = createDb(config.DATABASE_URL);
  const db = database.db;
  try {
    await withTimeout(database.ping(), 10_000, 'database ping');
    logger.info('database reachable');
  } catch (err) {
    // Keep booting: Neon may still be waking up, and /health reports the state.
    logger.error({ err }, 'database not reachable at boot');
  }

  // The live shop marks its database. Any other run on it (a local `pnpm dev` with the same
  // DATABASE_URL) would buy mock links for real orders, so it refuses to start; one already running
  // stands down at its next reconciler tick.
  const liveShop = config.NODE_ENV === 'production' && config.BACHS_SECRET_KEY.startsWith('sk_live_');
  const isLiveDatabase = async () => (await getSetting<boolean>(db, LIVE_DATABASE)) === true;
  if (!liveShop && (await isLiveDatabase().catch(() => false))) {
    logger.fatal('DATABASE_URL is the live shop database. Use a separate Neon branch and a test bot token for local runs.');
    process.exit(1);
  }
  let liveMarked = false;
  const reconcilerActive = async (): Promise<boolean> => {
    if (!liveShop) return !(await isLiveDatabase());
    if (!liveMarked) {
      await setSetting(db, LIVE_DATABASE, true);
      liveMarked = true;
    }
    return true;
  };

  if (config.RESELLER_MOCK) await startInProcessMockReseller(config, logger);

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
    ...(config.NTFY_SERVER && { ntfyServer: config.NTFY_SERVER.replace(/\/+$/, '') }),
  });
  errorAlerts.attach(notify);

  const facts: UiFacts = {
    unitPriceNgn: config.UNIT_PRICE_NGN,
    grossUp: config.GROSS_UP,
    supportIntl: config.SUPPORT_WHATSAPP_INTL,
    supportLocal: localPhone(config.SUPPORT_WHATSAPP_INTL),
    maxQtyPerOrder: config.MAX_QTY_PER_ORDER,
    paymentWindowMinutes: config.BACHS_SESSION_TTL_MINUTES,
  };
  const payments = new BachsProvider(
    new BachsClient({ secretKey: config.BACHS_SECRET_KEY, ...(config.BACHS_BASE_URL && { baseUrl: config.BACHS_BASE_URL }), logger }),
    config.BACHS_WEBHOOK_SECRET,
  );
  const reseller = createResellerClient(config, logger);
  const pricing = pricingFromConfig(config);
  const referral: ReferralConfig = {
    threshold: config.REFERRAL_THRESHOLD,
    maxRewards: config.REFERRAL_MAX_REWARDS,
    botUsername: config.TELEGRAM_BOT_USERNAME,
  };

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
    gateChannel: config.GATE_CHANNEL,
    gateChannelUrl: config.GATE_CHANNEL_URL,
    adminUserIds: config.ADMIN_TELEGRAM_IDS,
    paymentWindowMinutes: config.BACHS_SESSION_TTL_MINUTES,
    referral,
  });
  const fulfilment = createFulfilment({
    db,
    reseller,
    productId: config.RESELLER_PRODUCT_ID,
    port,
    facts,
    notify,
    logger,
    confettiEffectId: config.MESSAGE_EFFECT_CONFETTI,
    onChange: flows.orderChanged,
    // Late bound: referrals fulfil their rewards through this same engine. Not awaited, so the
    // finished order frees its fulfilment slot before a reward needs one (no slot deadlock).
    onDelivered: async (orderId) => {
      void referrals.orderDelivered(orderId).catch((err: unknown) => logger.error({ err, orderId }, 'referral handling failed'));
    },
  });
  const referrals = createReferrals({
    db,
    port,
    logger,
    notify,
    reseller,
    fulfil: (orderId) => fulfilment.fulfil(orderId),
    config: referral,
  });

  const usage = createUsage({ db, notify, logger });
  const pool = new ModelPool(groqTransport(new Groq({ apiKey: config.GROQ_API_KEY })), [...new Set(config.GROQ_MODELS)], {
    logger,
    maxInFlight: config.LLM_CONCURRENCY,
    onCall: usage.call,
  });
  const brain = createBrain({
    db,
    pool,
    facts: promptFacts(config),
    // Facts for the prompt, from the reseller client's 10 second cache.
    availability: async () => {
      if (await isPaused(db)) return { canSell: false, maxQuantity: 0, reason: 'sales are paused' };
      if (config.SALES_CUTOFF && new Date() >= config.SALES_CUTOFF) return { canSell: false, maxQuantity: 0, reason: 'sales have closed' };
      return reseller.getAvailability(await reservedUnits(db));
    },
  });
  const proofDir = fileURLToPath(new URL('../assets/proof', import.meta.url));
  const proof = createProof({ db, port, facts, notify, logger, dir: proofDir });
  const seeded = await seedProof(db, proofDir).catch((err: unknown) => {
    logger.warn({ err }, 'proof screenshots not seeded');
    return 0;
  });
  if (seeded > 0) logger.info({ seeded }, 'proof screenshots added from assets/proof');

  registerBot(bot, {
    db,
    logger,
    port,
    flows,
    facts,
    pricing,
    brain,
    proof,
    usage,
    saveLead: (telegramId, username, summary) => saveLead(db, notify, { telegramId, username, summary }),
    notify,
    adminIds: config.ADMIN_TELEGRAM_IDS,
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
        proof,
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
    sendNudges: () => sendPaymentNudges({ db, port, facts, logger }),
    sendReminders: () => sendActivationReminders({ db, port, logger, delayMinutes: config.REMINDER_DELAY_MINUTES }),
    grantRewards: () => referrals.grantPending(),
    summaryEveryHours: config.SUMMARY_EVERY_HOURS,
    active: reconcilerActive,
  });

  const countdown = createCountdownRunner({
    db,
    port,
    facts,
    logger,
    onChange: flows.orderChanged,
  });
  countdown.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      countdown.stop();
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
    // Never take over a webhook: it belongs to the deployed bot, and grammY's start() deletes it.
    const webhook = await bot.api.getWebhookInfo().then(
      (info) => info.url,
      () => '',
    );
    if (webhook) {
      logger.error({ webhook: new URL(webhook).host }, 'this bot has a webhook (the deployed shop), so not polling. use a test bot token for local runs');
    } else {
      bot
        .start({ onStart: () => logger.info('telegram long polling started (development)') })
        .catch((err: unknown) => logger.error({ err: (err as Error).message }, 'telegram polling stopped'));
    }
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
 * Sandbox only (config refuses RESELLER_MOCK=true with a live Bachs key): run the in-memory mock
 * reseller inside the app, so a sandbox payment is fulfilled end to end, locally or on Render.
 * It listens on 127.0.0.1 only.
 */
async function startInProcessMockReseller(config: Config, logger: Logger): Promise<void> {
  const port = Number(new URL(config.RESELLER_MOCK_URL).port);
  try {
    const { url } = await startMockReseller({ port });
    logger.info({ url }, 'mock reseller running (RESELLER_MOCK=true)');
  } catch (err) {
    logger.warn({ err }, 'could not start the mock reseller here; is `pnpm mock:reseller` already running?');
  }
}

main().catch((err: unknown) => {
  console.error('fatal: failed to boot', err);
  process.exit(1);
});
