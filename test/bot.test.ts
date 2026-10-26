import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentReply } from '../src/agent/agent.js';
import type { ToolContext } from '../src/agent/tools.js';
import { registerBot, type BotDeps } from '../src/bot/bot.js';
import { createFlows, type Flows } from '../src/bot/flows.js';
import { messages, users } from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import { computeAvailability } from '../src/services/reseller.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';

const logger = createLogger({ level: 'silent' });
const BUYER = 42;
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

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tg: FakePort;
let flows: Flows;
let agentAvailable: boolean;
let agentReply: (ctx: ToolContext) => AgentReply;
let agentCalls: string[];
let leads: string[];
let updateId = 1;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  tg = fakePort();
  agentAvailable = true;
  agentCalls = [];
  leads = [];
  agentReply = () => ({ text: 'hi, how can i help?', failed: false, toolCalls: [] });
  flows = createFlows({
    db: testDb.db,
    port: tg.port,
    logger,
    reseller: {
      getAvailability: async (reserved) =>
        computeAvailability({ balanceCents: 100_000, priceCents: 120, stock: 50, inStock: true, reservedUnits: reserved, maxQtyPerOrder: 10 }),
    },
    payments: {
      createCheckout: async (input) => ({ checkoutId: `chk_${input.orderId.slice(0, 8)}`, checkoutUrl: `https://pay.test/${input.orderId}`, expiresAt: undefined }),
    },
    pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
    facts,
    salesCutoff: undefined,
    returnUrl: undefined,
    notify: () => {},
    statusThrottleMs: 0,
  });
});

function makeBot(overrides: Partial<BotDeps> = {}): Bot {
  const bot = new Bot('123:test', { botInfo });
  bot.api.config.use(async () => ({ ok: true, result: true }) as never);
  registerBot(bot, {
    db: testDb.db,
    logger,
    port: tg.port,
    flows,
    facts,
    agent: {
      available: () => agentAvailable,
      reply: async ({ userText, ctx }) => {
        agentCalls.push(userText);
        return agentReply(ctx);
      },
    },
    saveLead: async (_id, _username, summary) => {
      leads.push(summary);
      return 'saved';
    },
    ...overrides,
  });
  return bot;
}

const from = (id: number) => ({ id, is_bot: false, first_name: 'Sam', username: 'samkieldev' });

function message(text: string, { chatType = 'private', user = BUYER } = {}): Update {
  const command = text.startsWith('/') ? (text.split(' ')[0] ?? '') : '';
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat: chatType === 'private' ? { id: user, type: 'private', first_name: 'Sam' } : { id: -100, type: 'group', title: 'g' },
      from: from(user),
      text,
      ...(command && { entities: [{ type: 'bot_command', offset: 0, length: command.length }] }),
    },
  } as Update;
}

function tap(data: string, messageId: number, user = BUYER): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: `q${updateId}`,
      from: from(user),
      chat_instance: 'c',
      data,
      message: { message_id: messageId, date: 0, chat: { id: user, type: 'private', first_name: 'Sam' } },
    },
  } as Update;
}

describe('commands', () => {
  it('/start greets with buttons and saves the user', async () => {
    await makeBot().handleUpdate(message('/start'));
    expect(tg.sent[0]?.text).toContain('hi sam!');
    expect(tg.buttons(tg.sent[0]?.id).map((b) => b.text)).toEqual(['buy a link', 'my orders', 'how it works', 'help']);
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, BUYER));
    expect(user).toMatchObject({ username: 'samkieldev', firstName: 'Sam', blocked: false });
  });

  it('/buy 3 shows the summary card for 3 and the status message', async () => {
    await makeBot().handleUpdate(message('/buy 3'));
    expect(tg.sent[0]?.text).toContain('quantity: 3 links');
    expect(tg.sent[1]?.text).toContain('⏳ waiting for payment');
  });

  it('/history and /help', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('/history'));
    await bot.handleUpdate(message('/help'));
    expect(tg.sent.map((m) => m.text)).toEqual([
      "you haven't bought anything yet. tap below to get your first link.",
      'how can i help? tap a topic below.',
    ]);
  });

  it('removed and unknown commands get a pointer to the real ones', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('/status'));
    await bot.handleUpdate(message('/balance'));
    expect(tg.textsTo(BUYER)).toEqual([
      "i don't know that command. try /buy, /history or /help.",
      "i don't know that command. try /buy, /history or /help.",
    ]);
  });
});

describe('chat', () => {
  it('free text goes to the agent and the turn is saved', async () => {
    await makeBot().handleUpdate(message('hello there'));
    expect(agentCalls).toEqual(['hello there']);
    const saved = await testDb.db.select().from(messages).where(eq(messages.telegramId, BUYER));
    expect(saved.map((m) => `${m.role}:${m.content}`)).toEqual(['user:hello there', 'assistant:hi, how can i help?']);
  });

  it('buttons on an agent reply disappear when the buyer writes again', async () => {
    agentReply = (ctx) => {
      ctx.attachments.push([{ text: 'portfolio', url: 'https://samkiel.dev' }]);
      return { text: 'i was built by samkiel.', failed: false, toolCalls: [] };
    };
    const bot = makeBot();
    await bot.handleUpdate(message('who made you'));
    const first = tg.sent[0]?.id;
    expect(tg.buttons(first).map((b) => b.text)).toEqual(['portfolio']);
    agentReply = () => ({ text: 'sure.', failed: false, toolCalls: [] });
    await bot.handleUpdate(message('ok thanks'));
    expect(tg.get(first)?.keyboard).toBeUndefined();
  });

  it('opens the card itself when the model answered a clear purchase request without one', async () => {
    agentReply = () => ({ text: '3 links will be ₦10,500 total.', failed: false, toolCalls: [] });
    await makeBot().handleUpdate(message('i need 3 links, can i pay now'));
    expect(tg.sent[0]?.text).toContain('quantity: 3 links');
    expect(tg.sent.at(-1)).toMatchObject({ text: '3 links will be ₦10,500 total.' });
    expect(tg.sent.at(-1)?.keyboard).toBeUndefined();
  });

  it('with no model free, it skips the agent and still opens the order card', async () => {
    agentAvailable = false;
    await makeBot().handleUpdate(message('i need 2 links'));
    expect(agentCalls).toEqual([]);
    expect(tg.sent[0]?.text).toContain('quantity: 2 links');
    const saved = await testDb.db.select().from(messages).where(eq(messages.telegramId, BUYER));
    expect(saved.at(-1)?.content).toBe('[showed the order card for 2]');
  });

  it('a rate limited turn falls back to a scripted reply that fits the question', async () => {
    agentReply = () => ({ text: '', failed: true, failure: 'rate_limited', toolCalls: [] });
    const bot = makeBot();
    await bot.handleUpdate(message('how much is it'));
    expect(tg.sent[0]?.text).toContain('₦3,500');
    expect(agentCalls).toEqual(['how much is it']);
    await bot.handleUpdate(message('where is my link'));
    expect(tg.sent.at(-1)?.text).toBe("you haven't bought anything yet. tap below to get your first link.");
    await bot.handleUpdate(message('can you build me a website'));
    expect(leads).toEqual(['can you build me a website']);
  });

  it('rate limits a user, warning once', async () => {
    const bot = makeBot({ rateLimit: { max: 2, windowMs: 60_000 } });
    for (const text of ['a', 'b', 'c', 'd']) await bot.handleUpdate(message(text));
    expect(agentCalls).toEqual(['a', 'b']);
    expect(tg.textsTo(BUYER).filter((t) => t.startsWith("you're sending a lot"))).toHaveLength(1);
  });

  it('ignores group chats', async () => {
    await makeBot().handleUpdate(message('hello', { chatType: 'group' }));
    expect(tg.sent).toHaveLength(0);
    expect(agentCalls).toHaveLength(0);
  });
});

describe('button taps', () => {
  it('the stepper edits the card in place; a tap on an old card says it expired', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('/buy'));
    const cardId = tg.sent[0]?.id ?? 0;
    const plus = tg.buttons(cardId).find((b) => b.text === '+');
    await bot.handleUpdate(tap(plus && 'data' in plus ? plus.data : '', cardId));
    expect(tg.get(cardId)?.text).toContain('quantity: 2 links');
    expect(tg.sent).toHaveLength(2);

    // the same + again belongs to the replaced order now
    await bot.handleUpdate(tap(plus && 'data' in plus ? plus.data : '', cardId));
    expect(tg.answers.at(-1)?.text).toBe('this button has expired');
  });

  it('cancel collapses the card', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('/buy'));
    const cardId = tg.sent[0]?.id ?? 0;
    const cancel = tg.buttons(cardId).find((b) => b.text === 'cancel');
    await bot.handleUpdate(tap(cancel && 'data' in cancel ? cancel.data : '', cardId));
    await flows.whenIdle();
    expect(tg.get(cardId)?.text).toMatch(/^cancelled · order GP-\d+$/);
    expect(tg.get(cardId)?.keyboard).toBeUndefined();
    expect(tg.answers.at(-1)?.text).toBe('cancelled');
  });

  it('never opens someone else’s order from a tap', async () => {
    const theirs = await insertOrder(testDb.db, { status: 'delivered', telegramId: 99 });
    const bot = makeBot();
    const msg = await tg.port.send(BUYER, { text: 'x', keyboard: [[{ text: 'y', data: `o:${theirs}:1` }]] });
    await bot.handleUpdate(tap(`o:${theirs}:1`, msg));
    await bot.handleUpdate(tap(`l:${theirs}`, msg));
    expect(tg.answers.map((a) => a.text)).toEqual(['this button has expired', 'this button has expired']);
    expect(tg.sent).toHaveLength(1);
  });

  it('help topics, history pages and no-op buttons answer and edit in place', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('/help'));
    const hub = tg.sent[0]?.id ?? 0;
    await bot.handleUpdate(tap('hp:activate', hub));
    expect(tg.get(hub)?.text.split('\n')[0]).toBe('how to activate');
    await bot.handleUpdate(tap('h:1', hub));
    expect(tg.get(hub)?.text).toContain("you haven't bought anything yet");
    await bot.handleUpdate(tap('n', hub));
    await bot.handleUpdate(tap('zz:nope', hub));
    expect(tg.sent).toHaveLength(1);
    expect(tg.answers.at(-1)?.text).toBe('this button has expired');
  });
});

describe('POST /telegram/webhook', () => {
  it('rejects requests without the secret token and accepts the right one', async () => {
    const bot = makeBot();
    const app = buildServer({ logger, pingDb: async () => {}, telegram: { bot, secretToken: 'right-secret-token' } });
    const update = message('/start');

    expect((await app.inject({ method: 'POST', url: '/telegram/webhook', payload: update })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/telegram/webhook',
          headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
          payload: update,
        })
      ).statusCode,
    ).toBe(401);
    expect(tg.sent).toHaveLength(0);

    const ok = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'right-secret-token' },
      payload: update,
    });
    expect(ok.statusCode).toBe(200);
    expect(tg.sent).toHaveLength(1);
    await app.close();
  });
});
