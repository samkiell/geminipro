import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentReply } from '../src/agent/agent.js';
import type { BuyerServices, ToolContext } from '../src/agent/tools.js';
import { createBot, type BotDeps } from '../src/bot/bot.js';
import { messages, users } from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';

const logger = createLogger({ level: 'silent' });
const botInfo = {
  id: 1,
  is_bot: true,
  first_name: 'gemini pro',
  username: 'geminiprosamkiel_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as UserFromGetMe;
const CHECKOUT = 'https://sandbox-checkout.bachs.io/c/abc';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let apiCalls: { method: string; payload: Record<string, unknown> }[];
let agentInputs: { userText: string; historyLength: number; telegramId: number }[];
let agentReply: (ctx: ToolContext) => AgentReply;
let paymentCalls: [number, number][];
let updateId = 1;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  apiCalls = [];
  agentInputs = [];
  paymentCalls = [];
  agentReply = () => ({ text: 'hi, how can i help?', failed: false, toolCalls: [] });
});

const services: BuyerServices = {
  getPrice: (quantity) => ({ quantity, baseNgn: 3500 * quantity, feeNgn: 0, totalNgn: 3500 * quantity }),
  checkAvailability: async () => ({ canSell: true, maxQuantity: 10 }),
  createPaymentLink: async (telegramId, quantity) => {
    paymentCalls.push([telegramId, quantity]);
    return { ok: true, orderId: 'o1', quantity, totalNgn: 3500 * quantity, expiresInMinutes: 15, checkoutUrl: CHECKOUT };
  },
  getMyOrders: async () => [],
  resendMyLinks: async () => ({ sent: 1 }),
  cancelPendingOrder: async () => ({ cancelled: false }),
  escalate: async () => ({ supportWhatsapp: '08087357158' }),
};

function makeBot(overrides: Partial<BotDeps> = {}): Bot {
  const bot = createBot({
    token: '123:test',
    botInfo,
    db: testDb.db,
    logger,
    services,
    agent: async ({ history, userText, ctx }) => {
      agentInputs.push({ userText, historyLength: history.length, telegramId: ctx.telegramId });
      return agentReply(ctx);
    },
    facts: { unitPriceNgn: 3500, grossUp: false, supportWhatsapp: '08087357158', maxQtyPerOrder: 10, offerDeadline: '2026-10-29' },
    ...overrides,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 42, type: 'private' }, text: '' } : true;
    return { ok: true, result } as never;
  });
  return bot;
}

function message(text: string, { chatType = 'private', from = 42 } = {}): Update {
  const command = text.startsWith('/') ? text.split(' ')[0] ?? '' : '';
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat: chatType === 'private' ? { id: from, type: 'private', first_name: 'Sam' } : { id: -100, type: 'group', title: 'g' },
      from: { id: from, is_bot: false, first_name: 'Sam', username: 'samkieldev' },
      text,
      ...(command && { entities: [{ type: 'bot_command', offset: 0, length: command.length }] }),
    },
  } as Update;
}

const sentMessages = () => apiCalls.filter((c) => c.method === 'sendMessage');
const buttonsOf = (call: { payload: Record<string, unknown> } | undefined) =>
  ((call?.payload.reply_markup as { inline_keyboard?: { text: string; url?: string; callback_data?: string }[][] })
    ?.inline_keyboard ?? []).flat();

describe('bot', () => {
  it('/start greets with the buy, price and support buttons and saves the user', async () => {
    await makeBot().handleUpdate(message('/start'));
    const [reply] = sentMessages();
    expect(reply?.payload.text).toContain('₦3,500');
    expect(buttonsOf(reply).map((b) => b.callback_data ?? b.url)).toEqual(['buy:1', 'price', 'https://wa.me/2348087357158']);
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, 42));
    expect(user).toMatchObject({ username: 'samkieldev', firstName: 'Sam', blocked: false });
  });

  it('/buy 3 creates a payment link for the sender and shows the pay now button', async () => {
    await makeBot().handleUpdate(message('/buy 3'));
    expect(paymentCalls).toEqual([[42, 3]]);
    const [reply] = sentMessages();
    expect(reply?.payload.text).toContain('3 links, total ₦10,500');
    expect(buttonsOf(reply)).toEqual([{ text: 'pay now', url: CHECKOUT }]);
  });

  it('free text goes to the agent with history, and the turn is saved', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('hello'));
    await bot.handleUpdate(message('how much?'));
    expect(agentInputs).toEqual([
      { userText: 'hello', historyLength: 0, telegramId: 42 },
      { userText: 'how much?', historyLength: 2, telegramId: 42 },
    ]);
    const saved = await testDb.db.select().from(messages).where(eq(messages.telegramId, 42));
    expect(saved.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:hello',
      'assistant:hi, how can i help?',
      'user:how much?',
      'assistant:hi, how can i help?',
    ]);
  });

  it('attaches the pay now button when the agent created an order', async () => {
    agentReply = (ctx) => {
      ctx.payButton = { orderId: 'o1', url: CHECKOUT, quantity: 1, totalNgn: 3500 };
      return { text: 'that is ₦3,500. tap pay now below.', failed: false, toolCalls: [], payButton: ctx.payButton };
    };
    await makeBot().handleUpdate(message('i want one link'));
    const [reply] = sentMessages();
    expect(reply?.payload.text).toBe('that is ₦3,500. tap pay now below.');
    expect(buttonsOf(reply)).toEqual([{ text: 'pay now', url: CHECKOUT }]);
  });

  it('falls back to a scripted reply with buttons when the agent fails', async () => {
    agentReply = () => ({ text: '', failed: true, toolCalls: [] });
    await makeBot().handleUpdate(message('how much is it'));
    const [reply] = sentMessages();
    expect(reply?.payload.text).toContain('₦3,500 per link');
    expect(buttonsOf(reply).map((b) => b.text)).toEqual(['buy 1 link', 'price', 'whatsapp support']);
  });

  it('rate limits a user, warning once', async () => {
    const bot = makeBot({ rateLimit: { max: 2, windowMs: 60_000 } });
    for (const text of ['a', 'b', 'c', 'd']) await bot.handleUpdate(message(text));
    expect(agentInputs).toHaveLength(2);
    expect(sentMessages().map((c) => c.payload.text)).toContain(
      "you're sending a lot of messages. give me a few minutes, then try again.",
    );
    expect(sentMessages()).toHaveLength(3);
  });

  it('ignores group chats', async () => {
    await makeBot().handleUpdate(message('hello', { chatType: 'group' }));
    expect(apiCalls).toHaveLength(0);
    expect(agentInputs).toHaveLength(0);
  });
});

describe('POST /telegram/webhook', () => {
  it('rejects requests without the secret token and accepts the right one', async () => {
    const bot = makeBot();
    const app = buildServer({ logger, pingDb: async () => {}, telegram: { bot, secretToken: 'right-secret-token' } });
    const update = message('/start');

    const missing = await app.inject({ method: 'POST', url: '/telegram/webhook', payload: update });
    const wrong = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      payload: update,
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(sentMessages()).toHaveLength(0);

    const ok = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'right-secret-token' },
      payload: update,
    });
    expect(ok.statusCode).toBe(200);
    expect(sentMessages()).toHaveLength(1);
    await app.close();
  });
});
