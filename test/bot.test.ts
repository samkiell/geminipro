import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import Groq from 'groq-sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBrain } from '../src/agent/brain.js';
import { groqTransport, ModelPool } from '../src/agent/llm.js';
import { registerBot, type BotDeps } from '../src/bot/bot.js';
import { BUYER_COMMANDS } from '../src/bot/commands.js';
import { createFlows, type Flows } from '../src/bot/flows.js';
import { messages, users } from '../src/db/schema.js';
import { buildServer } from '../src/server.js';
import type { Alert } from '../src/services/notifier.js';
import { ensureRefCode } from '../src/services/referrals.js';
import { computeAvailability } from '../src/services/reseller.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getOrder, insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';
import { decisionJson, startMockGroq, type MockGroq } from './mocks/groq-server.js';

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
let groq: MockGroq;
/** Telegram API methods and model calls, in the order they happened. */
let events: string[];
let leads: string[];
let proofSends: number[];
/** Whether each proof send had the "yes, the offer is real" intro. */
let proofIntros: boolean[];
let alerts: Alert[];
let fallbacks: string[];
let updateId = 1;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
afterEach(async () => {
  await groq.close();
});
beforeEach(async () => {
  await testDb.reset();
  tg = fakePort();
  events = [];
  leads = [];
  proofSends = [];
  proofIntros = [];
  alerts = [];
  fallbacks = [];
  groq = await startMockGroq(() => events.push('model'));
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

const pricing = { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 };

function makeBot(overrides: Partial<BotDeps> = {}, brainOptions: { perUserPerMinute?: number } = {}): Bot {
  const bot = new Bot('123:test', { botInfo });
  bot.api.config.use(async (_prev, method) => {
    events.push(method);
    return { ok: true, result: true } as never;
  });
  const pool = new ModelPool(groqTransport(new Groq({ apiKey: 'k', baseURL: groq.url, maxRetries: 0 })), ['fast', 'smart'], { logger });
  registerBot(bot, {
    db: testDb.db,
    logger,
    port: tg.port,
    flows,
    facts,
    pricing,
    brain: createBrain({
      db: testDb.db,
      pool,
      facts: { unitPriceNgn: 3500, grossUp: false, supportLocal: facts.supportLocal, maxQtyPerOrder: 10 },
      availability: async () => ({ canSell: true, maxQuantity: 10 }),
      ...brainOptions,
    }),
    proof: {
      send: async (telegramId, options) => {
        proofSends.push(telegramId);
        proofIntros.push(options?.intro ?? true);
        return 'sent';
      },
    },
    usage: { free: () => {}, fallback: (reason) => fallbacks.push(reason) },
    notify: (alert) => alerts.push(alert),
    saveLead: async (_id, _username, summary) => {
      leads.push(summary);
      return 'saved';
    },
    ...overrides,
  });
  return bot;
}

const modelCalls = () => groq.requests.length;
/** The model answers every message with this decision. */
const decides = (decision: Record<string, unknown>) => groq.respond(() => ({ content: decisionJson(decision) }));

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
    expect(tg.sent[0]?.text).toContain('hey 👋 get google ai pro for 18 months, delivered right here after payment.');
    expect(tg.buttons(tg.sent[0]?.id).map((b) => b.text)).toEqual(['buy a link', 'see proof', 'how it works']);
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, BUYER));
    expect(user).toMatchObject({ username: 'samkieldev', firstName: 'Sam', blocked: false });
  });

  it('/start ref_<CODE> attributes a brand new user, case insensitively', async () => {
    const code = await ensureRefCode(testDb.db, 7);
    await makeBot().handleUpdate(message(`/start ref_${code.toUpperCase()}`));
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, BUYER));
    expect(user?.referredBy).toBe(7);
    expect(tg.sent[0]?.text).toContain('hey 👋');
  });

  it('/start ref_<code> from someone who already used the bot is ignored', async () => {
    const code = await ensureRefCode(testDb.db, 7);
    const bot = makeBot();
    await bot.handleUpdate(message('/start'));
    await bot.handleUpdate(message(`/start ref_${code}`));
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, BUYER));
    expect(user?.referredBy).toBeNull();
  });

  it('/buy 3 shows the draft card for 3', async () => {
    await makeBot().handleUpdate(message('/buy 3'));
    expect(tg.sent[0]?.text).toContain('how many links?');
    expect(tg.buttons(tg.sent[0]?.id).map((b) => b.text)).toEqual(['−', '3', '+', 'continue · ₦10,500 + fee', 'cancel']);
    expect(tg.sent).toHaveLength(1);
  });

  it('/myid answers anyone with their own telegram id', async () => {
    await makeBot().handleUpdate(message('/myid', { user: 555 }));
    expect(tg.textsTo(555)).toEqual(['your telegram id: 555']);
  });

  it('the buyer command menu is start, buy, history, invite, help', () => {
    expect(BUYER_COMMANDS.map((c) => c.command)).toEqual(['start', 'buy', 'history', 'invite', 'help']);
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
      "i don't know that command. try /buy, /history, /invite or /help.",
      "i don't know that command. try /buy, /history, /invite or /help.",
    ]);
  });
});

describe('chat: one model call at most, often none', () => {
  it('free text costs one call, with typing shown first, and the turn is saved', async () => {
    decides({ intent: 'chat', reply: 'not much, just selling gemini pro links' });
    await makeBot().handleUpdate(message("what's up with you today"));
    expect(modelCalls()).toBe(1);
    expect(events.indexOf('sendChatAction')).toBeLessThan(events.indexOf('model'));
    const saved = await testDb.db.select().from(messages).where(eq(messages.telegramId, BUYER));
    expect(saved.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:what's up with you today",
      'assistant:not much, just selling gemini pro links',
    ]);
  });

  it('acceptance: "i need 3, how much" costs exactly 1 call and shows the price for 3', async () => {
    decides({ intent: 'price', quantity: 3, reply: 'here you go' });
    await makeBot().handleUpdate(message('i need 3, how much'));
    expect(modelCalls()).toBe(1);
    expect(tg.textsTo(BUYER)).toContain('3 links come to ₦10,500 + fee. they land here about a minute after you pay.');
    expect(tg.buttons(tg.sent.at(-1)?.id).map((b) => b.text)).toEqual(['buy 3', 'see proof']);
  });

  it('acceptance: buying through buttons, "is this real" and /history cost 0 calls', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('/buy'));
    const cardId = tg.sent[0]?.id ?? 0;
    const plus = tg.buttons(cardId).find((b) => b.text === '+');
    await bot.handleUpdate(tap(plus && 'data' in plus ? plus.data : '', cardId));
    await bot.handleUpdate(message('is this real?'));
    await bot.handleUpdate(message('/history'));
    await bot.handleUpdate(message('how much'));
    await bot.handleUpdate(message('hello'));
    expect(modelCalls()).toBe(0);
    expect(proofSends).toEqual([BUYER]);
    expect(proofIntros).toEqual([true]); // a doubt question gets the honest intro
    expect(tg.textsTo(BUYER)).toContain('one link is ₦3,500 + fee. it lands here about a minute after you pay.');

    // [see proof] and a plain "see proof": the screenshots only, no intro.
    await bot.handleUpdate(tap('pf', cardId));
    await bot.handleUpdate(message('see proof'));
    await bot.handleUpdate(message('Proof?'));
    expect(proofIntros).toEqual([true, false, false, false]);
    expect(modelCalls()).toBe(0);
  });

  it('every intent is carried out by code', async () => {
    const theirs = await insertOrder(testDb.db, { status: 'delivered', telegramId: 99 });
    const mine = await insertOrder(testDb.db, { status: 'delivered', telegramId: BUYER });
    const bot = makeBot({ rateLimit: { max: 100, windowMs: 60_000 } }, { perUserPerMinute: 100 });
    let n = 0;
    // A different message each time, so the cache never answers for the model.
    const say = async (decision: Record<string, unknown>, text = `some message for the model number ${n++}`) => {
      decides(decision);
      const before = tg.sent.length;
      await bot.handleUpdate(message(text, { user: BUYER }));
      const produced = tg.sent.slice(before);
      expect(produced.length).toBeLessThanOrEqual(2);
      return produced;
    };

    // buy: clamped to the most per order
    const buy = await say({ intent: 'buy', quantity: 50, reply: '' });
    expect(buy.find((m) => m.text.startsWith('how many links?'))?.text).toContain('how many links?');
    // history
    const history = (await say({ intent: 'history', reply: '' })).at(-1)?.keyboard?.flat() ?? [];
    expect(history.some((b) => /^GP-\d+ · 1 link · .* · delivered ✅$/.test(b.text))).toBe(true);
    // show_order: theirs is never shown, mine is
    const other = await say({ intent: 'show_order', order_no: (await getOrder(testDb.db, theirs)).orderNo, reply: '' });
    expect(other.at(-1)?.text).toMatch(/^i couldn't find order GP-\d+ on your account/);
    const own = await say({ intent: 'show_order', order_no: (await getOrder(testDb.db, mine)).orderNo, reply: '' });
    expect(own.at(-1)?.text).toContain(`order ${(await getOrder(testDb.db, mine)).orderNo}`);
    // proof: the fixed album, not the model's words
    await say({ intent: 'proof', reply: 'trust me bro' });
    expect(proofSends).toEqual([BUYER]);
    expect(tg.textsTo(BUYER)).not.toContain('trust me bro');
    // help
    expect((await say({ intent: 'help', reply: '' })).at(-1)?.text).toBe('how can i help? tap a topic below.');
    // owner and shop: canned text with link buttons
    const owner = await say({ intent: 'owner', topic: 'projects', reply: 'he made many things' });
    expect(owner.at(-1)?.keyboard?.flat().map((b) => b.text)).toEqual(['portfolio', 'github', 'blog']);
    expect((await say({ intent: 'shop', reply: '' })).at(-1)?.text.length).toBeGreaterThan(20);
    // support: whatsapp button and an alert
    const support = await say({ intent: 'support', reply: '' }, 'my link is not working at all');
    expect(support.at(-1)?.keyboard?.flat()[0]).toMatchObject({ text: 'need help on whatsapp' });
    expect(alerts.map((a) => a.title)).toContain('buyer needs support');
    // lead: saved from the summary
    await say({ intent: 'lead', summary: 'restaurant website', reply: 'nice, i passed it to samkiel' });
    expect(leads).toEqual(['restaurant website']);
  });

  it('a chat reply about buying, prices or support gets [buy] [price] [proof] [support]', async () => {
    const bot = makeBot();
    decides({ intent: 'chat', reply: 'you can buy whenever you are ready' });
    await bot.handleUpdate(message('ok cool i will think about it'));
    expect(tg.buttons(tg.sent.at(-1)?.id).map((b) => b.text)).toEqual(['buy a link', 'price', 'see proof', 'support']);
    decides({ intent: 'chat', reply: 'haha same here' });
    await bot.handleUpdate(message('i love jollof rice so much'));
    expect(tg.sent.at(-1)?.keyboard).toBeUndefined();
  });

  it('invalid JSON or no free model: a scripted reply that still acts, with the fallback buttons', async () => {
    const bot = makeBot();
    groq.respond(() => ({ content: 'not json at all' }));
    await bot.handleUpdate(message('can i get two of them please'));
    expect(tg.sent[0]?.text).toContain('how many links?');
    expect(tg.buttons(tg.sent[0]?.id).map((b) => b.text)).toEqual(['−', '2', '+', 'continue · ₦7,000 + fee', 'cancel']);
    groq.respond(() => ({ status: 429, headers: { 'retry-after': '60' } }));
    await bot.handleUpdate(message('blah blah something random'));
    expect(tg.buttons(tg.sent.at(-1)?.id).map((b) => b.text)).toEqual(['buy a link', 'price', 'see proof', 'support']);
    // both models rest now: the next message makes no call at all, and still gets its answer
    const calls = modelCalls();
    await bot.handleUpdate(message('i never got my link from you'));
    expect(modelCalls()).toBe(calls);
    expect(tg.sent.at(-1)?.text).toBe("you haven't bought anything yet. tap below to get your first link.");
    expect(fallbacks).toEqual(['invalid', 'rate_limited', 'rate_limited']);
  });

  it('the same general question from two buyers costs one call (5 minute cache)', async () => {
    decides({ intent: 'help', reply: '' });
    const bot = makeBot();
    await bot.handleUpdate(message('how does activation work for me'));
    await bot.handleUpdate(message('How does activation work for me?', { user: 7 }));
    expect(modelCalls()).toBe(1);
    expect(tg.textsTo(7)).toEqual(['how can i help? tap a topic below.']);
  });

  it('a buyer gets at most 6 model messages a minute; more get scripted replies', async () => {
    decides({ intent: 'chat', reply: 'sure thing' });
    const bot = makeBot({ rateLimit: { max: 100, windowMs: 60_000 } });
    for (let i = 0; i < 8; i++) await bot.handleUpdate(message(`tell me something nice number ${i}`));
    expect(modelCalls()).toBe(6);
    expect(fallbacks).toEqual(['limited', 'limited']);
  });

  it('rate limits a user, warning once', async () => {
    const bot = makeBot({ rateLimit: { max: 2, windowMs: 60_000 } });
    for (const text of ['one more message', 'two more messages', 'three more', 'four more']) await bot.handleUpdate(message(text));
    expect(modelCalls()).toBe(2);
    expect(tg.textsTo(BUYER).filter((t) => t.startsWith("you're sending a lot"))).toHaveLength(1);
  });

  it('never rate limits an admin', async () => {
    const bot = makeBot({ rateLimit: { max: 2, windowMs: 60_000 }, adminIds: [BUYER] });
    for (const text of ['one more message', 'two more messages', 'three more', 'four more']) await bot.handleUpdate(message(text));
    expect(modelCalls()).toBe(4);
    expect(tg.textsTo(BUYER).some((t) => t.startsWith("you're sending a lot"))).toBe(false);
  });

  it('ignores group chats', async () => {
    await makeBot().handleUpdate(message('hello', { chatType: 'group' }));
    expect(tg.sent).toHaveLength(0);
    expect(modelCalls()).toBe(0);
  });
});

describe('button taps', () => {
  it('the stepper edits the card in place; a tap on an old card says it expired', async () => {
    const bot = makeBot();
    await bot.handleUpdate(message('/buy'));
    const cardId = tg.sent[0]?.id ?? 0;
    const plus = tg.buttons(cardId).find((b) => b.text === '+');
    await bot.handleUpdate(tap(plus && 'data' in plus ? plus.data : '', cardId));
    expect(tg.get(cardId)?.text).toContain('how many links?');
    expect(tg.buttons(cardId).map((b) => b.text)).toEqual(['−', '2', '+', 'continue · ₦7,000 + fee', 'cancel']);
    expect(tg.sent).toHaveLength(1);

    // Cancel draft to test expired button tap
    const cancel = tg.buttons(cardId).find((b) => b.text === 'cancel');
    await bot.handleUpdate(tap(cancel && 'data' in cancel ? cancel.data : '', cardId));
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
    expect(tg.get(cardId)?.text).toBe('cancelled');
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
