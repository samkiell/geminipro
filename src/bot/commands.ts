// The command menus Telegram shows (registered by `pnpm webhook:set`). Buyers see exactly four;
// admins also see the admin list, in their own chats only.

export const BUYER_COMMANDS = [
  { command: 'buy', description: 'get a gemini pro link' },
  { command: 'history', description: 'your orders and links' },
  { command: 'help', description: 'how it works and support' },
  { command: 'start', description: 'restart the bot' },
];

export const ADMIN_COMMANDS = [
  { command: 'admin', description: 'admin panel' },
  { command: 'balance', description: 'reseller balance and links it covers' },
  { command: 'stats', description: 'sales today and total' },
  { command: 'allorders', description: 'last 10 orders' },
  { command: 'order', description: 'one order: /order GP-1042' },
  { command: 'resend', description: 'resend links: /resend GP-1042' },
  { command: 'replace', description: 'buy and send a replacement: /replace GP-1042' },
  { command: 'pause', description: 'stop sales' },
  { command: 'resume', description: 'restart sales' },
  { command: 'offertext', description: 'show or set the offer line' },
  { command: 'leads', description: 'latest business inquiries' },
  { command: 'proofs', description: 'proof screenshots (add: send a photo captioned /addproof)' },
  { command: 'delproof', description: 'remove a proof screenshot: /delproof 2' },
];
