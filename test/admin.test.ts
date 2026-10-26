import { eq } from 'drizzle-orm';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAdmin } from '../src/bot/admin.js';
import { registerBot } from '../src/bot/bot.js';
import { createFlows } from '../src/bot/flows.js';
import { events, orderItems, users } from '../src/db/schema.js';
import type { Alert } from '../src/services/notifier.js';
import { computeAvailability, ResellerClient } from '../src/services/reseller.js';
import { getOfferText, isPaused } from '../src/services/settings.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getItems, getOrder, insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';
import { startMockReseller, type MockReseller } from './mocks/reseller-server.js';

const logger = createLogger({ level: 'silent' });
const ADMIN = 1;
const BUYER = 42;
const botInfo = { id: 9, is_bot: true, first_name: 'b', username: 'geminiprosamkiel_bot' } as UserFromGetMe;

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tg: FakePort;
let mock: MockReseller;
let alerts: Alert[];
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
  alerts = [];
  mock = await startMockReseller({ apiKey: 'k', balanceCents: 1_000, priceCents: 120, stock: 20 });
});
afterEach(async () => {
  await mock.close();
});

function makeBot(): Bot {
  const reseller = new ResellerClient({ baseUrl: mock.url, apiKey: 'k', productId: 1, maxQtyPerOrder: 10, timeoutMs: 2_000, backoffMs: 1 });
  const flows = createFlows({
    db: testDb.db,
    port: tg.port,
    logger,
    reseller: {
      getAvailability: async (r) =>
        computeAvailability({ balanceCents: 100_000, priceCents: 120, stock: 50, inStock: true, reservedUnits: r, maxQtyPerOrder: 10 }),
    },
    payments: { createCheckout: async (i) => ({ checkoutId: `chk_${i.orderId.slice(0, 8)}`, checkoutUrl: 'https://pay.test', expiresAt: undefined }) },
    pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
    facts,
    salesCutoff: undefined,
    returnUrl: undefined,
    notify: (a) => alerts.push(a),
    statusThrottleMs: 0,
  });
  const bot = new Bot('123:test', { botInfo });
  bot.api.config.use(async () => ({ ok: true, result: true }) as never);
  registerBot(bot, {
    db: testDb.db,
    logger,
    port: tg.port,
    flows,
    facts,
    pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
    brain: { decide: async () => ({ ok: false, failure: 'rate_limited' }) },
    proof: { send: async () => 'sent' },
    saveLead: async () => 'saved',
    registerAdmin: (b) =>
      registerAdmin(b, {
        db: testDb.db,
        port: tg.port,
        logger,
        facts,
        adminIds: [ADMIN],
        reseller,
        productId: 1,
        flows,
        notify: (a) => alerts.push(a),
      }),
  });
  return bot;
}

function command(text: string, from: number): Update {
  const name = text.split(' ')[0] ?? '';
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: from, type: 'private', first_name: 'x' },
      from: { id: from, is_bot: false, first_name: 'x', username: from === ADMIN ? 'samkiel' : 'buyer' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: name.length }],
    },
  } as Update;
}

async function deliveredOrder() {
  const id = await insertOrder(testDb.db, { status: 'delivered', telegramId: BUYER, quantity: 1 });
  await testDb.db.insert(orderItems).values({
    orderId: id,
    idx: 0,
    idempotencyKey: `${id}-0`,
    status: 'completed',
    activationLink: 'https://one.google.com/activate/original',
    deliveredAt: new Date(),
  });
  return getOrder(testDb.db, id);
}

const lastTextTo = (chatId: number) => tg.textsTo(chatId).at(-1) ?? '';
const BUYER_LAST = () => tg.sent.filter((m) => m.chatId === BUYER).at(-1)?.id;

describe('admin commands', () => {
  it('do not exist for anyone who is not an admin', async () => {
    const bot = makeBot();
    for (const cmd of ['/admin', '/balance', '/stats', '/allorders', '/order GP-1001', '/pause', '/offertext x', '/leads', '/replace GP-1001']) {
      await bot.handleUpdate(command(cmd, BUYER));
    }
    expect(new Set(tg.textsTo(BUYER))).toEqual(new Set(["i don't know that command. try /buy, /history or /help."]));
    expect(await isPaused(testDb.db)).toBe(false);
    expect(await getOfferText(testDb.db)).toBe('offer ending very soon');
  });

  it('/balance shows the reseller balance and the links it covers', async () => {
    await makeBot().handleUpdate(command('/balance', ADMIN));
    expect(lastTextTo(ADMIN)).toContain('balance: $10.00 (covers 8 links at $1.20)');
    expect(lastTextTo(ADMIN)).toContain('stock: 20');
  });

  it('/pause stops buyers, /resume lets them buy again', async () => {
    const bot = makeBot();
    await bot.handleUpdate(command('/pause', ADMIN));
    expect(await isPaused(testDb.db)).toBe(true);
    await bot.handleUpdate(command('/buy', BUYER));
    expect(lastTextTo(BUYER)).toBe('sales are paused for a moment. please check back shortly.');
    await bot.handleUpdate(command('/resume', ADMIN));
    await bot.handleUpdate(command('/buy', BUYER));
    expect(tg.textsTo(BUYER).some((t) => t.startsWith('order summary'))).toBe(true);
  });

  it('/offertext shows and sets the offer line', async () => {
    const bot = makeBot();
    await bot.handleUpdate(command('/offertext', ADMIN));
    expect(lastTextTo(ADMIN)).toContain('offer line: "offer ending very soon"');
    await bot.handleUpdate(command('/offertext Last 30 links left', ADMIN));
    expect(await getOfferText(testDb.db)).toBe('last 30 links left');
  });

  it('/stats, /allorders and /order describe sales without ever showing a link', async () => {
    const order = await deliveredOrder();
    await testDb.db.update(users).set({ username: 'tunde' }).where(eq(users.telegramId, BUYER));
    const bot = makeBot();
    await bot.handleUpdate(command('/stats', ADMIN));
    expect(lastTextTo(ADMIN)).toMatch(/^today: 1 orders, 1 links, ₦3,500\ntotal: 1 orders, 1 links, ₦3,500/);
    await bot.handleUpdate(command('/allorders', ADMIN));
    expect(lastTextTo(ADMIN)).toContain(`${order.orderNo} · 1 · ₦3,500 · delivered · @tunde`);
    await bot.handleUpdate(command(`/order ${order.orderNo.toLowerCase()}`, ADMIN));
    expect(lastTextTo(ADMIN)).toContain(`${order.orderNo} · delivered\nbuyer: @tunde (42)`);
    expect(tg.textsTo(ADMIN).join('\n')).not.toContain('https://one.google.com');
    await bot.handleUpdate(command('/order GP-99999', ADMIN));
    expect(lastTextTo(ADMIN)).toBe('no order GP-99999.');
  });

  it('/resend sends the links to the buyer again', async () => {
    const order = await deliveredOrder();
    await makeBot().handleUpdate(command(`/resend ${order.orderNo}`, ADMIN));
    expect(tg.textsTo(BUYER).some((t) => t.includes('<code>https://one.google.com/activate/original</code>'))).toBe(true);
    expect(lastTextTo(ADMIN)).toBe(`sent 1 link of ${order.orderNo} to the buyer.`);
  });

  it('/replace buys one more link through the reseller, sends it and records it, once per command', async () => {
    const order = await deliveredOrder();
    const bot = makeBot();
    const update = command(`/replace ${order.orderNo}`, ADMIN);
    await bot.handleUpdate(update);
    await bot.handleUpdate(update); // Telegram redelivers the same update

    expect(mock.state.orders).toHaveLength(1);
    const items = await getItems(testDb.db, order.id);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ idx: 1, status: 'completed' });
    expect(items[1]?.deliveredAt).toBeInstanceOf(Date);
    expect(tg.textsTo(BUYER).at(-1)).toContain(`replacement for order ${order.orderNo} ✅`);
    expect(tg.textsTo(BUYER).at(-1)).toContain(`<code>${items[1]?.activationLink}</code>`);
    expect(tg.buttons(BUYER_LAST()).map((b) => b.text)).toContain('✅ replacement link activated');
    expect(lastTextTo(ADMIN)).toBe(`that replacement for ${order.orderNo} was already bought. use /resend ${order.orderNo} if the buyer did not get it.`);
    expect(await testDb.db.select().from(events).where(eq(events.kind, 'replacement'))).toHaveLength(1);
    expect(tg.textsTo(BUYER).filter((t) => t.startsWith('replacement for order'))).toHaveLength(1);
  });

  it('/resend never sends a link the buyer marked activated', async () => {
    const order = await deliveredOrder();
    await testDb.db.update(orderItems).set({ activatedAt: new Date() }).where(eq(orderItems.orderId, order.id));
    const bot = makeBot();
    await bot.handleUpdate(command(`/resend ${order.orderNo}`, ADMIN));
    expect(lastTextTo(ADMIN)).toBe(`every link of ${order.orderNo} is activated and closed. nothing to resend.`);
    expect(tg.textsTo(BUYER)).toEqual([]);
    await bot.handleUpdate(command('/stats', ADMIN));
    expect(lastTextTo(ADMIN)).toContain('activated: 1 of 1 delivered links (100%), 1 today');
    await bot.handleUpdate(command(`/order ${order.orderNo}`, ADMIN));
    expect(lastTextTo(ADMIN)).toMatch(/link 1: completed, delivered, activated \d+ \w+, \d\d:\d\d wat/);
  });

  it('/offertext refuses a date', async () => {
    const bot = makeBot();
    const before = await getOfferText(testDb.db);
    for (const text of ['ends 29 oct', 'until oct 29', 'till 29/10', 'last day 2026']) {
      await bot.handleUpdate(command(`/offertext ${text}`, ADMIN));
      expect(lastTextTo(ADMIN)).toContain('must not contain a date');
    }
    expect(await getOfferText(testDb.db)).toBe(before);
  });

  it('/admin opens a panel with every command; its views edit it in place', async () => {
    const bot = makeBot();
    await bot.handleUpdate(command('/admin', ADMIN));
    const panel = tg.sent.at(-1)?.id ?? 0;
    expect(tg.buttons(panel).map((b) => b.text)).toEqual([
      'balance',
      'stats',
      'all orders',
      'find an order',
      'leads',
      'offer text',
      'proof screenshots',
      'pause sales',
      'resume sales',
    ]);
    await bot.handleUpdate(tap('ad:p:balance', panel));
    expect(tg.get(panel)?.text).toContain('balance: $10.00');
    expect(tg.buttons(panel).map((b) => b.text)).toEqual(['‹ panel']);
  });

  it('the panel lists orders as buttons; replace from there needs a confirm', async () => {
    const order = await deliveredOrder();
    const bot = makeBot();
    await bot.handleUpdate(command('/admin', ADMIN));
    const panel = tg.sent.at(-1)?.id ?? 0;
    await bot.handleUpdate(tap('ad:p:orders', panel));
    expect(tg.buttons(panel)[0]).toEqual({ text: `${order.orderNo} · delivered`, data: `ad:o:${order.id}` });
    await bot.handleUpdate(tap(`ad:o:${order.id}`, panel));
    expect(tg.get(panel)?.text).toContain(`${order.orderNo} · delivered`);
    expect(tg.buttons(panel).map((b) => b.text)).toEqual(['resend to buyer', 'send me the links', 'replace a link', '‹ all orders', '‹ panel']);

    await bot.handleUpdate(tap(`ad:replace:${order.id}`, panel));
    expect(mock.state.orders).toHaveLength(0); // nothing bought yet
    const confirm = tg.buttons(panel)[0];
    expect(confirm?.text).toBe(`yes, buy and send 1 replacement for ${order.orderNo}`);
    const data = confirm && 'data' in confirm ? confirm.data : '';
    await bot.handleUpdate(tap(data, panel));
    await bot.handleUpdate(tap(data, panel)); // double tap
    expect(mock.state.orders).toHaveLength(1);
    expect(tg.textsTo(BUYER).filter((t) => t.startsWith('replacement for order'))).toHaveLength(1);
  });

  it('find an order and change offer text ask for a reply, and act on it', async () => {
    const order = await deliveredOrder();
    const bot = makeBot();
    await bot.handleUpdate(tap('ad:ask:order', 1));
    const ask = tg.sent.at(-1);
    expect(ask?.forceReply).toBe('GP-1042');
    await bot.handleUpdate(replyTo(ask?.id ?? 0, ask?.text ?? '', order.orderNo));
    expect(lastTextTo(ADMIN)).toContain(`${order.orderNo} · delivered`);

    await bot.handleUpdate(tap('ad:ask:offer', 1));
    const askOffer = tg.sent.at(-1);
    await bot.handleUpdate(replyTo(askOffer?.id ?? 0, askOffer?.text ?? '', 'Last 12 links left'));
    expect(await getOfferText(testDb.db)).toBe('last 12 links left');

    // a buyer replying to anything never reaches these
    await bot.handleUpdate(replyTo(askOffer?.id ?? 0, askOffer?.text ?? '', 'hello', BUYER));
    expect(await getOfferText(testDb.db)).toBe('last 12 links left');
  });
});

function tap(data: string, messageId: number, from = ADMIN): Update {
  return {
    update_id: updateId++,
    callback_query: {
      id: `q${updateId}`,
      from: { id: from, is_bot: false, first_name: 'x' },
      chat_instance: 'c',
      data,
      message: { message_id: messageId, date: 0, chat: { id: from, type: 'private', first_name: 'x' } },
    },
  } as Update;
}

function replyTo(messageId: number, askedText: string, text: string, from = ADMIN): Update {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: from, type: 'private', first_name: 'x' },
      from: { id: from, is_bot: false, first_name: 'x' },
      text,
      reply_to_message: {
        message_id: messageId,
        date: 0,
        chat: { id: from, type: 'private', first_name: 'x' },
        from: { id: botInfo.id, is_bot: true, first_name: 'b' },
        text: askedText,
      },
    },
  } as Update;
}
