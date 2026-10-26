import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orderItems, orders, users } from '../src/db/schema.js';
import { DeliveryError, type SendMessage } from '../src/services/delivery.js';
import { fulfil, itemIdempotencyKey, type FulfilmentDeps } from '../src/services/fulfilment.js';
import type { Alert } from '../src/services/notifier.js';
import { ResellerClient } from '../src/services/reseller.js';
import { isPaused } from '../src/services/settings.js';
import { createLogger, type Logger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getItems, getOrder, insertOrder } from './helpers/orders.js';
import { startMockReseller, type MockReseller } from './mocks/reseller-server.js';

const API_KEY = 'mock-key';
const LINK = /https:\/\/mock-reseller\.local\/activate\/[0-9a-f]+/g;

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let mock: MockReseller;
let sent: { chatId: number; text: string }[];
let alerts: Alert[];
let sendImpl: SendMessage;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  mock = await startMockReseller({ apiKey: API_KEY });
  sent = [];
  alerts = [];
  sendImpl = async (chatId, text) => {
    sent.push({ chatId, text });
  };
});
afterEach(async () => {
  await mock.close();
});

function deps(overrides: { apiKey?: string; logger?: Logger } = {}): FulfilmentDeps {
  const logger = overrides.logger ?? createLogger({ level: 'silent' });
  return {
    db: testDb.db,
    reseller: new ResellerClient({
      baseUrl: mock.url,
      apiKey: overrides.apiKey ?? API_KEY,
      productId: 1,
      maxQtyPerOrder: 10,
      logger,
      timeoutMs: 1_000,
      backoffMs: 1,
      pollIntervalMs: 5,
      pendingTimeoutMs: 500,
    }),
    productId: 1,
    send: (chatId, text) => sendImpl(chatId, text),
    notify: (alert) => alerts.push(alert),
    logger,
    supportWhatsapp: '08087357158',
    itemRetryDelaysMs: [1, 1],
  };
}

const postsFor = (key: string) => mock.orderRequests().filter((r) => r.idempotencyKey === key).length;

describe('fulfil', () => {
  it('1 link end to end: a paid order becomes delivered with one link', async () => {
    const id = await insertOrder(testDb.db, { quantity: 1 });
    expect(await fulfil(deps(), id)).toBe('delivered');

    const order = await getOrder(testDb.db, id);
    expect(order.status).toBe('delivered');
    expect(order.deliveredAt).toBeInstanceOf(Date);
    expect(order.fulfilLeaseUntil).toBeNull();

    const [item] = await getItems(testDb.db, id);
    expect(item).toMatchObject({ status: 'completed', idempotencyKey: `${id}-0`, attempts: 1 });
    expect(item?.deliveredAt).toBeInstanceOf(Date);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(42);
    expect(sent[0]?.text.match(LINK)).toEqual([item?.activationLink]);
    expect(sent[0]?.text).toContain('payment confirmed.');
    expect(sent[0]?.text).toContain('whatsapp 08087357158');
    expect(mock.state.orders).toHaveLength(1);
  });

  it('3 links where item 2 fails: 1 and 3 delivered, order partial, alert, retry completes it without rebuying', async () => {
    const id = await insertOrder(testDb.db, { quantity: 3 });
    mock.failNthItem(2);

    expect(await fulfil(deps(), id)).toBe('partial');
    expect((await getOrder(testDb.db, id)).status).toBe('partial');
    let items = await getItems(testDb.db, id);
    expect(items.map((i) => i.status)).toEqual(['completed', 'failed', 'completed']);
    expect(items[1]?.error).toBe('supplier_purchase_failed');
    expect(alerts.map((a) => a.title)).toEqual(['partial order']);

    expect(sent).toHaveLength(1);
    const firstText = sent[0]?.text ?? '';
    expect(firstText.match(LINK)).toEqual([items[0]?.activationLink, items[2]?.activationLink]);
    expect(firstText).toContain(`1. ${items[0]?.activationLink}`);
    expect(firstText).toContain(`3. ${items[2]?.activationLink}`);
    expect(firstText).toContain('the other link is on the way');

    mock.clearFailures();
    expect(await fulfil(deps(), id)).toBe('delivered');
    items = await getItems(testDb.db, id);
    expect(items.every((i) => i.status === 'completed' && i.deliveredAt)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain('here is the rest of your order:');
    expect(sent[1]?.text.match(LINK)).toEqual([items[1]?.activationLink]);

    expect(mock.state.orders).toHaveLength(3);
    expect(postsFor(itemIdempotencyKey(id, 0))).toBe(1);
    expect(postsFor(itemIdempotencyKey(id, 2))).toBe(1);
  });

  it('running fulfil twice concurrently buys each item once', async () => {
    const id = await insertOrder(testDb.db, { quantity: 3 });
    const outcomes = await Promise.all([fulfil(deps(), id), fulfil(deps(), id)]);
    expect(outcomes.sort()).toEqual(['delivered', 'not_claimed']);
    expect(mock.state.orders).toHaveLength(3);
    for (let idx = 0; idx < 3; idx++) expect(postsFor(itemIdempotencyKey(id, idx))).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('crash simulation: an expired lease lets a second run finish without duplicate purchases', async () => {
    // A run bought link 1 at the reseller, then died before saving it, while holding the lease.
    const id = await insertOrder(testDb.db, {
      status: 'fulfilling',
      quantity: 2,
      paid: true,
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await testDb.db.insert(orderItems).values([
      { orderId: id, idx: 0, idempotencyKey: itemIdempotencyKey(id, 0) },
      { orderId: id, idx: 1, idempotencyKey: itemIdempotencyKey(id, 1) },
    ]);
    const boughtBeforeCrash = await deps().reseller.createOrder(1, itemIdempotencyKey(id, 0));
    expect(mock.state.orders).toHaveLength(1);

    // While the lease is live, nobody else may touch the order.
    expect(await fulfil(deps(), id)).toBe('not_claimed');

    await testDb.db
      .update(orders)
      .set({ fulfilLeaseUntil: sql`now() - interval '1 minute'` })
      .where(eq(orders.id, id));
    expect(await fulfil(deps(), id)).toBe('delivered');

    expect(mock.state.orders).toHaveLength(2);
    const items = await getItems(testDb.db, id);
    expect(items[0]?.activationLink).toBe(boughtBeforeCrash.value);
    expect(sent[0]?.text.match(LINK)).toHaveLength(2);
  });

  it('nothing bought: needs_attention, owner alerted, buyer told once, completes after a restock', async () => {
    const id = await insertOrder(testDb.db, { quantity: 2 });
    mock.set({ stock: 0 });

    expect(await fulfil(deps(), id)).toBe('needs_attention');
    expect((await getOrder(testDb.db, id)).error).toContain('out_of_stock');
    expect(alerts).toMatchObject([{ level: 'critical', title: 'paid order not fulfilled' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('taking a little longer than usual');
    expect(sent[0]?.text).not.toMatch(LINK);

    // A retry that still fails does not message the buyer again.
    expect(await fulfil(deps(), id)).toBe('needs_attention');
    expect(sent).toHaveLength(1);

    mock.set({ stock: 10 });
    expect(await fulfil(deps(), id)).toBe('delivered');
    expect(sent[1]?.text).toContain('here are your 2 links:');
  });

  it('a buyer who blocked the bot: needs_attention, alert, links kept for support', async () => {
    const id = await insertOrder(testDb.db, { quantity: 1 });
    sendImpl = async () => {
      throw new DeliveryError('blocked', 'telegram 403: Forbidden: bot was blocked by the user');
    };

    expect(await fulfil(deps(), id)).toBe('needs_attention');
    expect((await getOrder(testDb.db, id)).error).toContain('blocked');
    const [item] = await getItems(testDb.db, id);
    expect(item?.activationLink).toMatch(LINK);
    expect(item?.deliveredAt).toBeNull();
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, 42));
    expect(user?.blocked).toBe(true);
    expect(alerts.map((a) => a.title)).toEqual(['could not deliver links']);
  });

  it('a transient send failure hands the order back, and the retry delivers without rebuying', async () => {
    const id = await insertOrder(testDb.db, { quantity: 1 });
    sendImpl = async () => {
      throw new DeliveryError('failed', 'telegram send failed: HttpError');
    };
    expect(await fulfil(deps(), id)).toBe('delivery_failed');
    expect((await getOrder(testDb.db, id)).status).toBe('paid');

    sendImpl = async (chatId, text) => {
      sent.push({ chatId, text });
    };
    expect(await fulfil(deps(), id)).toBe('delivered');
    expect(mock.state.orders).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('never fulfils a payment held for review (paid_at is null)', async () => {
    const id = await insertOrder(testDb.db, { status: 'needs_attention', paid: false });
    expect(await fulfil(deps(), id)).toBe('not_claimed');
    expect(mock.orderRequests()).toHaveLength(0);
  });

  it('a rejected reseller API key pauses sales and alerts', async () => {
    const id = await insertOrder(testDb.db, { quantity: 3 });
    expect(await fulfil(deps({ apiKey: 'wrong' }), id)).toBe('needs_attention');
    expect(await isPaused(testDb.db)).toBe(true);
    expect(alerts.map((a) => a.title)).toContain('reseller api key rejected');
    // Stops at the first rejection instead of trying every link.
    expect(mock.orderRequests()).toHaveLength(1);
  });

  it('never writes an activation link to the logs', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', destination: { write: (line: string) => lines.push(line) } });
    const id = await insertOrder(testDb.db, { quantity: 2 });
    mock.failNthItem(2);
    await fulfil(deps({ logger }), id);
    mock.clearFailures();
    await fulfil(deps({ logger }), id);

    const output = lines.join('');
    expect(output).toContain(id);
    expect(output).toContain('link bought');
    expect(output).not.toMatch(LINK);
  });
});
