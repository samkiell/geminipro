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
    agent: { available: () => false, reply: async () => ({ text: '', failed: true, toolCalls: [] }) },
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
    expect(lastTextTo(ADMIN)).toBe(`replacement for ${order.orderNo} bought and sent to the buyer.`);
    expect(await testDb.db.select().from(events).where(eq(events.kind, 'replacement'))).toHaveLength(2);
  });

  it('/admin opens a panel whose buttons edit it in place', async () => {
    const bot = makeBot();
    await bot.handleUpdate(command('/admin', ADMIN));
    const panel = tg.sent.at(-1)?.id ?? 0;
    expect(tg.buttons(panel).map((b) => b.text)).toEqual(['balance', 'stats', 'all orders', 'leads', 'pause sales', 'resume sales', 'offer text']);
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: 'q1',
        from: { id: ADMIN, is_bot: false, first_name: 'x' },
        chat_instance: 'c',
        data: 'ad:p:balance',
        message: { message_id: panel, date: 0, chat: { id: ADMIN, type: 'private', first_name: 'x' } },
      },
    } as Update);
    expect(tg.get(panel)?.text).toContain('balance: $10.00');
    expect(tg.buttons(panel).map((b) => b.text)).toEqual(['‹ panel']);
  });
});
