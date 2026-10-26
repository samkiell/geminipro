// Points Telegram at the deployed service and registers the command menus.
//
//   pnpm webhook:set
//
// Needs PUBLIC_URL (https), TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and ADMIN_TELEGRAM_IDS.
// Run it after every deploy to a new URL, and after testing locally (polling removes the webhook).

import { Api } from 'grammy';
import { ADMIN_COMMANDS, BUYER_COMMANDS } from '../src/bot/commands.js';
import { loadConfig, loadDotEnv } from '../src/config.js';

const print = (line = '') => process.stdout.write(`${line}\n`);

loadDotEnv();
const config = loadConfig();
const base = config.PUBLIC_URL.replace(/\/+$/, '');
if (!base.startsWith('https://')) {
  print(`PUBLIC_URL must be https (Telegram and Bachs refuse anything else); it is ${base}`);
  process.exit(1);
}

const api = new Api(config.TELEGRAM_BOT_TOKEN, { timeoutSeconds: 20 });
const telegramUrl = `${base}/telegram/webhook`;

await api.setWebhook(telegramUrl, {
  secret_token: config.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: false,
});
await api.setMyCommands(BUYER_COMMANDS);
for (const chatId of config.ADMIN_TELEGRAM_IDS) {
  await api.setMyCommands([...ADMIN_COMMANDS, ...BUYER_COMMANDS], { scope: { type: 'chat', chat_id: chatId } });
}
const info = await api.getWebhookInfo();

print(`telegram webhook: ${info.url}`);
print(`  pending updates: ${info.pending_update_count}${info.last_error_message ? `, last error: ${info.last_error_message}` : ''}`);
print(`commands: ${BUYER_COMMANDS.length} for buyers, ${ADMIN_COMMANDS.length} more for ${config.ADMIN_TELEGRAM_IDS.length} admin(s)`);
print();
print('bachs: add this webhook endpoint in the developer portal (sandbox and live separately):');
print(`  url:    ${base}/bachs/webhook`);
print('  events: checkout.completed, collection.succeeded, checkout.expired');
print('  then put its signing secret in BACHS_WEBHOOK_SECRET and redeploy.');
