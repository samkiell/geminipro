// Creates a sandbox order and prints its Bachs checkout link, to test pay -> webhook -> delivery
// before the Telegram chat exists.
//
//   pnpm order:test [quantity] [telegramId]   create an order (default: 1 link, first admin id)
//   pnpm order:test --cancel [telegramId]     cancel that user's unpaid order
//
// Needs `pnpm dev` running (it serves the webhook and runs the mock reseller), reachable by Bachs
// through ngrok with BACHS_WEBHOOK_SECRET set, and the buyer must have pressed Start on the bot.

import { botLink, loadConfig, loadDotEnv } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { BachsClient } from '../src/services/bachs.js';
import { cancelPendingOrder, createOrder } from '../src/services/orders.js';
import { pricingFromConfig } from '../src/services/pricing.js';
import { createResellerClient } from '../src/services/reseller.js';

const print = (line = '') => process.stdout.write(`${line}\n`);

loadDotEnv();
const config = loadConfig();
if (!config.BACHS_SECRET_KEY.startsWith('sk_sandbox_')) {
  print('Refusing to run: this script is for the Bachs sandbox, but BACHS_SECRET_KEY is not an sk_sandbox_ key.');
  process.exit(1);
}

const args = process.argv.slice(2);
const cancel = args[0] === '--cancel';
const numbers = (cancel ? args.slice(1) : args).map(Number);
const quantity = cancel ? 0 : (numbers[0] ?? 1);
const telegramId = (cancel ? numbers[0] : numbers[1]) ?? config.ADMIN_TELEGRAM_IDS[0];
if (telegramId === undefined || !Number.isInteger(telegramId)) {
  print('No Telegram id: pass one, or set ADMIN_TELEGRAM_IDS.');
  process.exit(1);
}

const database = createDb(config.DATABASE_URL);
try {
  if (cancel) {
    const cancelled = await cancelPendingOrder(database.db, telegramId);
    print(cancelled ? `Cancelled order ${cancelled.id}.` : `User ${telegramId} has no unpaid order.`);
  } else {
    const result = await createOrder(
      {
        db: database.db,
        reseller: createResellerClient(config),
        bachs: new BachsClient({ secretKey: config.BACHS_SECRET_KEY }),
        pricing: pricingFromConfig(config),
        maxQtyPerOrder: config.MAX_QTY_PER_ORDER,
        salesCutoff: config.SALES_CUTOFF,
        returnUrl: botLink(config),
      },
      { telegramId, quantity },
    );

    if (result.ok) {
      print(`Order ${result.order.id}: ${quantity} link(s) for Telegram user ${telegramId}`);
      print(`Amount: NGN ${result.order.amountNgn}, expires ${result.order.expiresAt?.toISOString()}`);
      print();
      print(`Pay here: ${result.checkoutUrl}`);
      print();
      print('Sandbox card 4242 4242 4242 4242, any future expiry and CVC. 4000 0000 0000 0002 is declined.');
      print(`When Bachs calls the webhook, the link arrives in Telegram from ${botLink(config)}.`);
    } else if (result.reason === 'pending_exists') {
      print(`User ${telegramId} already has an unpaid order ${result.order.id}.`);
      print(`Pay it: ${result.order.checkoutUrl ?? '(no checkout link)'}`);
      print('Or cancel it: pnpm order:test --cancel');
    } else if (result.reason === 'unavailable') {
      print(`Not available: can sell ${result.maxQuantity} right now.`);
      if (config.RESELLER_MOCK) print(`Is the mock reseller up at ${config.RESELLER_MOCK_URL}? It starts with pnpm dev.`);
    } else {
      print(`Not created: ${result.reason}${result.reason === 'invalid_quantity' ? ` (1 to ${result.maxQuantity})` : ''}.`);
    }
  }
} finally {
  await database.close();
}
